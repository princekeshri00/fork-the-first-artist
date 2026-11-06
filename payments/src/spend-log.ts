/**
 * Spend ledger + Hedera Consensus Service audit log.
 *
 * One source of truth: every paid call appends ONE entry. Budget totals are a
 * reduce over that file, so we never keep a second set of books that can drift.
 *
 * dev  -> append to data/spend-log.jsonl, synthetic hcsTxId "hcs-mock-..."
 * live -> same file, plus a real HCS message on the spend topic (Hedera's
 *         "HCS topic as tamper-evident audit log" bonus point).
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { atomicToDecimal, type Config } from './config.ts';

export interface SpendEntry {
  at: string;
  kind: 'ask' | 'meter' | 'template';
  /** Hedera x402 settlement transaction id, or mock equivalent */
  txId: string;
  priceAtomic: string;
  priceUsd: string;
  payer?: string;
  /** 0G router request id captured from x_upstream trace */
  upstreamRequestId?: string;
  upstreamCostUsd?: string;
  teeVerified?: boolean | null;
  model?: string;
  artistAtomic?: string;
  agentAtomic?: string;
  hcsTxId?: string | null;
  note?: string;
}

export interface Totals {
  totalUsd: number;
  lastHourUsd: number;
  calls: number;
}

export class SpendLog {
  private readonly cfg: Config;
  private cache: SpendEntry[] | null = null;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  private async readAll(): Promise<SpendEntry[]> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.cfg.ledgerPath, 'utf8');
      this.cache = raw
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => JSON.parse(l) as SpendEntry);
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  async append(entry: Omit<SpendEntry, 'at'> & { at?: string }): Promise<SpendEntry> {
    const full: SpendEntry = { at: entry.at ?? new Date().toISOString(), ...entry } as SpendEntry;

    // Exactly ONE line per paid call: budget totals are a reduce over this file,
    // so a second line would double-count spend.
    full.hcsTxId = await this.submitToHcs(full).catch((err: unknown) => {
      // never fail a paid request because the audit topic is unhappy
      console.warn(`[hcs] submit failed: ${(err as Error).message}`);
      return null;
    });

    await mkdir(dirname(this.cfg.ledgerPath), { recursive: true }).catch(() => {});
    await appendFile(this.cfg.ledgerPath, `${JSON.stringify(full)}\n`, 'utf8');
    this.cache = null;
    return full;
  }

  private async submitToHcs(entry: SpendEntry): Promise<string | null> {
    if (this.cfg.mode === 'dev' || !this.cfg.hcsSpendTopicId) {
      return `hcs-mock-${createHash('sha256').update(JSON.stringify(entry)).digest('hex').slice(0, 16)}`;
    }
    // dynamic import: dev mode must run without the Hedera SDK installed
    const { Client, PrivateKey, TopicMessageSubmitTransaction } = await import('@hiero-ledger/sdk');
    if (!this.cfg.agentPrivateKey) throw new Error('HEDERA_AGENT_PRIVATE_KEY required for HCS');
    const client = Client.forName(this.cfg.network.replace('hedera:', '')) as never as {
      setOperator(id: string, key: unknown): unknown;
    };
    client.setOperator(this.cfg.accounts.compute, PrivateKey.fromStringECDSA(this.cfg.agentPrivateKey));
    const resp = await new TopicMessageSubmitTransaction()
      .setTopicId(this.cfg.hcsSpendTopicId)
      .setMessage(JSON.stringify(entry))
      .execute(client as never);
    const receipt = await resp.getReceipt(client as never);
    return `${resp.transactionId.toString()}@${receipt.status.toString()}`;
  }

  async totals(now = Date.now()): Promise<Totals> {
    const all = await this.readAll();
    const oneHourAgo = now - 60 * 60 * 1000;
    let total = 0;
    let lastHour = 0;
    for (const e of all) {
      const usd = Number(e.priceUsd);
      total += usd;
      if (Date.parse(e.at) >= oneHourAgo) lastHour += usd;
    }
    return { totalUsd: round6(total), lastHourUsd: round6(lastHour), calls: all.length };
  }

  async recent(n = 20): Promise<SpendEntry[]> {
    const all = await this.readAll();
    return all.slice(-n).reverse();
  }
}

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

export function describePrice(atomic: bigint, decimals: number): string {
  return atomicToDecimal(atomic, decimals);
}
