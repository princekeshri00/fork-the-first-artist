/**
 * LIVE payment gate — real x402 on Hedera testnet, settled by a facilitator.
 *
 * We talk to the facilitator's documented HTTP API directly (`/supported`,
 * `/verify`, `/settle`) instead of pulling in the resource-server middleware:
 * the facilitator is the authority on whether a signed Hedera transfer is valid,
 * and the wire format is stable. Field names below are copied from
 * @x402/core@2.30.0 HTTPFacilitatorClient, not guessed:
 *
 *   POST /verify  { x402Version, paymentPayload, paymentRequirements }
 *                 -> { isValid, invalidReason?, invalidMessage?, payer? }
 *   POST /settle  { x402Version, paymentPayload, paymentRequirements }
 *                 -> { success, transaction, network, payer?, errorReason? }
 *
 * `transaction` is the Hedera transaction id — that is the string that goes into
 * docs/TX-PROOF.md and the submission form.
 *
 * Zero imports at module scope: this file is only loaded when PAYMENTS_MODE=live.
 */
import type { Config } from '../config.ts';
import type { Challenge, Gate, PaymentRequirementsView, SettleResult, VerifyResult } from './types.ts';

export interface FacilitatorCapabilities {
  kinds: { x402Version: number; scheme: string; network: string; extra?: Record<string, unknown> }[];
}

interface PaymentPayloadWire {
  x402Version: number;
  scheme?: string;
  network?: string;
  payload: unknown;
  [k: string]: unknown;
}

export function createHederaGate(cfg: Config): Gate {
  const url = cfg.facilitatorUrl.replace(/\/+$/, '');

  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const res = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`facilitator ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    return JSON.parse(text) as T;
  };

  /** One extra round-trip at boot so a wrong network fails loudly, not mid-demo. */
  let supported: FacilitatorCapabilities | null = null;
  const getSupported = async (): Promise<FacilitatorCapabilities> => {
    if (supported) return supported;
    const res = await fetch(`${url}/supported`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`facilitator /supported -> ${res.status}`);
    supported = (await res.json()) as FacilitatorCapabilities;
    const hasHedera = supported.kinds.some((k) => k.network === cfg.network && k.scheme === 'exact');
    if (!hasHedera) {
      throw new Error(
        `facilitator ${url} does not advertise ${cfg.network} exact; got ${supported.kinds
          .map((k) => `${k.network}/${k.scheme}`)
          .join(', ')}`,
      );
    }
    return supported;
  };

  const feePayerFor = async (): Promise<string | undefined> => {
    const s = await getSupported();
    const kind = s.kinds.find((k) => k.network === cfg.network && k.scheme === 'exact');
    return (kind?.extra?.feePayer as string | undefined) ?? undefined;
  };

  const decodePayment = (header?: string): PaymentPayloadWire | null => {
    if (!header) return null;
    try {
      return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as PaymentPayloadWire;
    } catch {
      try {
        return JSON.parse(header) as PaymentPayloadWire;
      } catch {
        return null;
      }
    }
  };

  return {
    kind: 'hedera',

    async challenge({ resource, amountAtomic, payTo, description }): Promise<Challenge> {
      const feePayer = await feePayerFor();
      const requirements: PaymentRequirementsView = {
        scheme: 'exact',
        network: cfg.network,
        amount: amountAtomic.toString(),
        asset: cfg.asset.id,
        payTo,
        resource,
        description,
        maxTimeoutSeconds: 180,
        extra: feePayer ? { feePayer } : undefined,
      };
      return {
        status: 402,
        body: { x402Version: 2, accepts: [requirements] },
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          // v2 wire format: any x402 client can read the challenge from here
          'payment-required': Buffer.from(JSON.stringify({ x402Version: 2, error: 'payment required', accepts: [requirements] })).toString('base64'),
        },
      };
    },

    async verify({ paymentHeader, requirements }): Promise<VerifyResult> {
      const paymentPayload = decodePayment(paymentHeader);
      if (!paymentPayload) return { ok: false, reason: 'X-PAYMENT is not valid base64 JSON' };
      const out = await post<{
        isValid: boolean;
        invalidReason?: string;
        invalidMessage?: string;
        payer?: string;
      }>('/verify', { x402Version: 2, paymentPayload, paymentRequirements: requirements });
      if (!out.isValid) {
        return { ok: false, reason: out.invalidReason ?? out.invalidMessage ?? 'invalid payment' };
      }
      return { ok: true, payer: out.payer, handle: { paymentPayload, requirements } };
    },

    async settle({ handle }): Promise<SettleResult> {
      const h = handle as { paymentPayload: PaymentPayloadWire; requirements: PaymentRequirementsView };
      const out = await post<{
        success: boolean;
        transaction: string;
        network: string;
        payer?: string;
        errorReason?: string;
      }>('/settle', {
        x402Version: 2,
        paymentPayload: h.paymentPayload,
        paymentRequirements: h.requirements,
      });
      return {
        success: out.success,
        txId: out.success ? out.transaction : undefined,
        payer: out.payer,
        network: out.network,
        errorReason: out.errorReason,
      };
    },
  };
}
