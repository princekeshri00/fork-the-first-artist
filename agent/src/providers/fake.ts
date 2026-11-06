/**
 * Fake provider — the reason the whole agent loop is demoable and testable with
 * no API keys. It is deliberately dumb and deterministic: first turn asks for a
 * tool (if any are offered), second turn answers. That exercises the real tool
 * loop, the real budget code and the real envelope.
 *
 * Never selected when a real provider is configured; STEWARD_MODE=dev or a
 * missing credential picks it.
 */
import type {
  Capability,
  ModelProvider,
  NormalizedChatRequest,
  NormalizedChatResponse,
  ProviderId,
  Transport,
} from '../types.ts';

export class FakeProvider implements ModelProvider {
  readonly id: ProviderId = 'local';
  readonly transport: Transport = 'direct';
  readonly model: string;
  private readonly caps: Capability[] = ['tools', 'json'];

  constructor(model = 'fake-steward') {
    this.model = model;
  }

  supports(cap: Capability): boolean {
    return this.caps.includes(cap);
  }

  estimateCost(): number {
    return 0;
  }

  costOf(): number {
    return 0;
  }

  async chat(req: NormalizedChatRequest): Promise<NormalizedChatResponse> {
    const toolResults = req.messages.filter((m) => m.role === 'tool');
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const wantsJson = Boolean(req.jsonSchema);

    // turn 1: call the first available tool, if we have not already
    if (req.tools?.length && toolResults.length < req.tools.length) {
      const next = req.tools[toolResults.length];
      return {
        text: '',
        toolCalls: [{ id: `fake_${next.name}`, name: next.name, input: {} }],
        usage: { inputTokens: 40, outputTokens: 8 },
        provenance: { requestId: `fake-req-${Date.now().toString(36)}`, teeVerified: null },
      };
    }

    if (wantsJson) {
      const text = JSON.stringify({ text: `(fake) about: ${lastUser.slice(0, 60)}`, songs: ['Monsoon Ragas'] });
      return {
        text,
        usage: { inputTokens: 60, outputTokens: 20 },
        provenance: { requestId: `fake-req-${Date.now().toString(36)}`, teeVerified: null },
      };
    }

    const facts = toolResults
      .map((m) => `${m.toolName ?? 'tool'}: ${m.content.slice(0, 160)}`)
      .join(' | ');

    return {
      text: `(fake steward) ${facts ? `I checked — ${facts}. ` : ''}Ask me anything about ${lastUser.slice(0, 40)}.`,
      usage: { inputTokens: 80, outputTokens: 30 },
      provenance: { requestId: `fake-req-${Date.now().toString(36)}`, teeVerified: null },
    };
  }
}
