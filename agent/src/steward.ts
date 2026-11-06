/**
 * The steward — the single entry point the rest of the app calls.
 *
 *   steward.run({ provider: '0g', instruction, context, tools, output, budget })
 *
 * Everything provider-specific is behind ModelProvider; everything money-specific
 * is behind Budget. This file is the only place that knows the order:
 *
 *   consent -> affordability -> provider -> tool loop -> schema -> record spend
 *
 * Affordability runs BEFORE the first network call. A request we cannot pay for
 * returns a template reply with `degradation: 'template-reply'`, which is how the
 * fan never sees a 500 and the agent never overspends.
 */
import type {
  AgentConfig,
  AgentInterface,
  AgentResult,
  AgentRunRequest,
  ArtistProfile,
  Degradation,
  ErrorCode,
  ModelProvider,
  NormalizedChatRequest,
  NormalizedMessage,
  Provenance,
  ProviderId,
  ToolCallRecord,
} from './types.ts';
import type { Budget } from './budget.ts';
import type { ToolRegistry } from './tools.ts';
import { fencedData, systemPrompt } from './fence.ts';
import type { ProviderRegistry } from './providers/registry.ts';

export interface StewardDeps {
  config: AgentConfig;
  budget: Budget;
  providers: ProviderRegistry;
  tools: ToolRegistry;
  artist: ArtistProfile;
  paymentsUrl?: string;
  now?: () => number;
}

export class Steward implements AgentInterface {
  private readonly deps: StewardDeps;

  constructor(deps: StewardDeps) {
    this.deps = deps;
  }

  describe(): ReturnType<AgentInterface['describe']> {
    const provider = this.deps.providers.get(this.deps.config.default);
    return {
      provider: provider.id,
      model: provider.model,
      transport: provider.transport,
      rail: this.deps.config.rail,
      tools: this.deps.tools.names(),
      capabilities: this.deps.config.providers[this.deps.config.default]?.capabilities ?? [],
    };
  }

