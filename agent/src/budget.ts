/**
 * Spend budget for the steward.
 *
 * Three ceilings (per request, per hour, total). The per-request check runs
 * BEFORE any network call, so a request that cannot be afforded never costs
 * anything — this is the "spending controls for agents" requirement, and it is
 * also the graceful-degradation trigger: the caller gets a template reply
 * instead of an error the fan can see.
 *
 * State lives in a jsonl file so a restart cannot forget what was spent.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface BudgetCaps {
  maxUsdPerRequest: number;
  maxUsdPerHour: number;
  maxUsdTotal: number;
}

export interface BudgetEntry {
  at: string;
  kind: 'inference' | 'tool' | 'template';
  spentUsd: number;
  note?: string;
}

export type BudgetVerdict =
  | { ok: true; remainingUsd: number }
  | { ok: false; scope: 'request' | 'hourly' | 'total'; spentUsd: number; capUsd: number };

export class Budget {
  readonly caps: BudgetCaps;
  private readonly path: string;
  private cache: BudgetEntry[] | null = null;

  constructor(caps: BudgetCaps, path = process.env.BUDGET_LEDGER ?? 'data/budget.jsonl') {
    this.caps = caps;
    this.path = path;
  }

  private async readAll(): Promise<BudgetEntry[]> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.path, 'utf8');
      this.cache = raw.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as BudgetEntry);
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  async totals(nowMs = Date.now()): Promise<{ totalUsd: number; lastHourUsd: number; calls: number }> {
    const all = await this.readAll();
    const hourAgo = nowMs - 3_600_000;
    let total = 0;
    let hour = 0;
    for (const e of all) {
      total += e.spentUsd;
      if (Date.parse(e.at) >= hourAgo) hour += e.spentUsd;
    }
    return { totalUsd: round6(total), lastHourUsd: round6(hour), calls: all.length };
  }

  /** Can we afford this, considering the per-request override from the caller? */
  async check(estimatedUsd: number, overrides?: { maxUsd?: number; nowMs?: number }): Promise<BudgetVerdict> {
    const perRequest = overrides?.maxUsd ?? this.caps.maxUsdPerRequest;
    if (estimatedUsd > perRequest) {
      return { ok: false, scope: 'request', spentUsd: estimatedUsd, capUsd: perRequest };
    }
    const t = await this.totals(overrides?.nowMs);
    if (t.totalUsd + estimatedUsd > this.caps.maxUsdTotal) {
      return { ok: false, scope: 'total', spentUsd: t.totalUsd, capUsd: this.caps.maxUsdTotal };
    }
    if (t.lastHourUsd + estimatedUsd > this.caps.maxUsdPerHour) {
      return { ok: false, scope: 'hourly', spentUsd: t.lastHourUsd, capUsd: this.caps.maxUsdPerHour };
    }
    return { ok: true, remainingUsd: round6(this.caps.maxUsdTotal - t.totalUsd) };
  }

  async record(entry: Omit<BudgetEntry, 'at'> & { at?: string }): Promise<void> {
    const full: BudgetEntry = { at: entry.at ?? new Date().toISOString(), ...entry } as BudgetEntry;
    await mkdir(dirname(this.path), { recursive: true }).catch(() => {});
    await appendFile(this.path, `${JSON.stringify(full)}\n`, 'utf8');
    this.cache = null;
  }
}

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;
