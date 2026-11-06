/**
 * End-to-end tests for the meter and the paywall in dev mode:
 *  - 402 without payment, shaped like the x402 protocol
 *  - 200 with payment, carrying the payment tx id AND the upstream request id
 *  - budget exhaustion refuses BEFORE quoting a payment (403, not 402)
 *  - a failed steward never settles (payer keeps their money)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server.ts';
import { loadConfig, decimalToAtomic } from '../src/config.ts';
import { SpendLog } from '../src/spend-log.ts';

async function boot(opts: { budgetTotal?: number; hourly?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'oso-payments-'));
  const cfg = loadConfig({
    mode: 'dev',
    ledgerPath: join(dir, 'spend.jsonl'),
    accounts: { artist: '0.0.5555', compute: '0.0.6666' },
    prices: {
      askAtomic: decimalToAtomic('0.10', 6),
      meterAtomic: decimalToAtomic('0.002', 6),
    },
    budget: {
      totalUsd: opts.budgetTotal ?? 5,
      hourlyUsd: opts.hourly ?? 0.05,
      maxPerCallUsd: 0.01,
    },
    stewardUrl: 'http://127.0.0.1:1', // unreachable by default
  });
  const app = await createApp(cfg);
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const port = (app.server.address() as AddressInfo).port;
  return { app, base: `http://127.0.0.1:${port}`, dir, cfg };
}

const close = (srv: { close: (cb?: () => void) => unknown }) =>
  new Promise<void>((r) => srv.close(() => r()));

test('meter: 402 challenge is protocol-shaped and priced', async () => {
  const { app, base, dir } = await boot();
  try {
    const res = await fetch(`${base}/meter/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 402);
    const body = (await res.json()) as {
      x402Version: number;
      accepts: { scheme: string; network: string; amount: string; asset: string; payTo: string }[];
    };
    assert.equal(body.x402Version, 2);
    assert.equal(body.accepts[0].scheme, 'exact');
    assert.equal(body.accepts[0].network, 'hedera:testnet');
    assert.equal(body.accepts[0].amount, '2000'); // 0.002 USDC
    assert.equal(body.accepts[0].asset, '0.0.429274');
    assert.equal(body.accepts[0].payTo, '0.0.6666');
  } finally {
    await close(app.server);
    await rm(dir, { recursive: true, force: true });
  }
});

test('meter: paid call returns the answer, the payment tx and the 0G request id', async () => {
  const { app, base, dir, cfg } = await boot();
  try {
    const res = await fetch(`${base}/meter/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-payment': 'mock payer=0.0.7777' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'name me a raga' }] }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      choices: { message: { content: string } }[];
      x_meter: {
        paymentTxId: string;
        paidAtomic: string;
        upstream: { requestId: string | null; teeVerified: boolean | null; provider: string };
      };
    };
    assert.match(body.choices[0].message.content, /dev-mock inference/);
    assert.equal(body.x_meter.paidAtomic, '2000');
    assert.match(body.x_meter.paymentTxId, /^mock-/);
    assert.ok(body.x_meter.upstream.requestId, 'provenance request id must be captured');
    assert.equal(body.x_meter.upstream.teeVerified, true);
    assert.equal(body.x_meter.upstream.provider, '0g');

    // the settled call is in the ledger with both ids
    const log = new SpendLog(cfg);
    const entries = await log.recent(5);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, 'meter');
    assert.equal(entries[0].upstreamRequestId, body.x_meter.upstream.requestId);
    assert.ok(entries[0].hcsTxId, 'an audit log entry must be recorded');
  } finally {
    await close(app.server);
    await rm(dir, { recursive: true, force: true });
  }
});

test('meter: budget exhaustion refuses before quoting payment', async () => {
  const { app, base, dir } = await boot({ budgetTotal: 0.001 });
  try {
    const res = await fetch(`${base}/meter/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-payment': 'mock payer=0.0.7777' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: string; scope: string };
    assert.equal(body.error, 'SPEND_CAP_EXCEEDED');
    assert.equal(body.scope, 'total');
  } finally {
    await close(app.server);
    await rm(dir, { recursive: true, force: true });
  }
});

test('paywall: 402 without payment, then a paid answer with split proof', async () => {
  // stub steward: the agent package's contract, without the agent
  const steward = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        ok: true,
        reply: { text: 'Shaka plays a monsoon raga at 9pm.' },
        provider: '0g',
        model: '0gm-1.0-35b-a3b',
        usage: { inputTokens: 120, outputTokens: 20 },
        costUsd: 0.0002,
        provenance: { requestId: 'req-abc123', teeVerified: true },
      }),
    );
  });
  await new Promise<void>((r) => steward.listen(0, '127.0.0.1', r));
  const stewardPort = (steward.address() as AddressInfo).port;

  const dir = await mkdtemp(join(tmpdir(), 'oso-paywall-'));
  const cfg = loadConfig({
    mode: 'dev',
    ledgerPath: join(dir, 'spend.jsonl'),
    accounts: { artist: '0.0.5555', compute: '0.0.6666' },
    stewardUrl: `http://127.0.0.1:${stewardPort}`,
  });
  const app = await createApp(cfg);
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  try {
    const unpaid = await fetch(`${base}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 'when does shaka play?' }),
    });
    assert.equal(unpaid.status, 402);

    const paid = await fetch(`${base}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-payment': 'mock payer=0.0.7777' },
      body: JSON.stringify({ instruction: 'when does shaka play?' }),
    });
    assert.equal(paid.status, 200);
    const body = (await paid.json()) as {
      reply: { text: string };
      split: { human: string; artistAtomic: string; agentAtomic: string };
      proof: { paymentTxId: string; hashScan: string; upstream: { requestId: string; teeVerified: boolean } };
    };
    assert.match(body.reply.text, /monsoon raga/);
    assert.equal(body.split.artistAtomic, '96310');
    assert.equal(body.split.agentAtomic, '3690');
    assert.match(body.proof.paymentTxId, /^mock-/);
    assert.match(body.proof.hashScan, /hashscan\.io\/testnet\/transaction\/mock-/);
    assert.equal(body.proof.upstream.requestId, 'req-abc123');
    assert.equal(body.proof.upstream.teeVerified, true);

    const ledger = await fetch(`${base}/ledger/recent`).then((r) => r.json());
    assert.equal((ledger as { entries: unknown[] }).entries.length, 1);
  } finally {
    await close(app.server);
    await close(steward);
    await rm(dir, { recursive: true, force: true });
  }
});

test('paywall: steward failure does not settle the payment', async () => {
  const { app, base, dir, cfg } = await boot(); // stewardUrl points at a closed port
  try {
    const res = await fetch(`${base}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-payment': 'mock payer=0.0.7777' },
      body: JSON.stringify({ instruction: 'hello' }),
    });
    assert.equal(res.status, 502);
    const body = (await res.json()) as { settled: boolean };
    assert.equal(body.settled, false);
    const entries = await new SpendLog(cfg).recent(5);
    assert.equal(entries.length, 0, 'no ledger entry may exist for an unserved request');
  } finally {
    await close(app.server);
    await rm(dir, { recursive: true, force: true });
  }
});

test('discovery and split-preview are public and correct', async () => {
  const { app, base, dir } = await boot();
  try {
    const d = (await fetch(`${base}/.well-known/x402`).then((r) => r.json())) as {
      resources: Record<string, { priceAtomic: string; payTo: string }>;
      split: { artist: number; agent: number };
    };
    assert.equal(d.resources['/ask'].priceAtomic, '100000');
    assert.equal(d.split.agent, 3.69);

    const s = (await fetch(`${base}/split-preview?amount=1`).then((r) => r.json())) as {
      human: string;
      artistAtomic: string;
      agentAtomic: string;
    };
    assert.equal(s.artistAtomic, '963100');
    assert.equal(s.agentAtomic, '36900');
    assert.match(s.human, /artist/);
  } finally {
    await close(app.server);
    await rm(dir, { recursive: true, force: true });
  }
});

test('paywall: a degraded (template) steward answer is never charged', async () => {
  const steward = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        ok: true,
        reply: { text: "I'm Shaka's steward. (template reply)" },
        provider: '0g',
        model: '0gm-1.0-35b-a3b',
        degradation: 'template-reply',
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        provenance: {},
      }),
    );
  });
  await new Promise<void>((r) => steward.listen(0, '127.0.0.1', r));
  const stewardPort = (steward.address() as AddressInfo).port;

  const dir = await mkdtemp(join(tmpdir(), 'oso-degraded-'));
  const cfg = loadConfig({
    mode: 'dev',
    ledgerPath: join(dir, 'spend.jsonl'),
    accounts: { artist: '0.0.5555', compute: '0.0.6666' },
    stewardUrl: `http://127.0.0.1:${stewardPort}`,
  });
  const app = await createApp(cfg);
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  try {
    const res = await fetch(`${base}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-payment': 'mock payer=0.0.7777' },
      body: JSON.stringify({ instruction: 'hi' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { charged: boolean; settled: boolean; degradation: string; proof: unknown };
    assert.equal(body.degradation, 'template-reply');
    assert.equal(body.charged, false);
    assert.equal(body.settled, false);
    assert.equal(body.proof, null);
    const entries = await new SpendLog(cfg).recent(5);
    assert.equal(entries.length, 0, 'no ledger entry may be written for an uncharged reply');
  } finally {
    await close(app.server);
    await close(steward);
    await rm(dir, { recursive: true, force: true });
  }
});
