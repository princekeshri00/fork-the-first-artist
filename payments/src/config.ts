/**
 * Config for the payments service. Everything comes from env; nothing is invented.
 * `PAYMENTS_MODE=dev` runs the whole flow with a mock facilitator, so the repo is
 * demoable and testable with zero credentials. `live` needs the Hedera accounts.
 */
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';

export type Mode = 'dev' | 'live';

export interface SplitBps {
  artist: number;
  agent: number;
}

export interface Budget {
  totalUsd: number;
  hourlyUsd: number;
  maxPerCallUsd: number;
}

export interface Config {
  mode: Mode;
  port: number;
  network: string;
  facilitatorUrl: string;
  asset: { id: string; decimals: number };
  accounts: { artist: string; compute: string };
  agentPrivateKey?: string;
  hcsSpendTopicId?: string;
  split: SplitBps;
  prices: { askAtomic: bigint; meterAtomic: bigint };
  budget: Budget;
  upstream: {
    baseUrl: string;
    apiKey?: string;
    model: string;
    trustMode: string;
  };
  stewardUrl: string;
  /** where the local spend ledger lives (jsonl) */
  ledgerPath: string;
}

/** tiny .env loader — no dependency, predictable, ignores missing files */
export function loadDotEnv(path = '.env'): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

const env = (k: string): string | undefined => {
  const v = process.env[k];
  return v === undefined || v === '' ? undefined : v;
};
const num = (k: string, fallback: number): number => {
  const v = env(k);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${k} must be a number, got ${JSON.stringify(v)}`);
  return n;
};

/** "0.002" + 6 decimals -> 2000n. Refuses to silently round. */
export function decimalToAtomic(value: string, decimals: number): bigint {
  const [whole, frac = ''] = value.trim().split('.');
  if (frac.length > decimals) {
    throw new Error(`${value} has more than ${decimals} decimals; would lose funds`);
  }
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(`${whole || '0'}${padded}`);
}

export function atomicToDecimal(atomic: bigint, decimals: number): string {
  const neg = atomic < 0n;
  const s = (neg ? -atomic : atomic).toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals);
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const mode = (env('PAYMENTS_MODE') ?? 'dev') as Mode;
  if (mode !== 'dev' && mode !== 'live') {
    throw new Error(`PAYMENTS_MODE must be "dev" or "live", got ${JSON.stringify(mode)}`);
  }

  const decimals = num('HEDERA_ASSET_DECIMALS', 6);

  const base: Config = {
    mode,
    port: num('PORT', 8402),
    network: env('HEDERA_NETWORK') ?? 'hedera:testnet',
    facilitatorUrl: env('FACILITATOR_URL') ?? 'https://x402.org/facilitator',
    asset: { id: env('HEDERA_ASSET') ?? '0.0.429274', decimals },
    accounts: {
      artist: env('HEDERA_ARTIST_ACCOUNT_ID') ?? '',
      compute: env('HEDERA_COMPUTE_ACCOUNT_ID') ?? '',
    },
    agentPrivateKey: env('HEDERA_AGENT_PRIVATE_KEY'),
    hcsSpendTopicId: env('HCS_SPEND_TOPIC_ID'),
    split: {
      artist: num('SPLIT_ARTIST_BPS', 9631),
      agent: num('SPLIT_AGENT_BPS', 369),
    },
    prices: {
      askAtomic: decimalToAtomic(env('PRICE_ASK_USDC') ?? '0.10', decimals),
      meterAtomic: decimalToAtomic(env('PRICE_METER_USDC') ?? '0.002', decimals),
    },
    budget: {
      totalUsd: num('BUDGET_TOTAL_USD', 5),
      hourlyUsd: num('BUDGET_HOURLY_USD', 0.05),
      maxPerCallUsd: num('BUDGET_MAX_PER_CALL_USD', 0.01),
    },
    upstream: {
      baseUrl: (env('UPSTREAM_BASE_URL') ?? 'https://router-api.0g.ai/v1').replace(/\/+$/, ''),
      apiKey: env('UPSTREAM_API_KEY'),
      model: env('UPSTREAM_MODEL') ?? '0gm-1.0-35b-a3b',
      trustMode: env('UPSTREAM_TRUST_MODE') ?? 'verified',
    },
    stewardUrl: (env('STEWARD_URL') ?? 'http://localhost:8403').replace(/\/+$/, ''),
    ledgerPath: env('LEDGER_PATH') ?? 'data/spend-log.jsonl',
  };

  // Overrides win, then validation — so a bad override cannot slip through.
  const cfg: Config = { ...base, ...overrides };

  if (cfg.split.artist + cfg.split.agent !== 10_000) {
    throw new Error(
      `split must total 10000 bps, got artist=${cfg.split.artist} + agent=${cfg.split.agent} = ${cfg.split.artist + cfg.split.agent}`,
    );
  }

  // dev keeps zero-config bootstrapping promise: nothing settles on chain, so
  // placeholder accounts are honest here and are never used for a real transfer
  if (cfg.mode === 'dev') {
    if (!cfg.accounts.artist) cfg.accounts.artist = '0.0.5555';
    if (!cfg.accounts.compute) cfg.accounts.compute = '0.0.6666';
  }

  if (cfg.mode === 'live') {
    const missing = [
      ['HEDERA_ARTIST_ACCOUNT_ID', cfg.accounts.artist],
      ['HEDERA_COMPUTE_ACCOUNT_ID', cfg.accounts.compute],
    ].filter(([, v]) => !v);
    if (missing.length) {
      throw new Error(
        `PAYMENTS_MODE=live needs ${missing.map(([k]) => k).join(', ')} — see .env.example`,
      );
    }
  }

  return cfg;
}