  async run<T = unknown>(req: AgentRunRequest<T>): Promise<AgentResult<T>> {
    const started = Date.now();
    const cfg = this.deps.config;
    const instruction = (req.instruction ?? '').trim();
    if (!instruction) {
      return fail('BAD_REQUEST', 'instruction is required', false);
    }

    // ---------------------------------------------------------------- consent
    const artist: ArtistProfile = { ...this.deps.artist, ...(req.context?.artist ?? {}) };
    if (artist.consent === false) {
      return fail('NO_CONSENT', `${artist.name} has not consented to an agent`, false);
    }

    // ---------------------------------------------------------------- provider
    const providerId: ProviderId = req.provider ?? cfg.default;
    let provider: ModelProvider;
    try {
      provider = this.deps.providers.get(providerId);
    } catch (err) {
      return fail('PROVIDER_UNAVAILABLE', (err as Error).message, false);
    }
    const model = req.model ?? provider.model;

    const toolNames = req.tools?.length ? req.tools.filter((t) => this.deps.tools.has(t)) : [];
    if (req.tools?.length && toolNames.length === 0) {
      return fail('BAD_REQUEST', `none of the requested tools exist: ${req.tools.join(', ')}`, false);
    }
    if (toolNames.length && !provider.supports('tools')) {
      // not fatal: the adapter falls back to schema-in-prompt, but say it out loud
      if (!provider.supports('json')) {
        return fail(
          'UNSUPPORTED_CAPABILITY',
          `${providerId}/${model} supports neither tool calling nor JSON output`,
          false,
        );
      }
    }

    const messages = this.buildMessages(instruction, artist, req.context?.fan, toolNames.length > 0);

    // ---------------------------------------------------------------- affordability + degradation ladder
    const baseRequest: NormalizedChatRequest = {
      model,
      messages,
      tools: toolNames.length ? this.deps.tools.declarations(toolNames) : undefined,
      jsonSchema: req.output?.jsonSchema,
      temperature: cfg.generation.temperature,
      maxTokens: cfg.generation.maxTokens,
    };

    const ladder = this.ladder(baseRequest, req);
    const chosen = await this.pickAffordable(provider, ladder, req);
    if (!chosen) {
      return this.templateReply<T>(provider, model, artist, instruction, started);
    }
    const { request, degradation } = chosen;

    // ---------------------------------------------------------------- tool loop
    const toolCalls: ToolCallRecord[] = [];
    let current: NormalizedChatRequest = request;
    let response;
    let provenance: Provenance = {};
    let usage = { inputTokens: 0, outputTokens: 0 };

    try {
      for (let turn = 0; turn <= cfg.generation.maxToolTurns; turn++) {
        response = await provider.chat(current);
        usage = {
          inputTokens: usage.inputTokens + response.usage.inputTokens,
          outputTokens: usage.outputTokens + response.usage.outputTokens,
        };
        provenance = mergeProvenance(provenance, response.provenance);

        if (!response.toolCalls?.length) break;
        if (turn === cfg.generation.maxToolTurns) {
          return fail('PROVIDER_UNAVAILABLE', 'tool loop exceeded maxToolTurns', true);
        }

        current = {
          ...current,
          messages: [
            ...current.messages,
            { role: 'assistant', content: response.text, toolCalls: response.toolCalls },
            ...(await this.runTools(response.toolCalls, artist, toolCalls)),
          ],
        };
      }
    } catch (err) {
      const upstream = (err as { code?: string }).code;
      // The meter refusing on budget is the SAME condition as our own budget
      // check, just discovered one hop later: degrade, do not error.
      if (upstream === 'SPEND_CAP_EXCEEDED') {
        return this.templateReply<T>(provider, model, artist, instruction, started);
      }
      const code = upstream === 'PAYMENT_FAILED' ? 'PAYMENT_FAILED' : 'PROVIDER_UNAVAILABLE';
      return fail(code, (err as Error).message, upstream === 'PROVIDER_UNAVAILABLE');
    }

    if (!response) return fail('PROVIDER_UNAVAILABLE', 'no response from provider', true);

    // ---------------------------------------------------------------- schema
    let text = response.text.trim();
    let data: T | undefined;

    if (req.output) {
      const parsed = tryParse(text, req.output);
      if (parsed.ok) {
        data = parsed.value;
        if (typeof (data as { text?: unknown })?.text === 'string') {
          text = (data as { text: string }).text;
        }
      } else {
        // one repair turn, then give up honestly
        try {
          const repaired = await provider.chat({
            ...current,
            messages: [
              ...current.messages,
              { role: 'assistant', content: response.text },
              {
                role: 'user',
                content: `That was not valid JSON for the required schema (${parsed.error}). Reply with ONLY the JSON object.`,
              },
            ],
          });
          usage = {
            inputTokens: usage.inputTokens + repaired.usage.inputTokens,
            outputTokens: usage.outputTokens + repaired.usage.outputTokens,
          };
          provenance = mergeProvenance(provenance, repaired.provenance);
          const second = tryParse(repaired.text, req.output);
          if (!second.ok) {
            return fail('SCHEMA_MISMATCH', `model output failed schema after repair: ${second.error}`, true);
          }
          data = second.value;
          text = (data as { text?: string })?.text ?? repaired.text;
        } catch (err) {
          return fail('PROVIDER_UNAVAILABLE', (err as Error).message, true);
        }
      }
    }

    // ---------------------------------------------------------------- spend
    const costUsd = provider.costOf?.(usage) ?? provider.estimateCost(request);
    await this.deps.budget.record({ kind: 'inference', spentUsd: costUsd, note: `${providerId}/${model}` });

    return {
      ok: true,
      reply: { text, data },
      provider: providerId,
      model,
      usage,
      costUsd: round6(costUsd),
      provenance,
      toolCalls,
      degradation,
      latencyMs: Date.now() - started,
    };
  }

  // ------------------------------------------------------------------ helpers

  private buildMessages(
    instruction: string,
    artist: ArtistProfile,
    fan: { handle?: string; wallet?: string } | undefined,
    hasTools: boolean,
  ): NormalizedMessage[] {
    const data = fencedData('artist_profile', {
      name: artist.name,
      bio: artist.bio,
      songs: artist.songs,
      ensName: artist.ensName,
    });
    const fanBlock = fan ? fencedData('fan_context', fan) : '';
    return [
      {
        role: 'system',
        content: systemPrompt({ artistName: artist.name, profile: artist, hasTools }),
      },
      {
        role: 'user',
        content: `${data}\n${fanBlock}\n\nFAN QUESTION:\n${fencedData('instruction', instruction)}`,
      },
    ];
  }

