/**
 * The METER — a pay-per-call, OpenAI-compatible inference proxy.
 *
 * Why it exists: the artist's steward agent must pay for its own thinking, per
 * request, from its own 3.69% wallet, with no human top-up. This endpoint is the
 * thing it pays. One component, both sponsors:
 *
 *   Hedera — an x402-protected endpoint that settles on Hedera testnet, called by
 *            an autonomous agent. Their headline example ("pay-per-call AI
 *            inference API") verbatim.
 *   0G     — every response carries the upstream 0G router request id
 *            (x_0g_trace.request_id) and tee_verified, bound 1:1 to a payment
 *            transaction id. Request id + payment tx = the proof artifact.
 *
 * Order of operations is deliberate:
 *   budget check -> 402 -> verify -> INFER -> settle -> log -> respond
 * Settlement happens only after the inference succeeded, so a fan/steward is
 * never charged for a request that failed.
 */
import type { Config } from './config.ts';
import type { Gate, PaymentRequirementsView } from './gate/index.ts';
import type { SpendLog } from './spend-log.ts';
import { atomicToDecimal } from './config.ts';
import { header, log, parseJson, sendJson, type Ctx } from './http.ts';

export interface MeterDeps {
  cfg: Config;
  gate: Gate;
  spendLog: SpendLog;
  fetchImpl?: typeof fetch;
}

export const METER_PATH = '/meter/v1/chat/completions';
const MODELS_PATH = '/meter/v1/models';
const INFO_PATH = '/meter/info';

interface MeterInfo {
  priceAtomic: string;
  priceUsd: string;
  asset: string;
  network: string;
  payTo: string;
  budget: { totalUsd: number; hourlyUsd: number; maxPerCallUsd: number };
  upstream: { baseUrl: string; model: string; trustMode: string };
}

export function meterInfo(cfg: Config): MeterInfo {
  return {
    priceAtomic: cfg.prices.meterAtomic.toString(),
    priceUsd: atomicToDecimal(cfg.prices.meterAtomic, cfg.asset.decimals),
    asset: cfg.asset.id,
    network: cfg.network,
    payTo: cfg.accounts.compute || '0.0.0000',
    budget: cfg.budget,
    upstream: {
      baseUrl: cfg.upstream.baseUrl,
      model: cfg.upstream.model,
      trustMode: cfg.upstream.trustMode,
    },
  };
}

function requirementsFor(cfg: Config, resource: string, description: string): PaymentRequirementsView {
  return {
    scheme: 'exact',
    network: cfg.network,
    amount: cfg.prices.meterAtomic.toString(),
    asset: cfg.asset.id,
    payTo: cfg.accounts.compute || '0.0.0000',
    resource,
    description,
    maxTimeoutSeconds: 180,
  };
}

