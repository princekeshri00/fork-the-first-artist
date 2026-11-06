/**
 * Config loading + validation. No schema library: the config is small and the
 * error messages are the documentation.
 */
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import type { AgentConfig, Capability, ProviderConfig, ProviderId } from './types.ts';

export function loadDotEnv(path = '.env'): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

const CAPS: Capability[] = ['tools', 'json', 'vision', 'stream'];

export function loadAgentConfig(
  path = process.env.PROVIDER_CONFIG ?? 'config/providers.json',
): AgentConfig {
  if (!existsSync(path)) {
    // fall back to the checked-in example so a fresh clone always boots
    const fallback = path.replace(/\.json$/, '.example.json');
    if (!existsSync(fallback)) throw new Error(`no provider config at ${path} or ${fallback}`);
    path = fallback;
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as AgentConfig;

  if (!parsed.providers || typeof parsed.providers !== 'object') {
    throw new Error(`${path}: missing "providers"`);
  }
  if (!parsed.providers[parsed.default]) {
    throw new Error(`${path}: default provider "${parsed.default}" is not in providers`);
  }

  for (const [id, p] of Object.entries(parsed.providers)) {
    if (p.kind === 'rail') continue;
    if (!p.baseUrl) throw new Error(`${path}: provider ${id} needs baseUrl`);
    if (!p.defaultModel) throw new Error(`${path}: provider ${id} needs defaultModel`);
    for (const cap of p.capabilities ?? []) {
      if (!CAPS.includes(cap)) throw new Error(`${path}: provider ${id} has unknown capability ${cap}`);
    }
  }

  const g = parsed.generation ?? { temperature: 0.4, maxTokens: 400, maxToolTurns: 4 };
  const b = parsed.budget ?? { maxUsdPerRequest: 0.002, maxUsdPerHour: 0.05, maxUsdTotal: 5 };
  if (!(b.maxUsdPerRequest > 0)) throw new Error(`${path}: budget.maxUsdPerRequest must be > 0`);

  return {
    ...parsed,
    generation: {
      temperature: envNum('GENERATION_TEMPERATURE', g.temperature),
      maxTokens: envNum('GENERATION_MAX_TOKENS', g.maxTokens),
      maxToolTurns: g.maxToolTurns,
    },
    budget: {
      maxUsdPerRequest: envNum('BUDGET_PER_REQUEST_USD', b.maxUsdPerRequest),
      maxUsdPerHour: envNum('BUDGET_HOURLY_USD', b.maxUsdPerHour),
      maxUsdTotal: envNum('BUDGET_TOTAL_USD', b.maxUsdTotal),
    },
  };
}

function envNum(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number, got ${JSON.stringify(v)}`);
  return n;
}

/** Has this provider got what it needs to actually run? */
export function providerAvailability(
  cfg: ProviderConfig,
): { usable: boolean; reason?: string } {
  if (cfg.transport === 'x402-meter') {
    return {
      usable: true, // the meter holds the upstream key; the agent only needs a wallet
      reason: process.env.HEDERA_AGENT_PRIVATE_KEY ? undefined : 'no wallet key: dev/mock payment',
    };
  }
  if (!cfg.envKey) return { usable: true };
  const v = process.env[cfg.envKey];
  return v ? { usable: true } : { usable: false, reason: `${cfg.envKey} is not set` };
}

export function providerIds(cfg: AgentConfig): ProviderId[] {
  return Object.entries(cfg.providers)
    .filter(([, p]) => p.kind === 'inference')
    .map(([id]) => id as ProviderId);
}
