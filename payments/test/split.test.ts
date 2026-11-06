import test from 'node:test';
import assert from 'node:assert/strict';
import { splitAtomic, assertConserved, describeSplit } from '../src/split.ts';
import { decimalToAtomic, atomicToDecimal, loadConfig } from '../src/config.ts';

test('split conserves value at every amount up to 100000 atomic', () => {
  const bps = { artist: 9631, agent: 369 };
  for (let total = 0n; total <= 100_000n; total++) {
    const s = splitAtomic(total, bps);
    assertConserved(s);
    assert.equal(s.total, total);
    // agent share never exceeds its bps, and never rounds up
    assert.ok(s.agent <= (total * 369n) / 10_000n + 1n);
  }
});

test('split is exactly 96.31 / 3.69 on a 0.10 USDC tip', () => {
  const total = decimalToAtomic('0.10', 6); // 100000
  const s = splitAtomic(total, { artist: 9631, agent: 369 });
  assert.equal(s.artist, 96_310n);
  assert.equal(s.agent, 3_690n);
  assert.equal(describeSplit(s, 6), '0.100000 -> 0.096310 artist / 0.003690 agent');
});

test('split gives the rounding remainder to the artist, never the agent', () => {
  // 7 atomic at 3.69% = 0.2583 -> floor 0 to the agent, artist keeps all 7
  const s = splitAtomic(7n, { artist: 9631, agent: 369 });
  assert.equal(s.agent, 0n);
  assert.equal(s.artist, 7n);
});

test('rejects a split that does not total 10000 bps', () => {
  assert.throws(() => splitAtomic(1000n, { artist: 9000, agent: 500 }), /must total 10000/);
});

test('atomic conversion refuses precision loss', () => {
  assert.equal(decimalToAtomic('0.002', 6), 2_000n);
  assert.equal(decimalToAtomic('1', 6), 1_000_000n);
  assert.equal(atomicToDecimal(2_000n, 6), '0.002000');
  assert.throws(() => decimalToAtomic('0.0000001', 6), /more than 6 decimals/);
});

test('loadConfig refuses a bad split total', () => {
  assert.throws(
    () => loadConfig({ split: { artist: 9000, agent: 500 } }),
    /must total 10000/,
  );
});
