/**
 * The contract. Provider choice is data; the shape of an answer never changes.
 *
 * Everything above `src/providers/` speaks only these types — no vendor shapes,
 * no SDK types, no `any` leaking upward.
 */

export type ProviderId = '0g' | 'openai' | 'anthropic' | 'gemini' | 'local';
export type RailId = 'hedera' | 'none';
export type Capability = 'tools' | 'json' | 'vision' | 'stream';
export type Transport = 'direct' | 'x402-meter';
export type Degradation = 'cheaper-model' | 'shorter-max-tokens' | 'template-reply';

export type ErrorCode =
  | 'PROVIDER_UNAVAILABLE'
  | 'SPEND_CAP_EXCEEDED'
  | 'UNSUPPORTED_CAPABILITY'
  | 'SCHEMA_MISMATCH'
  | 'PAYMENT_FAILED'
  | 'NO_CONSENT'
  | 'TIMEOUT'
  | 'BAD_REQUEST';

// ---------------------------------------------------------------- provider config

export interface ProviderConfig {
  kind: 'inference' | 'rail';
  label: string;
  sdk: 'openai' | 'anthropic' | 'google' | 'none';
  baseUrl: string;
  envKey?: string;
  defaultModel: string;
  transport: Transport;
  headers?: Record<string, string>;
  /** provider extensions passed verbatim, e.g. 0G's `verify_tee` */
  extensions?: Record<string, unknown>;
  capabilities: Capability[];
  priceFallbackUsdPerMTok?: { input: number; output: number };
  devOnly?: boolean;
}

export interface AgentConfig {
  version: number;
  default: ProviderId;
  rail: RailId;
  fallback: { enabled: boolean; chain: string[] };
  providers: Record<string, ProviderConfig>;
  generation: { temperature: number; maxTokens: number; maxToolTurns: number };
  budget: { maxUsdPerRequest: number; maxUsdPerHour: number; maxUsdTotal: number };
}

// ---------------------------------------------------------------- requests

export interface ArtistProfile {
  name: string;
  bio: string;
  songs: string[];
  ensName?: string;
  hederaAccount?: string;
  consent?: boolean;
}

export interface AgentContext {
  artist: ArtistProfile;
  fan?: { handle?: string; wallet?: string };
}

export interface OutputSchema<T> {
  /** validate + narrow the model's JSON, e.g. a zod schema's `parse` */
  parse(value: unknown): T;
  /** optional JSON schema handed to the model for JSON mode */
  jsonSchema?: Record<string, unknown>;
  name?: string;
}

export interface AgentRunRequest<T = unknown> {
  instruction: string;
  provider?: ProviderId;
  model?: string;
  context?: Partial<AgentContext>;
  tools?: string[];
  output?: OutputSchema<T>;
  budget?: { maxUsd?: number };
}

// ---------------------------------------------------------------- responses

export interface Provenance {
  /** 0G: x_0g_trace.request_id */
  requestId?: string;
  /** 0G: x_0g_trace.tee_verified */
  teeVerified?: boolean | null;
  /** Hedera x402 settlement transaction id (paid to the meter) */
  paymentTxId?: string;
  /** Hedera consensus log entry id */
  hcsTxId?: string | null;
}

export interface ToolCallRecord {
  name: string;
  input: unknown;
  output: unknown;
  ok: boolean;
  latencyMs: number;
}

export type AgentResult<T = unknown> =
  | {
      ok: true;
      reply: { text: string; data?: T };
      provider: ProviderId;
      model: string;
      usage: { inputTokens: number; outputTokens: number };
      costUsd: number;
      provenance: Provenance;
      toolCalls: ToolCallRecord[];
      degradation?: Degradation;
      latencyMs: number;
    }
  | { ok: false; error: { code: ErrorCode; message: string; retryable: boolean } };

// ---------------------------------------------------------------- provider plumbing

export interface ModelInfo {
  id: string;
  capabilities: Capability[];
  priceUsdPerMTok?: { input: number; output: number };
}

export interface ToolDeclaration {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface NormalizedToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface NormalizedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolName?: string;
  /** assistant messages only: the calls the model asked for, kept for history */
  toolCalls?: NormalizedToolCall[];
}

export interface NormalizedChatRequest {
  model: string;
  messages: NormalizedMessage[];
  tools?: ToolDeclaration[];
  jsonSchema?: Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
}

export interface NormalizedChatResponse {
  text: string;
  toolCalls?: NormalizedToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  provenance: Provenance;
  /** vendor payload, for debugging only — nothing above the adapter reads it */
  raw?: unknown;
}

export interface ModelProvider {
  readonly id: ProviderId;
  readonly model: string;
  readonly transport: Transport;
  supports(cap: Capability): boolean;
  estimateCost(req: NormalizedChatRequest): number;
  /** exact cost of a finished call, when the provider reports usage */
  costOf?(usage: { inputTokens: number; outputTokens: number }): number;
  chat(req: NormalizedChatRequest): Promise<NormalizedChatResponse>;
}

export interface AgentInterface {
  run<T = unknown>(req: AgentRunRequest<T>): Promise<AgentResult<T>>;
  describe(): {
    provider: ProviderId;
    model: string;
    transport: Transport;
    rail: RailId;
    tools: string[];
    capabilities: Capability[];
  };
}
