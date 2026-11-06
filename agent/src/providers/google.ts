/**
 * Google Gemini adapter.
 *
 * Differences this file owns:
 *   - `contents`/`parts` instead of messages; the system prompt is
 *     `systemInstruction`
 *   - tools are `functionDeclarations`, results are `functionResponse` parts
 *   - JSON mode is `responseMimeType: application/json` (+ optional schema)
 *   - the model name is part of the URL
 */
import type {
  Capability,
  ModelProvider,
  NormalizedChatRequest,
  NormalizedChatResponse,
  NormalizedMessage,
  NormalizedToolCall,
  ProviderId,
  Transport,
} from '../types.ts';

export interface GoogleOptions {
  id?: ProviderId;
  baseUrl?: string;
  apiKey: string;
  defaultModel: string;
  capabilities: Capability[];
  priceUsdPerMTok: { input: number; output: number };
  fetchImpl?: typeof fetch;
}

type Part =
  | { text: string }
  | { functionCall: { name: string; args: unknown } }
  | { functionResponse: { name: string; response: unknown } };

interface GoogleResponse {
  candidates?: { content?: { parts?: Part[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export class GoogleProvider implements ModelProvider {
  readonly id: ProviderId;
  readonly transport: Transport = 'direct';
  readonly model: string;
  private readonly opts: GoogleOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GoogleOptions) {
    this.opts = opts;
    this.id = opts.id ?? 'gemini';
    this.model = opts.defaultModel;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  supports(cap: Capability): boolean {
    return this.opts.capabilities.includes(cap);
  }

  estimateCost(req: NormalizedChatRequest): number {
    const inputChars = req.messages.reduce((n, m) => n + m.content.length, 0);
    const inputTokens = Math.ceil(inputChars / 4) + 32;
    const outputTokens = req.maxTokens ?? 400;
    return (
      (inputTokens * this.opts.priceUsdPerMTok.input + outputTokens * this.opts.priceUsdPerMTok.output) /
      1_000_000
    );
  }

  costOf(usage: { inputTokens: number; outputTokens: number }): number {
    return (
      (usage.inputTokens * this.opts.priceUsdPerMTok.input +
        usage.outputTokens * this.opts.priceUsdPerMTok.output) /
      1_000_000
    );
  }

  async chat(req: NormalizedChatRequest): Promise<NormalizedChatResponse> {
    const base = this.opts.baseUrl ?? 'https://generativelanguage.googleapis.com';
    const url = `${base}/v1beta/models/${req.model}:generateContent?key=${encodeURIComponent(this.opts.apiKey)}`;

    const system = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');

    const body: Record<string, unknown> = {
      contents: toContents(req.messages.filter((m) => m.role !== 'system')),
      generationConfig: {
        temperature: req.temperature,
        maxOutputTokens: req.maxTokens ?? 400,
        ...(req.jsonSchema ? { responseMimeType: 'application/json' } : {}),
      },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (req.tools?.length && this.supports('tools')) {
      body.tools = [
        {
          functionDeclarations: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          })),
        },
      ];
    }

    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`gemini ${res.status}: ${text.slice(0, 300)}`);

    const parsed = JSON.parse(text) as GoogleResponse;
    const parts = parsed.candidates?.[0]?.content?.parts ?? [];

    let callIndex = 0;
    const toolCalls: NormalizedToolCall[] = parts
      .filter((p): p is Extract<Part, { functionCall: unknown }> => 'functionCall' in p)
      .map((p) => ({
        id: `gemini_${callIndex++}`,
        name: p.functionCall.name,
        input: p.functionCall.args,
      }));

    return {
      text: parts
        .filter((p): p is Extract<Part, { text: string }> => 'text' in p)
        .map((p) => p.text)
        .join('\n')
        .trim(),
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage: {
        inputTokens: parsed.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: parsed.usageMetadata?.candidatesTokenCount ?? 0,
      },
      provenance: { teeVerified: null },
      raw: parsed,
    };
  }
}

function toContents(messages: NormalizedMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        parts: [{ functionResponse: { name: m.toolName ?? 'tool', response: { result: m.content } } }],
      });
      continue;
    }
    const parts: Part[] = [];
    if (m.content) parts.push({ text: m.content });
    for (const tc of m.toolCalls ?? []) parts.push({ functionCall: { name: tc.name, args: tc.input } });
    out.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }
  return out;
}