  /** Cheaper tiers we are willing to fall back to before giving up. */
  private ladder(base: NormalizedChatRequest, req: AgentRunRequest): NormalizedChatRequest[] {
    const cheaperModel = this.cheaperModelOption(req);
    const tiers: NormalizedChatRequest[] = [base];
    tiers.push({ ...base, maxTokens: Math.max(64, Math.floor((base.maxTokens ?? 400) / 2)) });
    if (cheaperModel) tiers.push({ ...base, model: cheaperModel, maxTokens: base.maxTokens });
    return tiers;
  }

  private async pickAffordable(
    provider: ModelProvider,
    tiers: NormalizedChatRequest[],
    req: AgentRunRequest,
  ): Promise<{ request: NormalizedChatRequest; degradation?: Degradation } | null> {
    for (const request of tiers) {
      const estimate = provider.estimateCost(request);
      const verdict = await this.deps.budget.check(estimate, { maxUsd: req.budget?.maxUsd });
      if (verdict.ok) {
        const degradation =
          request.model !== provider.model
            ? ('cheaper-model' as const)
            : request.maxTokens !== this.deps.config.generation.maxTokens
              ? ('shorter-max-tokens' as const)
              : undefined;
        return { request, degradation };
      }
    }
    return null;
  }

  private cheaperModelOption(req: AgentRunRequest): string | undefined {
    const chain = this.deps.config.fallback.chain;
    if (!this.deps.config.fallback.enabled || chain.length === 0) return undefined;
    for (const entry of chain) {
      const [providerId, model] = entry.split(':');
      if (model && providerId && providerId !== (req.provider ?? this.deps.config.default)) {
        return model;
      }
    }
    return undefined;
  }

  private async runTools(
    calls: { id: string; name: string; input: unknown }[],
    artist: ArtistProfile,
    record: ToolCallRecord[],
  ): Promise<NormalizedMessage[]> {
    const out: NormalizedMessage[] = [];
    for (const call of calls) {
      const result = await this.deps.tools.execute(call.name, call.input, {
        artist,
        paymentsUrl: this.deps.paymentsUrl,
      });
      record.push({
        name: call.name,
        input: call.input,
        output: result.output,
        ok: result.ok,
        latencyMs: result.latencyMs,
      });
      out.push({
        role: 'tool',
        toolCallId: call.id,
        toolName: call.name,
        content: JSON.stringify(result.output).slice(0, 4000),
      });
    }
    return out;
  }

  /** No model call at all: the artist card, assembled from data. */
  private templateReply<T>(
    provider: ModelProvider,
    model: string,
    artist: ArtistProfile,
    instruction: string,
    started: number,
  ): AgentResult<T> {
    void instruction;
    const songs = artist.songs.slice(0, 3).join(', ');
    return {
      ok: true,
      reply: {
        text: `I'm ${artist.name}'s steward. ${artist.bio} ${songs ? `Songs: ${songs}.` : ''} I've reached today's compute budget, so this is a short answer — try again later.`,
      },
      provider: provider.id,
      model,
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      provenance: {},
      toolCalls: [],
      degradation: 'template-reply',
      latencyMs: Date.now() - started,
    };
  }
}

function mergeProvenance(a: Provenance, b: Provenance): Provenance {
  return {
    requestId: b.requestId ?? a.requestId,
    teeVerified: b.teeVerified ?? a.teeVerified,
    paymentTxId: b.paymentTxId ?? a.paymentTxId,
    hcsTxId: b.hcsTxId ?? a.hcsTxId,
  };
}

function tryParse<T>(text: string, schema: NonNullable<AgentRunRequest<T>['output']>):
  | { ok: true; value: T }
  | { ok: false; error: string } {
  const json = extractJson(text);
  if (json === undefined) return { ok: false, error: 'no JSON object found' };
  try {
    return { ok: true, value: schema.parse(json) };
  } catch (err) {
    return { ok: false, error: (err as Error).message.slice(0, 200) };
  }
}

/** Models wrap JSON in prose or fences; take the outermost object. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) return undefined;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

function fail(
  code: ErrorCode,
  message: string,
  retryable: boolean,
): { ok: false; error: { code: ErrorCode; message: string; retryable: boolean } } {
  return { ok: false, error: { code, message, retryable } };
}
