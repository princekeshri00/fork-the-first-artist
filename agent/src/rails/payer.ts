/**
 * The steward's wallet. This is what makes the agent autonomous: it pays for its
 * own inference, per call, with no human approving anything.
 *
 *   mock   — no wallet key configured: sends a dev X-PAYMENT header. The meter in
 *            dev mode accepts it. Lets the whole loop run offline.
 *   hedera — real x402: on 402, sign a partially-signed Hedera TransferTransaction
 *            with @x402/hedera, retry with X-PAYMENT, let the facilitator settle.
 *
 * `setSpendControls` is the SDK's built-in guard (per-payment cap + asset
 * allowlist) — the "spending controls for agents" requirement, enforced
 * client-side as a second line of defence behind the meter's own budget.
 */
import type { Provenance } from '../types.ts';

export interface Payer {
  kind: 'mock' | 'hedera';
  accountId?: string;
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export interface PayerOptions {
  accountId?: string;
  privateKey?: string;
  network?: string;
  /** hard client-side ceiling per payment, USD (default $1) */
  maxAmountPerPayment?: string;
  timeoutMs?: number;
}

export async function createPayer(opts: PayerOptions = {}): Promise<Payer> {
  const accountId = opts.accountId ?? process.env.HEDERA_AGENT_ACCOUNT_ID ?? '';
  const privateKey = opts.privateKey ?? process.env.HEDERA_AGENT_PRIVATE_KEY;
  const network = opts.network ?? process.env.HEDERA_NETWORK ?? 'hedera:testnet';

  if (!privateKey) {
    // Dev payer: no key, no chain. The meter must be in PAYMENTS_MODE=dev too.
    return {
      kind: 'mock',
      accountId: accountId || undefined,
      async fetch(url, init) {
        const headers = new Headers(init?.headers);
        headers.set('x-payment', `mock payer=${accountId || '0.0.0000'}`);
        return fetch(url, { ...init, headers });
      },
    };
  }

  const client = await buildX402Client({ accountId, privateKey, network, maxAmountPerPayment: opts.maxAmountPerPayment });

  return {
    kind: 'hedera',
    accountId,
    async fetch(url, init) {
      const first = await fetch(url, init);
      if (first.status !== 402) return first;

      const raw = await first.text();
      let challenge: { x402Version?: number; accepts?: unknown[] };
      try {
        challenge = JSON.parse(raw) as typeof challenge;
      } catch {
        throw new Error(`402 from ${url} was not JSON: ${raw.slice(0, 200)}`);
      }
      if (!challenge.accepts?.length) {
        throw new Error(`402 from ${url} had no payment requirements: ${raw.slice(0, 200)}`);
      }

      const paymentPayload = await client.createPaymentPayload({
        x402Version: challenge.x402Version ?? 2,
        accepts: challenge.accepts,
      } as never);
      const header = client.encodePaymentSignatureHeader(paymentPayload);

      const headers = new Headers(init?.headers);
      headers.set('X-PAYMENT', header);
      return fetch(url, { ...init, headers });
    },
  };
}

interface X402ClientLike {
  createPaymentPayload(paymentRequired: unknown): Promise<unknown>;
  encodePaymentSignatureHeader(payload: unknown): string;
}

async function buildX402Client(opts: {
  accountId: string;
  privateKey: string;
  network: string;
  maxAmountPerPayment?: string;
}): Promise<X402ClientLike> {
  // dynamic: dev mode does not need these packages installed at all
  const [{ x402Client }, { encodePaymentSignatureHeader }, hedera] = await Promise.all([
    import('@x402/core/client'),
    import('@x402/core/http'),
    import('@x402/hedera'),
  ]).catch((err: unknown) => {
    throw new Error(
      `Hedera payment needs @x402/core, @x402/hedera and @hiero-ledger/sdk installed: ${(err as Error).message}`,
    );
  });

  const { ExactHederaScheme } = await import('@x402/hedera/exact/client');
  const signer = hedera.createClientHederaSigner(
    opts.accountId,
    hedera.PrivateKey.fromStringECDSA(opts.privateKey),
    { network: opts.network },
  );

  const client = new x402Client()
    .register(opts.network as `${string}:${string}`, new ExactHederaScheme(signer))
    .setSpendControls({ maxAmountPerPayment: opts.maxAmountPerPayment ?? '$1' });

  return {
    createPaymentPayload: (pr) => client.createPaymentPayload(pr as never),
    encodePaymentSignatureHeader: (p) => encodePaymentSignatureHeader(p as never),
  };
}

/** Pull the settlement tx id + upstream provenance out of a paid response. */
export function readMeterProvenance(payload: {
  x_meter?: {
    paymentTxId?: string;
    hcsTxId?: string | null;
    upstream?: { requestId?: string | null; teeVerified?: boolean | null };
  };
}): Provenance {
  const m = payload.x_meter;
  return {
    paymentTxId: m?.paymentTxId,
    hcsTxId: m?.hcsTxId ?? null,
    requestId: m?.upstream?.requestId ?? undefined,
    teeVerified: m?.upstream?.teeVerified ?? null,
  };
}
