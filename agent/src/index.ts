/**
 * Public entry point. Call this and nothing else:
 *
 *   import { createSteward } from './src/index.ts';
 *   const steward = await createSteward();
 *   const out = await steward.run({ provider: '0g', instruction: '...' });
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { ArtistProfile } from './types.ts';
import { loadAgentConfig, loadDotEnv } from './config.ts';
import { Budget } from './budget.ts';
import { defaultTools } from './tools.ts';
import { ProviderRegistry } from './providers/registry.ts';
import { Steward } from './steward.ts';
import { createPayer, type Payer } from './rails/payer.ts';

export interface CreateStewardOptions {
  artistPath?: string;
  configPath?: string;
  /** tests: never touch a real provider */
  forceFake?: boolean;
  fetchImpl?: typeof fetch;
  payer?: Payer;
}

export const DEMO_ARTIST: ArtistProfile = {
  name: 'Shaka',
  bio: 'Mumbai-based percussionist and vocalist; open-source orchestra, first artist on these rails.',
  songs: ['Monsoon Ragas', 'Bandra Night Bus', 'Salt on the Line'],
  ensName: 'shaka.oso.eth',
  hederaAccount: '0.0.0000',
  consent: true,
};

export async function loadArtist(path?: string): Promise<ArtistProfile> {
  const file = path ?? process.env.ARTIST_FILE ?? 'data/artist.json';
  if (!existsSync(file)) return DEMO_ARTIST;
  const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<ArtistProfile>;
  return { ...DEMO_ARTIST, ...raw };
}

export async function createSteward(opts: CreateStewardOptions = {}): Promise<Steward> {
  loadDotEnv();
  const config = loadAgentConfig(opts.configPath);
  const artist = await loadArtist(opts.artistPath);

  const transport = config.providers[config.default]?.transport ?? 'direct';
  const payer =
    opts.payer ??
    (transport === 'x402-meter' || process.env.HEDERA_AGENT_PRIVATE_KEY
      ? await createPayer()
      : undefined);

  const providers = new ProviderRegistry(config, {
    payer,
    fetchImpl: opts.fetchImpl,
    meterUrl: process.env.METER_URL,
    forceFake: opts.forceFake ?? process.env.STEWARD_MODE === 'fake',
  });

  return new Steward({
    config,
    artist,
    providers,
    tools: defaultTools(),
    budget: new Budget(config.budget),
    paymentsUrl: process.env.PAYMENTS_URL,
  });
}

export { Steward } from './steward.ts';
export { Budget } from './budget.ts';
export { ToolRegistry, defaultTools } from './tools.ts';
export { ProviderRegistry } from './providers/registry.ts';
export { createPayer, type Payer } from './rails/payer.ts';
export { loadAgentConfig, providerAvailability } from './config.ts';
export { fencedData, sanitizeForPrompt, systemPrompt } from './fence.ts';
export { extractJson } from './steward.ts';
export * from './types.ts';
