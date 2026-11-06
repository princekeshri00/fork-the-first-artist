/**
 * Smoke test (milestone M0): one real inference call through the configured
 * provider, printing exactly the provenance the judges ask for.
 *
 *   node scripts/smoke.ts                    # configured default (0g)
 *   node scripts/smoke.ts --provider openai  # prove portability
 *   node scripts/smoke.ts --direct           # bypass the meter (dev)
 */
import { loadDotEnv, loadAgentConfig, providerAvailability } from '../src/config.ts';
import { ProviderRegistry } from '../src/providers/registry.ts';
import { createPayer } from '../src/rails/payer.ts';
import type { ProviderId } from '../src/types.ts';

loadDotEnv();

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

const cfg = loadAgentConfig();
const providerId = (flag('provider') ?? cfg.default) as ProviderId;
const pcfg = cfg.providers[providerId];

if (!pcfg || pcfg.kind !== 'inference') {
  console.error(`unknown inference provider "${providerId}". configured: ${Object.keys(cfg.providers).join(', ')}`);
  process.exit(1);
}

const avail = providerAvailability(pcfg);
console.log(`provider   : ${providerId} (${pcfg.label})`);
console.log(`model      : ${pcfg.defaultModel}`);
console.log(`transport  : ${args.includes('--direct') ? 'direct' : pcfg.transport}`);
console.log(`credentials: ${avail.usable ? 'ok' : `missing — ${avail.reason}`}`);
console.log('');

const payer =
  !args.includes('--direct') && (pcfg.transport === 'x402-meter' || process.env.HEDERA_AGENT_PRIVATE_KEY)
    ? await createPayer()
    : undefined;

console.log(`payer      : ${payer ? payer.kind : 'none (direct dev call)'}`);

const registry = new ProviderRegistry(cfg, {
  payer,
  meterUrl: process.env.METER_URL,
});
const provider = registry.get(providerId);

try {
  const res = await provider.chat({
    model: pcfg.defaultModel,
    messages: [
      { role: 'system', content: 'You are a terse assistant.' },
      { role: 'user', content: 'In one short sentence: who is Shaka?' },
    ],
    temperature: 0.3,
    maxTokens: 80,
  });

  console.log('\n--- answer ---');
  console.log(res.text.trim() || '(empty)');
  console.log('\n--- provenance (this is the submission evidence) ---');
  console.log(`requestId  : ${res.provenance.requestId ?? '(none)'}`);
  console.log(`teeVerified: ${res.provenance.teeVerified ?? '(not requested)'}`);
  console.log(`paymentTxId: ${res.provenance.paymentTxId ?? '(no payment on this transport)'}`);
  console.log(`hcsTxId    : ${res.provenance.hcsTxId ?? '(none)'}`);
  console.log(`usage      : ${res.usage.inputTokens} in / ${res.usage.outputTokens} out`);
  console.log(`costUsd    : ${provider.costOf?.(res.usage)?.toFixed(6) ?? 'n/a'}`);
} catch (err) {
  console.error('\nFAILED:', (err as Error).message);
  console.error('\nchecklist: ZEROG_API_KEY set? meter running (npm start in payments/)? PAYMENTS_MODE matching?');
  process.exit(1);
}
