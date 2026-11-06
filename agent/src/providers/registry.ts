/**
 * Provider registry — resolves a provider id from config into a ModelProvider.
 *
 * The one rule that matters: a configured provider without credentials is
 * UNAVAILABLE, and we say so instead of quietly falling back to a different
 * model. Silent substitution is how a demo lies about where its answers came
 * from (0G's router refuses to do it for the same reason).
 */
import type { AgentConfig, ModelProvider, ProviderConfig, ProviderId } from '../types.ts';
import type { Payer } from '../rails/payer.ts';
import { OpenAICompatibleProvider } from './openai-compatible.ts';
import { AnthropicProvider } from './anthropic.ts';
import { GoogleProvider } from './google.ts';
import { FakeProvider } from './fake.ts';

export interface ProviderRuntime {
  payer?: Payer;
  /** injected in tests */
  fetchImpl?: typeof fetch;
  meterUrl?: string;
  forceFake?: boolean;
}

export class ProviderRegistry {
  private readonly cfg: AgentConfig;
  private readonly runtime: ProviderRuntime;
  private readonly cache = new Map<string, ModelProvider>();

  constructor(cfg: AgentConfig, runtime: ProviderRuntime = {}) {
    this.cfg = cfg;
    this.runtime = runtime;
  }

  config(id: ProviderId): ProviderConfig {
    const p = this.cfg.providers[id];
    if (!p) throw new Error(`unknown provider "${id}"; configured: ${Object.keys(this.cfg.providers).join(', ')}`);
    if (p.kind !== 'inference') throw new Error(`provider "${id}" is a ${p.kind}, not an inference provider`);
    return p;
  }

  get(id: ProviderId = this.cfg.default): ModelProvider {
    const cached = this.cache.get(id);
    if (cached) return cached;

    const p = this.config(id);
    const provider = this.build(id, p);
    this.cache.set(id, provider);
    return provider;
  }

  private build(id: ProviderId, p: ProviderConfig): ModelProvider {
    const key = p.envKey ? process.env[p.envKey] : undefined;
    const useMeter = p.transport === 'x402-meter';

    if (this.runtime.forceFake) return new FakeProvider(p.defaultModel);

    // direct transport with no key -> fake, but only when it is explicitly dev
    if (!useMeter && p.envKey && !key) {
      if (process.env.STEWARD_MODE === 'fake') return new FakeProvider(p.defaultModel);
      throw new Error(`${id}: ${p.envKey} is not set — set it, or use transport x402-meter`);
    }

    if (useMeter && !this.runtime.payer) {
      throw new Error(`${id}: transport x402-meter needs a payer (HEDERA_AGENT_ACCOUNT_ID / _PRIVATE_KEY)`);
    }

    const price = p.priceFallbackUsdPerMTok ?? { input: 0.2, output: 0.8 };

    if (p.sdk === 'anthropic') {
      return new AnthropicProvider({
        id,
        baseUrl: p.baseUrl,
        apiKey: key ?? '',
        defaultModel: p.defaultModel,
        capabilities: p.capabilities,
        priceUsdPerMTok: price,
        fetchImpl: this.runtime.fetchImpl,
      });
    }

    if (p.sdk === 'google') {
      return new GoogleProvider({
        id,
        baseUrl: p.baseUrl,
        apiKey: key ?? '',
        defaultModel: p.defaultModel,
        capabilities: p.capabilities,
        priceUsdPerMTok: price,
        fetchImpl: this.runtime.fetchImpl,
      });
    }

    return new OpenAICompatibleProvider({
      id,
      baseUrl: p.baseUrl,
      apiKey: key,
      headers: p.headers,
      extensions: p.extensions,
      defaultModel: p.defaultModel,
      transport: p.transport,
      meter: useMeter
        ? { url: this.runtime.meterUrl ?? 'http://localhost:8402/meter/v1/chat/completions', payer: this.runtime.payer! }
        : undefined,
      capabilities: p.capabilities,
      priceUsdPerMTok: price,
      fetchImpl: this.runtime.fetchImpl,
    });
  }
}
