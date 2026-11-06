import type { Config } from '../config.ts';
import type { Gate } from './types.ts';
import { createMockGate } from './types.ts';

export type { Challenge, Gate, PaymentRequirementsView, SettleResult, VerifyResult } from './types.ts';
export { createMockGate } from './types.ts';

/**
 * Async on purpose: the live gate is imported only when it is actually used, so
 * `PAYMENTS_MODE=dev` runs with no @x402 / Hedera SDK installed at all.
 */
export async function createGate(cfg: Config): Promise<Gate> {
  if (cfg.mode !== 'live') return createMockGate(cfg);
  const { createHederaGate } = await import('./hedera.ts');
  return createHederaGate(cfg);
}
