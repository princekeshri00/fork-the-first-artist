/**
 * Payment gate: the one interface the meter and the paywall use.
 *
 * Two implementations:
 *   MockGate   (dev)  — protocol-shaped 402 challenges, no chain, no keys, instant.
 *   HederaGate (live) — real x402 settlement on Hedera testnet via a facilitator,
 *                       see gate/hedera.ts for the wire format.
 *
 * The rest of the service never imports @x402 or the Hedera SDK, so the demo
 * boots with zero dependencies and all sponsor-specific code lives in one file.
 */
import type { Config } from '../config.ts';

export interface PaymentRequirementsView {
  scheme: 'exact';
  network: string;
  /** atomic amount, string (x402 wire format) */
  amount: string;
  asset: string;
  payTo: string;
  resource: string;
  description?: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface Challenge {
  status: 402;
  body: {
    x402Version: 2;
    accepts: PaymentRequirementsView[];
    error?: string;
  };
  headers: Record<string, string>;
}

export interface VerifyResult {
  ok: boolean;
  /** set when ok */
  payer?: string;
  /** reason when !ok */
  reason?: string;
  /** opaque handle the gate needs in order to settle later */
  handle?: unknown;
}

export interface SettleResult {
  success: boolean;
  /** Hedera transaction id (or mock equivalent) */
  txId?: string;
  payer?: string;
  network?: string;
  errorReason?: string;
}

export interface Gate {
  readonly kind: 'mock' | 'hedera';
  /** Build a 402 challenge for a priced resource. */
  challenge(input: {
    resource: string;
    amountAtomic: bigint;
    payTo: string;
    description?: string;
  }): Promise<Challenge>;
  /** Verify an inbound X-PAYMENT header. Does not move funds. */
  verify(input: { paymentHeader?: string; requirements: PaymentRequirementsView }): Promise<VerifyResult>;
  /** Move funds. Called AFTER the handler succeeded, so fans are not charged for a failed answer. */
  settle(input: { handle: unknown; requirements: PaymentRequirementsView }): Promise<SettleResult>;
}

export function createMockGate(cfg: Config): Gate {
  const payee = cfg.accounts.artist || '0.0.0000';
  return {
    kind: 'mock',
    async challenge({ resource, amountAtomic, payTo, description }) {
      const requirements = {
        scheme: 'exact' as const,
        network: cfg.network,
        amount: amountAtomic.toString(),
        asset: cfg.asset.id,
        payTo: payTo || payee,
        resource,
        description,
        maxTimeoutSeconds: 180,
        extra: { feePayer: '0.0.0000', devMock: true },
      };
      const body = {
        x402Version: 2 as const,
        error: 'payment required (dev mode: mock facilitator, nothing settles on chain)',
        accepts: [requirements],
      };
      return {
        status: 402,
        body,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          // v2 wire format: any x402 client can read the challenge from here
          'payment-required': Buffer.from(JSON.stringify(body)).toString('base64'),
        },
      };
    },
    async verify({ paymentHeader }) {
      if (!paymentHeader) return { ok: false, reason: 'missing X-PAYMENT header' };
      const payer = /payer=(0\.0\.\d+)/.exec(paymentHeader)?.[1] ?? '0.0.0000';
      return { ok: true, payer, handle: { paymentHeader, payer } };
    },
    async settle({ handle }) {
      const payer = (handle as { payer?: string })?.payer ?? '0.0.0000';
      return {
        success: true,
        txId: `mock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        payer,
        network: cfg.network,
      };
    },
  };
}
