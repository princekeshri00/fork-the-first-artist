/**
 * The 96.31 / 3.69 split, in integer atomic units.
 *
 * Rules that matter:
 *  - floor() the agent share, give the remainder to the artist, so the two
 *    shares ALWAYS sum to the exact amount paid. Never lose a tinybar/USDC-atomic.
 *  - never compute money in floats.
 */
import type { SplitBps } from './config.ts';

export interface Split {
  total: bigint;
  artist: bigint;
  agent: bigint;
}

export function splitAtomic(total: bigint, bps: SplitBps): Split {
  if (total < 0n) throw new Error('total must be >= 0');
  if (bps.artist + bps.agent !== 10_000) {
    throw new Error(`split bps must total 10000, got ${bps.artist + bps.agent}`);
  }
  const agent = (total * BigInt(bps.agent)) / 10_000n;
  const artist = total - agent;
  return { total, artist, agent };
}

/** Sanity gate for the demo: a split must never create or destroy value. */
export function assertConserved(s: Split): void {
  if (s.artist + s.agent !== s.total) {
    throw new Error(`split not conserved: ${s.artist} + ${s.agent} != ${s.total}`);
  }
}

/** Human summary for the UI / pitch: "0.10 USDC -> 0.09631 artist / 0.00369 agent" */
export function describeSplit(s: Split, decimals: number): string {
  const f = (v: bigint) => v.toString().padStart(decimals + 1, '0');
  const fmt = (v: bigint) => {
    const t = f(v);
    return `${t.slice(0, t.length - decimals)}.${t.slice(t.length - decimals)}`;
  };
  return `${fmt(s.total)} -> ${fmt(s.artist)} artist / ${fmt(s.agent)} agent`;
}
