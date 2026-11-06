/**
 * End-to-end demo: a fan pays the artist's steward, the steward pays for its own
 * inference, and both transactions are printed with their proof.
 *
 * Requires both services running (the real deployment topology):
 *   payments/  node src/server.ts     # :8402  (PAYMENTS_MODE=dev or live)
 *   agent/     node src/server.ts     # :8403  (INFERENCE_TRANSPORT=x402-meter)
 *
 *   node scripts/demo.ts
 *   node scripts/demo.ts "what songs do you play?"
 */
const paymentsUrl = (process.env.PAYMENTS_URL ?? 'http://localhost:8402').replace(/\/+$/, '');
const question = process.argv.slice(2).join(' ') || 'Who are you and what do you play?';

const ok = (s: string) => console.log(s);
const rule = (s = '') => ok(`\n${s}${'─'.repeat(Math.max(0, 66 - s.length))}`);

async function health(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  rule('1. services');
  const payments = await health(paymentsUrl);
  if (!payments) {
    console.error(`✖ payments is not answering at ${paymentsUrl} — run: cd payments && npm start`);
    process.exitCode = 1;
    return;
  }
  ok(`✔ payments  mode=${payments.mode} gate=${payments.gate} asset=${payments.asset}`);

  const stewardUrl = (payments.stewardUrl as string) ?? process.env.STEWARD_URL ?? 'http://localhost:8403';
  const steward = await health(stewardUrl);
  if (!steward) {
    console.error(`✖ steward is not answering at ${stewardUrl} — run: cd agent && npm start`);
    process.exitCode = 1;
    return;
  }
  ok(`✔ steward   provider=${steward.provider} model=${steward.model} transport=${steward.transport}`);

  rule('2. fan asks without paying');
  const unpaid = await fetch(`${paymentsUrl}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instruction: question }),
  });
  const challenge = (await unpaid.json()) as { accepts?: { amount: string; asset: string; payTo: string }[] };
  ok(`HTTP ${unpaid.status} ⸺ ${challenge.accepts?.[0]?.amount ?? '?'} atomic ${
    challenge.accepts?.[0]?.asset ?? ''
  } → payTo ${challenge.accepts?.[0]?.payTo ?? '?'}`);
  if (unpaid.status !== 402) {
    console.error(`expected a 402, got ${unpaid.status}: ${JSON.stringify(challenge).slice(0, 200)}`);
    process.exitCode = 1;
    return;
  }

  rule('3. fan pays, steward answers');
  const paid = await fetch(`${paymentsUrl}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-payment': 'mock payer=0.0.7777' },
    body: JSON.stringify({ instruction: question }),
  });
  const body = (await paid.json()) as {
    ok?: boolean;
    reply?: { text: string };
    provider?: string;
    model?: string;
    degradation?: string;
    error?: { code: string; message: string };
    split?: { human: string };
    proof?: {
      paymentTxId: string;
      payer?: string;
      hcsTxId?: string | null;
      hashScan: string;
      upstream: { requestId: string | null; teeVerified: boolean | null };
    };
  };

  if (paid.status !== 200) {
    console.error(`✖ HTTP ${paid.status}: ${body.error?.code} — ${body.error?.message}`);
    process.exitCode = 1;
    return;
  }

  ok(`Q: ${question}`);
  ok(`A: ${body.reply?.text ?? '(empty)'}`);
  ok(`   via ${body.provider}/${body.model}${body.degradation ? ` [degraded: ${body.degradation}]` : ''}`);

  rule('4. the proof judges ask for');
  ok(`split          : ${body.split?.human}`);
  ok(`payment tx     : ${body.proof?.paymentTxId}`);
  ok(`HashScan       : ${body.proof?.hashScan}`);
  ok(`0G request id  : ${body.proof?.upstream.requestId ?? '(none)'}`);
  ok(`TEE verified   : ${body.proof?.upstream.teeVerified ?? '(not requested)'}`);
  ok(`HCS spend log  : ${body.proof?.hcsTxId ?? '(none)'}`);

  rule('5. the agent paid for its own thinking');
  const ledger = (await fetch(`${paymentsUrl}/ledger/recent?n=10`).then((r) => r.json())) as {
    entries: { kind: string; priceUsd: string; payer?: string; upstreamRequestId?: string; txId: string }[];
    totals: { totalUsd: number; calls: number };
  };
  const agentSpend = ledger.entries
    .filter((e) => e.kind === 'meter')
    .reduce((n, e) => n + Number(e.priceUsd), 0);
  for (const e of ledger.entries) {
    ok(`${e.kind.padEnd(5)} ${e.priceUsd} USDC  payer=${e.payer ?? '?'}  tx=${e.txId}  req=${e.upstreamRequestId ?? '?'}`);
  }
  ok(`\nthe agent paid ${agentSpend.toFixed(6)} USDC of its own money for inference`);
  ok(`total through the rails: ${ledger.totals.totalUsd} USDC over ${ledger.totals.calls} calls`);
}

await main();