export async function handleMeter(ctx: Ctx, deps: MeterDeps): Promise<void> {
  const { cfg, gate, spendLog } = deps;
  const doFetch = deps.fetchImpl ?? fetch;

  if (ctx.url.pathname === INFO_PATH) {
    const totals = await spendLog.totals();
    sendJson(ctx.res, 200, { ...meterInfo(cfg), spent: totals });
    return;
  }

  const resource = `${ctx.url.origin}${METER_PATH}`;

  // ---------------------------------------------------------------- budget gate
  // Deliberately BEFORE the 402: never quote a payment we are not allowed to serve.
  const totals = await spendLog.totals();
  const priceUsd = Number(atomicToDecimal(cfg.prices.meterAtomic, cfg.asset.decimals));
  if (totals.totalUsd + priceUsd > cfg.budget.totalUsd) {
    sendJson(ctx.res, 403, {
      error: 'SPEND_CAP_EXCEEDED',
      code: 'SPEND_CAP_EXCEEDED',
      scope: 'total',
      spentUsd: totals.totalUsd,
      capUsd: cfg.budget.totalUsd,
      hint: 'steward is out of compute budget — degrade to a template reply',
    });
    return;
  }
  if (totals.lastHourUsd + priceUsd > cfg.budget.hourlyUsd) {
    sendJson(ctx.res, 403, {
      error: 'SPEND_CAP_EXCEEDED',
      code: 'SPEND_CAP_EXCEEDED',
      scope: 'hourly',
      spentLastHourUsd: totals.lastHourUsd,
      capUsd: cfg.budget.hourlyUsd,
    });
    return;
  }

  // ---------------------------------------------------------------- payment
  const requirements = requirementsFor(cfg, resource, `inference call (${cfg.upstream.model})`);
  const paymentHeader = header(ctx.req, 'x-payment');
  const verified = await gate.verify({ paymentHeader, requirements });
  if (!verified.ok) {
    const challenge = await gate.challenge({
      resource,
      amountAtomic: cfg.prices.meterAtomic,
      payTo: cfg.accounts.compute,
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

  // ---------------------------------------------------------------- infer
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  let upstream: { payload: Record<string, unknown>; requestId?: string; teeVerified?: boolean | null; costRaw?: string; model: string };
  try {
    upstream = await callUpstream(cfg, body, doFetch);
  } catch (err) {
    // no settlement on failure: the payer keeps their money
    log.error('upstream inference failed', { err: (err as Error).message });
    sendJson(ctx.res, 502, {
      error: 'UPSTREAM_FAILED',
      message: (err as Error).message,
      settled: false,
      hint: 'no payment was taken for this request',
    });
    return;
  }

  // ---------------------------------------------------------------- settle
  const settlement = await gate.settle({ handle: verified.handle, requirements });
  const txId = settlement.txId ?? `unsent-${Date.now().toString(36)}`;

  const entry = await spendLog.append({
    kind: 'meter',
    txId,
    priceAtomic: cfg.prices.meterAtomic.toString(),
    priceUsd: atomicToDecimal(cfg.prices.meterAtomic, cfg.asset.decimals),
    payer: settlement.payer ?? verified.payer,
    upstreamRequestId: upstream.requestId,
    teeVerified: upstream.teeVerified ?? null,
    model: upstream.model,
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
      ...upstream.payload,
      x_meter: {
        paidAtomic: cfg.prices.meterAtomic.toString(),
        paidUsd: atomicToDecimal(cfg.prices.meterAtomic, cfg.asset.decimals),
        paymentTxId: txId,
        network: cfg.network,
        payer: settlement.payer ?? verified.payer,
        hcsTxId: entry.hcsTxId ?? null,
        upstream: {
          provider: '0g',
          model: upstream.model,
          requestId: upstream.requestId ?? null,
          teeVerified: upstream.teeVerified ?? null,
          billingRaw: upstream.costRaw ?? null,
        },
      },
    },
    { 'x-payment-response': settleHeader },
  );
}

/**
 * Forward to the upstream (0G router in the demo). Captures the trace block that
 * makes the whole thing auditable; in dev without a key it synthesises a
 * plausible response so the loop is demoable offline.
 */
async function callUpstream(
  cfg: Config,
  body: Record<string, unknown>,
  doFetch: typeof fetch,
): Promise<{ payload: Record<string, unknown>; requestId?: string; teeVerified?: boolean | null; costRaw?: string; model: string }> {
  const model = typeof body.model === 'string' ? body.model : cfg.upstream.model;

  if (cfg.mode === 'dev' && !cfg.upstream.apiKey) {
    return devUpstream(model, body);
  }

  const upstreamBody = {
    ...body,
    model,
    verify_tee: true,
  };

  const res = await doFetch(`${cfg.upstream.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.upstream.apiKey ?? ''}`,
      'X-0G-Provider-Trust-Mode': cfg.upstream.trustMode,
    },
    body: JSON.stringify(upstreamBody),
    signal: AbortSignal.timeout(45_000),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`upstream ${res.status}: ${text.slice(0, 300)}`);
  }
  const payload = JSON.parse(text) as Record<string, unknown> & {
    x_0g_trace?: { request_id?: string; tee_verified?: boolean | null; billing?: { total_cost?: string } };
  };

  return {
    payload,
    requestId: res.headers.get('x-0g-request-id') ?? payload.x_0g_trace?.request_id,
    teeVerified: payload.x_0g_trace?.tee_verified ?? null,
    costRaw: payload.x_0g_trace?.billing?.total_cost,
    model,
  };
}

function devUpstream(
  model: string,
  body: Record<string, unknown>,
): { payload: Record<string, unknown>; requestId: string; teeVerified: boolean; costRaw: string; model: string } {
  const messages = Array.isArray(body.messages) ? (body.messages as { content?: string }[]) : [];
  const lastUser = [...messages].reverse().find((m) => typeof m.content === 'string')?.content ?? '';
  const snippet = lastUser.slice(0, 80).replace(/\s+/g, ' ');
  return {
    model,
    requestId: `dev-req-${Math.random().toString(36).slice(2, 12)}`,
    teeVerified: true,
    costRaw: '0.00004',
    payload: {
      id: `chatcmpl-dev-${Date.now().toString(36)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: `[dev-mock inference] heard: "${snippet}". Swapping in a real UPSTREAM_API_KEY gives a real 0G answer.`,
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 128, completion_tokens: 48, total_tokens: 176 },
      x_0g_trace: {
        request_id: `dev-req-${Date.now().toString(36)}`,
        provider: '0xdev',
        tee_verified: true,
        billing: { total_cost: '0.00004' },
      },
    },
  };
}

export { parseJson };
