/**
 * Anthropic adapter — the one provider that does NOT speak OpenAI.
 *
 * Differences this file owns so nothing above it has to know:
 *   - `system` is a top-level field, not a message in the array
 *   - content is a block array; tool use is a `tool_use` block, tool output is a
 *     `tool_result` block inside a user message
 *   - `max_tokens` is required
 *   - no JSON mode: structured output is forced by instructing the model and
 *     validating the result (the steward already validates with the schema)
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

export interface AnthropicOptions {
  id?: ProviderId;
  baseUrl?: string;
  apiKey: string;
  defaultModel: string;
  capabilities: Capability[];
  priceUsdPerMTok: { input: number; output: number };
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface AnthropicResponse {
  content?: AnthropicBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
}

export class AnthropicProvider implements ModelProvider {
  readonly id: ProviderId;
  readonly transport: Transport = 'direct';
  readonly model: string;
  private readonly opts: AnthropicOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AnthropicOptions) {
    this.opts = opts;
    this.id = opts.id ?? 'anthropic';
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
    const system = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');

    const messages = toAnthropicMessages(req.messages.filter((m) => m.role !== 'system'));

    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 400,
      temperature: req.temperature,
      messages,
    };
    if (system) body.system = system;
    if (req.tools?.length && this.supports('tools')) {
      body.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }
    if (req.jsonSchema) {
      body.system = `${system}\n\nReply with a single JSON object matching this JSON Schema, nothing else:\n${JSON.stringify(
        req.jsonSchema,
      )}`;
    }

    const res = await this.fetchImpl(`${this.opts.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.opts.apiKey,
        'anthropic-version': '2023-06-01',
        ...this.opts.headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${text.slice(0, 300)}`);

    const parsed = JSON.parse(text) as AnthropicResponse;
    const blocks = parsed.content ?? [];
    const toolCalls: NormalizedToolCall[] = blocks
      .filter((b): b is Extract<AnthropicBlock, { type: 'tool_use' }> => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));

    return {
      text: blocks
        .filter((b): b is Extract<AnthropicBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim(),
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage: {
        inputTokens: parsed.usage?.input_tokens ?? 0,
        outputTokens: parsed.usage?.output_tokens ?? 0,
      },
      // Anthropic gives no attestation; null is honest, not "true"
      provenance: { teeVerified: null },
      raw: parsed,
    };
  }
}

function toAnthropicMessages(messages: NormalizedMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      // tool output must live inside a user message as a tool_result block
      const last = out[out.length - 1] as { role?: string; content?: unknown[] } | undefined;
      const block: AnthropicBlock = {
        type: 'tool_result',
        tool_use_id: m.toolCallId ?? '',
        content: m.content,
      };
      if (last?.role === 'user' && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const blocks: AnthropicBlock[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }
  return out;
}
