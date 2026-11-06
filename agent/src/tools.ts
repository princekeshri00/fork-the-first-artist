/**
 * Tool registry — provider-neutral.
 *
 * The steward runs the tool loop, not the provider, so a model with native tool
 * calling and one without behave the same: declarations go out, JSON comes back,
 * the registry executes, the result returns as a message.
 *
 * v0 keeps this small on purpose. Everything here is read-only or arithmetic —
 * no tool can move money. Payments are made by the steward's own wallet, not by
 * a model decision (see rails/payer.ts), which removes a whole class of prompt
 * injection risk from the demo.
 */
import type { ArtistProfile, ToolDeclaration } from './types.ts';

export interface ToolContext {
  artist: ArtistProfile;
  paymentsUrl?: string;
  fetchImpl?: typeof fetch;
}

export type ToolHandler = (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

export interface ToolExecResult {
  ok: boolean;
  output: unknown;
  latencyMs: number;
}

const SPLIT_ARTIST_BPS = 9631n;
const SPLIT_AGENT_BPS = 369n;

export class ToolRegistry {
  private readonly handlers = new Map<string, { decl: ToolDeclaration; run: ToolHandler }>();

  register(decl: ToolDeclaration, run: ToolHandler): this {
    this.handlers.set(decl.name, { decl, run });
    return this;
  }

  names(): string[] {
    return [...this.handlers.keys()];
  }

  declarations(names?: string[]): ToolDeclaration[] {
    const wanted = names ? new Set(names) : null;
    return [...this.handlers.values()]
      .filter((h) => !wanted || wanted.has(h.decl.name))
      .map((h) => h.decl);
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  async execute(name: string, input: unknown, ctx: ToolContext): Promise<ToolExecResult> {
    const started = Date.now();
    const handler = this.handlers.get(name);
    if (!handler) {
      return { ok: false, output: { error: `unknown tool ${name}` }, latencyMs: 0 };
    }
    try {
      const output = await handler.run((input ?? {}) as Record<string, unknown>, ctx);
      return { ok: true, output, latencyMs: Date.now() - started };
    } catch (err) {
      return { ok: false, output: { error: (err as Error).message }, latencyMs: Date.now() - started };
    }
  }
}

export function defaultTools(): ToolRegistry {
  const reg = new ToolRegistry();

  reg.register(
    {
      name: 'get_artist_profile',
      description: "Read the artist's public profile: name, bio, ENS name, payout account.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async (_input, ctx) => ({
      name: ctx.artist.name,
      bio: ctx.artist.bio,
      ensName: ctx.artist.ensName,
      hederaAccount: ctx.artist.hederaAccount,
    }),
  );

  reg.register(
    {
      name: 'get_songs',
      description: "List the artist's songs exactly as published. Never invent titles.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async (_input, ctx) => ({ songs: ctx.artist.songs }),
  );

  reg.register(
    {
      name: 'quote_tip',
      description:
        'Compute how a tip splits between the artist and the agent compute share (96.31% / 3.69%).',
      inputSchema: {
        type: 'object',
        properties: {
          amount: { type: 'string', description: 'amount in the payment asset, e.g. "0.10"' },
          decimals: { type: 'number', description: 'asset decimals, default 6' },
        },
        required: ['amount'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const decimals = typeof input.decimals === 'number' ? input.decimals : 6;

      // prefer the live payments service so the number the fan sees is the one charged
      if (ctx.paymentsUrl) {
        try {
          const doFetch = ctx.fetchImpl ?? fetch;
          const res = await doFetch(
            `${ctx.paymentsUrl}/split-preview?amount=${encodeURIComponent(String(input.amount))}`,
            { signal: AbortSignal.timeout(5_000) },
          );
          if (res.ok) return (await res.json()) as unknown;
        } catch {
          // fall through to local arithmetic: a fan question must not fail on this
        }
      }

      const amount = typeof input.amount === 'string' ? input.amount : '0.10';
      const [whole, frac = ''] = amount.split('.');
      const atomic = BigInt(`${whole || '0'}${(frac + '0'.repeat(decimals)).slice(0, decimals)}`);
      const agent = (atomic * SPLIT_AGENT_BPS) / 10_000n;
      const artist = atomic - agent;
      return {
        amount,
        artistAtomic: artist.toString(),
        agentAtomic: agent.toString(),
        artistPct: 96.31,
        agentPct: 3.69,
        source: 'local',
      };
    },
  );

  return reg;
}
