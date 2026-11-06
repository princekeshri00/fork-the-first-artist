/**
 * One adapter for every OpenAI-compatible wire format: 0G Router, OpenAI,
 * OpenRouter, and local servers (ollama/vLLM). 0G's extras — `verify_tee`,
 * the trust-mode header, and the `x_0g_trace` provenance block — are handled
 * here and nowhere else.
 *
 * Both transports go through this file:
 *   direct      POST {baseUrl}/chat/completions        (dev, no payment)
 *   x402-meter  POST {meterUrl}, paying per call       (demo, agent pays itself)
 */
import type {
  Capability,
  ModelProvider,
  NormalizedChatRequest,
  NormalizedChatResponse,
  NormalizedToolCall,
  Provenance,
  ProviderId,
  Transport,
} from '../types.ts';
import type { Payer } from '../rails/payer.ts';
import { readMeterProvenance } from '../rails/payer.ts';

export interface OpenAICompatibleOptions {
  id: ProviderId;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  extensions?: Record<string, unknown>;
  defaultModel: string;
  transport: Transport;
  meter?: { url: string; payer: Payer };
  capabilities: Capability[];
  priceUsdPerMTok: { input: number; output: number };
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface OpenAITrace {
  request_id?: string;
  tee_verified?: boolean | null;
  billing?: { total_cost?: string };
}

interface OpenAIChatBody {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  x_0g_trace?: OpenAITrace;
  x_meter?: {
    paymentTxId?: string;
    hcsTxId?: string | null;
    upstream?: { requestId?: string | null; teeVerified?: boolean | null };
  };
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: ProviderId;
  readonly model: string;
  readonly transport: Transport;
  private readonly opts: OpenAICompatibleOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAICompatibleOptions) {
    this.opts = opts;
    this.id = opts.id;
    this.model = opts.defaultModel;
    this.transport = opts.transport;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  supports(cap: Capability): boolean {
    return this.opts.capabilities.includes(cap);
  }

  /** Rough, pre-flight only: real cost comes back in `usage` after the call. */
  estimateCost(req: NormalizedChatRequest): number {
    const inputChars = req.messages.reduce((n, m) => n + m.content.length, 0);
    const inputTokens = Math.ceil(inputChars / 4) + 32;
    const outputTokens = req.maxTokens ?? 400;
    return (
      (inputTokens * this.opts.priceUsdPerMTok.input + outputTokens * this.opts.priceUsdPerMTok.output) /
      1_000_000
    );
  }

  /** Cost from the response itself, when the provider tells us. */
  costOf(usage: { inputTokens: number; outputTokens: number }): number {
    return (
      (usage.inputTokens * this.opts.priceUsdPerMTok.input +
        usage.outputTokens * this.opts.priceUsdPerMTok.output) /
      1_000_000
    );
  }

  async chat(req: NormalizedChatRequest): Promise<NormalizedChatResponse> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map((m) => {
        if (m.role === 'tool') {
          return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
        }
        if (m.role === 'assistant' && m.toolCalls?.length) {
          return {
            role: 'assistant',
            content: m.content || null,
            tool_calls: m.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) },
            })),
          };
        }
        return { role: m.role, content: m.content };
      }),
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      ...this.opts.extensions,
    };

    if (req.tools?.length && this.supports('tools')) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
      body.tool_choice = 'auto';
    } else if (req.tools?.length) {
      // model cannot call tools: tell it the schemas and let it ask in JSON
      body.messages = [
        ...(body.messages as { role: string; content: string }[]),
        {
          role: 'system',
          content: `You have these tools available as JSON: ${JSON.stringify(
            req.tools.map((t) => ({ name: t.name, description: t.description, input: t.inputSchema })),
          )}`,
        },
      ];
    }

    if (req.jsonSchema && this.supports('json')) {
      body.response_format = { type: 'json_object' };
      body.messages = [
        ...(body.messages as { role: string; content: string }[]),
        {
          role: 'system',
          content: `Reply with a single JSON object matching this JSON Schema, nothing else:\n${JSON.stringify(
            req.jsonSchema,
          )}`,
        },
      ];
    }

    const usingMeter = this.transport === 'x402-meter';
    const url = usingMeter ? this.opts.meter!.url : `${this.opts.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...this.opts.headers,
    };
    if (!usingMeter && this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;

    const doFetch = usingMeter ? this.opts.meter!.payer.fetch.bind(this.opts.meter!.payer) : this.fetchImpl;
    const res = await doFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
    });

    const text = await res.text();
    if (!res.ok) {
      // 0G returns 503 no_providers_available instead of silently swapping models.
      // Our meter returns 403 SPEND_CAP_EXCEEDED, which the steward turns into a
      // template reply — so the refusal code must survive the adapter.
      const upstreamCode = ((): string | undefined => {
        try {
          return (JSON.parse(text) as { code?: string }).code;
        } catch {
          return undefined;
        }
      })();
      const code =
        upstreamCode === 'SPEND_CAP_EXCEEDED'
          ? 'SPEND_CAP_EXCEEDED'
          : res.status === 402
            ? 'PAYMENT_FAILED'
            : 'PROVIDER_UNAVAILABLE';
      throw Object.assign(new Error(`${this.id} ${res.status}: ${text.slice(0, 300)}`), { code });
    }

    let parsed: OpenAIChatBody;
    try {
      parsed = JSON.parse(text) as OpenAIChatBody;
    } catch {
      throw new Error(`${this.id} returned non-JSON: ${text.slice(0, 200)}`);
    }

    const message = parsed.choices?.[0]?.message;
    const toolCalls: NormalizedToolCall[] = (message?.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      input: safeParseJson(tc.function.arguments),
    }));

    return {
      text: message?.content ?? '',
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage: {
        inputTokens: parsed.usage?.prompt_tokens ?? 0,
        outputTokens: parsed.usage?.completion_tokens ?? 0,
      },
      provenance: this.provenanceOf(parsed),
      raw: parsed,
    };
  }

  private provenanceOf(parsed: OpenAIChatBody): Provenance {
    if (this.transport === 'x402-meter') {
      return readMeterProvenance(parsed);
    }
    return {
      requestId: parsed.x_0g_trace?.request_id,
      teeVerified: parsed.x_0g_trace?.tee_verified ?? null,
    };
  }
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}
