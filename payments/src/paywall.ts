/**
 * The PAYWALL — a fan (or a fan's agent) pays the artist's steward per question.
 *
 *   402 -> verify -> steward answers -> settle -> respond
 *
 * Settlement is last on purpose. If the steward is down or the model fails, the
 * fan is not charged. Funds go to the ARTIST's account (the `payTo` comes from
 * the artist's own ENS record); the 3.69% agent share is recorded here and, on
 * mainnet-shaped deployments, enforced by an HTS custom fee — see
 * scripts/create-tip-token.ts.
 */
import type { Config } from './config.ts';
import type { Gate, PaymentRequirementsView } from './gate/index.ts';
import type { SpendLog } from './spend-log.ts';
import { atomicToDecimal } from './config.ts';
import { splitAtomic, describeSplit } from './split.ts';
import { header, log, sendJson, type Ctx } from './http.ts';

export interface PaywallDeps {
  cfg: Config;
  gate: Gate;
  spendLog: SpendLog;
  fetchImpl?: typeof fetch;
}

export interface StewardReply {
  ok: boolean;
  reply?: { text: string; data?: unknown };
  provider?: string;
  model?: string;
  usage?: { inputTokens: number; outputTokens: number };
  costUsd?: number;
  provenance?: { requestId?: string; teeVerified?: boolean | null; paymentTxId?: string; hcsTxId?: string };
  toolCalls?: unknown[];
  degradation?: string;
  error?: { code: string; message: string; retryable: boolean };
}

export const ASK_PATH = '/ask';

function requirementsFor(cfg: Config, resource: string, payTo: string): PaymentRequirementsView {
  return {
    scheme: 'exact',
    network: cfg.network,
    amount: cfg.prices.askAtomic.toString(),
    asset: cfg.asset.id,
    payTo,
    resource,
    description: 'ask the artist steward a question',
    maxTimeoutSeconds: 180,
  };
}

export async function handleAsk(ctx: Ctx, deps: PaywallDeps): Promise<void> {
  const { cfg, gate, spendLog } = deps;
  const doFetch = deps.fetchImpl ?? fetch;
  const resource = `${ctx.url.origin}${ASK_PATH}`;

  const body = (ctx.body ?? {}) as { instruction?: string; question?: string; artist?: string };
  const instruction = (body.instruction ?? body.question ?? ctx.url.searchParams.get('q') ?? '').trim();
  if (!instruction) {
    sendJson(ctx.res, 400, { error: 'MISSING_INSTRUCTION', message: 'send { "instruction": "..." }' });
    return;
  }

  const payTo = ctx.url.searchParams.get('payTo') ?? cfg.accounts.artist;
  if (!payTo) {
    sendJson(ctx.res, 500, { error: 'NO_PAYEE', message: 'HEDERA_ARTIST_ACCOUNT_ID not configured' });
    return;
  }

  const requirements = requirementsFor(cfg, resource, payTo);
  const paymentHeader = header(ctx.req, 'x-payment');
  const verified = await gate.verify({ paymentHeader, requirements });
  if (!verified.ok) {
    const challenge = await gate.challenge({
      resource,
      amountAtomic: cfg.prices.askAtomic,
      payTo,
      description: requirements.description,
    });
    sendJson(
      ctx.res,
      challenge.status,
      { ...challenge.body, error: verified.reason ?? challenge.body.error },
      challenge.headers,
    );
    return;
  }

  // ---------------------------------------------------------------- steward answers
  let stewarded: StewardReply;
  try {
    stewarded = await callSteward(cfg, instruction, { payer: verified.payer }, doFetch);
  } catch (err) {
    log.error('steward failed', { err: (err as Error).message });
    sendJson(ctx.res, 502, {
      error: 'STEWARD_UNAVAILABLE',
      message: (err as Error).message,
      settled: false,
      hint: 'no payment was taken for this request',
    });
    return;
  }

  if (!stewarded.ok) {
    // the steward refused (e.g. spend cap, no consent) — do not charge the fan
    sendJson(ctx.res, 422, {
      error: stewarded.error?.code ?? 'STEWARD_REFUSED',
      message: stewarded.error?.message ?? 'steward could not answer',
      settled: false,
    });
    return;
  }

  // A degraded (template) answer cost the agent nothing, so the fan is not
  // charged. Settling here would take 0.10 USDC for a canned card.
  if (stewarded.degradation === 'template-reply') {
    sendJson(ctx.res, 200, {
      ok: true,
      reply: stewarded.reply,
      provider: stewarded.provider,
      model: stewarded.model,
      degradation: stewarded.degradation,
      charged: false,
      settled: false,
      proof: null,
      note: 'the agent is at its compute budget; you were not charged',
    });
    return;
  }

  // ---------------------------------------------------------------- settle
  const settlement = await gate.settle({ handle: verified.handle, requirements });
  const txId = settlement.txId ?? `unsent-${Date.now().toString(36)}`;
  const split = splitAtomic(cfg.prices.askAtomic, cfg.split);

  const entry = await spendLog.append({
    kind: 'ask',
    txId,
    priceAtomic: cfg.prices.askAtomic.toString(),
    priceUsd: atomicToDecimal(cfg.prices.askAtomic, cfg.asset.decimals),
    payer: settlement.payer ?? verified.payer,
    upstreamRequestId: stewarded.provenance?.requestId,
    teeVerified: stewarded.provenance?.teeVerified ?? null,
    model: stewarded.model,
    artistAtomic: split.artist.toString(),
    agentAtomic: split.agent.toString(),
  });

  const settleHeader = Buffer.from(
    JSON.stringify({
      success: settlement.success,
      transaction: txId,
      network: settlement.network ?? cfg.network,
      payer: settlement.payer ?? verified.payer,
    }),
  ).toString('base64');

  sendJson(
    ctx.res,
    200,
    {
      ok: true,
      reply: stewarded.reply,
      provider: stewarded.provider,
      model: stewarded.model,
      usage: stewarded.usage,
      costUsd: stewarded.costUsd,
      degradation: stewarded.degradation,
      split: {
        totalAtomic: split.total.toString(),
        artistAtomic: split.artist.toString(),
        agentAtomic: split.agent.toString(),
        human: describeSplit(split, cfg.asset.decimals),
      },
      proof: {
        paymentTxId: txId,
        network: settlement.network ?? cfg.network,
        asset: cfg.asset.id,
        payer: settlement.payer ?? verified.payer,
        payTo,
        hcsTxId: entry.hcsTxId ?? null,
        upstream: {
          requestId: stewarded.provenance?.requestId ?? null,
          teeVerified: stewarded.provenance?.teeVerified ?? null,
          provider: stewarded.provider ?? null,
          model: stewarded.model ?? null,
        },
        hashScan: settlement.network === 'hedera:mainnet'
          ? `https://hashscan.io/mainnet/transaction/${txId}`
          : `https://hashscan.io/testnet/transaction/${txId}`,
      },
    },
    { 'x-payment-response': settleHeader },
  );
}

async function callSteward(
  cfg: Config,
  instruction: string,
  payment: { payer?: string },
  doFetch: typeof fetch,
): Promise<StewardReply> {
  const res = await doFetch(`${cfg.stewardUrl}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instruction, payment }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`steward returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok && res.status !== 422) {
    throw new Error(`steward ${res.status}: ${text.slice(0, 200)}`);
  }
  return parsed as StewardReply;
}
