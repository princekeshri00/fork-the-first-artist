/**
 * Adapter tests with an injected fetch: no network, no keys, but they assert the
 * exact request each vendor receives and the exact provenance we read back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.ts';
import { AnthropicProvider } from '../src/providers/anthropic.ts';
import { GoogleProvider } from '../src/providers/google.ts';
import type { Payer } from '../src/rails/payer.ts';

interface Captured {
  url: string;
  init: RequestInit;
}

function fakeFetch(reply: unknown, status = 200): { fetchImpl: typeof fetch; captured: Captured[] } {
  const captured: Captured[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(reply), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, captured };
}

const ok0g = {
  choices: [{ message: { content: 'Monsoon Ragas is a raga cycle.' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 120, completion_tokens: 18 },
  x_0g_trace: {
    request_id: '0852f405-6c56-40c2-a800',
    provider: '0xd9966e13a6026Fcca4b13E7ff95c94DE268C471C',
    tee_verified: true,
    billing: { total_cost: '0.00004' },
  },
};

test('0g direct: sends verify_tee + trust mode and lifts x_0g_trace', async () => {
  const { fetchImpl, captured } = fakeFetch(ok0g);
  const provider = new OpenAICompatibleProvider({
    id: '0g',
    baseUrl: 'https://router-api.0g.ai/v1',
    apiKey: 'sk-test',
    headers: { 'X-0G-Provider-Trust-Mode': 'verified' },
    extensions: { verify_tee: true },
    defaultModel: '0gm-1.0-35b-a3b',
    transport: 'direct',
    capabilities: ['tools', 'json'],
    priceUsdPerMTok: { input: 0.2, output: 0.8 },
    fetchImpl,
  });

  const res = await provider.chat({
    model: '0gm-1.0-35b-a3b',
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 100,
  });

  const c = captured[0];
  assert.equal(c.url, 'https://router-api.0g.ai/v1/chat/completions');
  const headers = c.init.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer sk-test');
  assert.equal(headers['X-0G-Provider-Trust-Mode'], 'verified');
  const body = JSON.parse(String(c.init.body));
  assert.equal(body.verify_tee, true);
  assert.equal(body.model, '0gm-1.0-35b-a3b');

  assert.equal(res.text, 'Monsoon Ragas is a raga cycle.');
  assert.equal(res.provenance.requestId, '0852f405-6c56-40c2-a800');
  assert.equal(res.provenance.teeVerified, true);
  assert.equal(res.provenance.paymentTxId, undefined);
});

test('0g direct: a 503 no_providers_available is an error, never a silent model swap', async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ error: 'no_providers_available' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

  const provider = new OpenAICompatibleProvider({
    id: '0g',
    baseUrl: 'https://router-api.0g.ai/v1',
    apiKey: 'sk-test',
    defaultModel: '0gm-1.0-35b-a3b',
    transport: 'direct',
    capabilities: ['tools'],
    priceUsdPerMTok: { input: 0.2, output: 0.8 },
    fetchImpl,
  });

  await assert.rejects(
    () => provider.chat({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
    (err: Error & { code?: string }) => err.code === 'PROVIDER_UNAVAILABLE',
  );
});

test('meter transport: pays through the payer and reads x_meter provenance', async () => {
  const payerCalls: string[] = [];
  const payer: Payer = {
    kind: 'mock',
    accountId: '0.0.6666',
    async fetch(url) {
      payerCalls.push(url);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'paid answer' } }],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
          x_meter: {
            paymentTxId: 'mock-tx-1',
            hcsTxId: 'hcs-1',
            upstream: { requestId: 'req-meter-9', teeVerified: true },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  };

  const provider = new OpenAICompatibleProvider({
    id: '0g',
    baseUrl: 'https://router-api.0g.ai/v1',
    defaultModel: '0gm-1.0-35b-a3b',
    transport: 'x402-meter',
    meter: { url: 'http://localhost:8402/meter/v1/chat/completions', payer },
    capabilities: ['tools', 'json'],
    priceUsdPerMTok: { input: 0.2, output: 0.8 },
  });

  const res = await provider.chat({ model: '0gm-1.0-35b-a3b', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(payerCalls[0], 'http://localhost:8402/meter/v1/chat/completions');
  assert.equal(res.text, 'paid answer');
  assert.equal(res.provenance.paymentTxId, 'mock-tx-1');
  assert.equal(res.provenance.hcsTxId, 'hcs-1');
  assert.equal(res.provenance.requestId, 'req-meter-9');
});

test('tools are declared only when the model supports them, else passed as a JSON prompt', async () => {
  const { fetchImpl, captured } = fakeFetch({
    choices: [{ message: { content: 'ok' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
  const base = {
    id: 'local' as const,
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'qwen2.5:7b-instruct',
    transport: 'direct' as const,
    priceUsdPerMTok: { input: 0, output: 0 },
    fetchImpl,
  };
  const tools = [
    { name: 'get_songs', description: 'list songs', inputSchema: { type: 'object', properties: {} } },
  ];

  const withTools = new OpenAICompatibleProvider({ ...base, capabilities: ['tools'] });
  await withTools.chat({ model: 'x', messages: [{ role: 'user', content: 'hi' }], tools });
  assert.ok(JSON.parse(String(captured[0].init.body)).tools);

  const withoutTools = new OpenAICompatibleProvider({ ...base, capabilities: ['json'] });
  await withoutTools.chat({ model: 'x', messages: [{ role: 'user', content: 'hi' }], tools });
  const body = JSON.parse(String(captured[1].init.body));
  assert.equal(body.tools, undefined);
  assert.match(JSON.stringify(body.messages), /get_songs/);
});

test('anthropic: system is top-level and tool output becomes a tool_result block', async () => {
  const { fetchImpl, captured } = fakeFetch({
    content: [
      { type: 'text', text: 'Here is the answer.' },
      { type: 'tool_use', id: 'toolu_1', name: 'get_songs', input: {} },
    ],
    usage: { input_tokens: 90, output_tokens: 12 },
  });
  const provider = new AnthropicProvider({
    apiKey: 'sk-ant',
    defaultModel: 'claude-sonnet-4-5',
    capabilities: ['tools'],
    priceUsdPerMTok: { input: 3, output: 15 },
    fetchImpl,
  });

  const res = await provider.chat({
    model: 'claude-sonnet-4-5',
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'songs?' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_1', name: 'get_songs', input: {} }] },
      { role: 'tool', toolCallId: 'toolu_1', toolName: 'get_songs', content: '["Monsoon Ragas"]' },
    ],
    tools: [{ name: 'get_songs', description: 'list', inputSchema: { type: 'object', properties: {} } }],
    maxTokens: 200,
  });

  const body = JSON.parse(String(captured[0].init.body));
  assert.equal(body.system, 'be brief');
  assert.equal(body.messages[0].role, 'user');
  assert.equal(body.max_tokens, 200);
  // the assistant tool_use and the tool_result must both be present
  assert.ok(JSON.stringify(body.messages).includes('tool_use'));
  assert.ok(JSON.stringify(body.messages).includes('tool_result'));

  assert.equal(res.text, 'Here is the answer.');
  assert.equal(res.toolCalls?.[0].name, 'get_songs');
  assert.equal(res.provenance.teeVerified, null, 'no attestation must be reported as null');
});

test('gemini: uses contents/parts and functionResponse for tool output', async () => {
  const { fetchImpl, captured } = fakeFetch({
    candidates: [{ content: { parts: [{ text: 'Shaka plays ragas.' }] } }],
    usageMetadata: { promptTokenCount: 70, candidatesTokenCount: 9 },
  });
  const provider = new GoogleProvider({
    apiKey: 'g-key',
    defaultModel: 'gemini-2.5-flash',
    capabilities: ['tools', 'json'],
    priceUsdPerMTok: { input: 0.3, output: 2.5 },
    fetchImpl,
  });

  const res = await provider.chat({
    model: 'gemini-2.5-flash',
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'songs?' },
      { role: 'tool', toolCallId: 't1', toolName: 'get_songs', content: '["Monsoon Ragas"]' },
    ],
    maxTokens: 120,
  });

  assert.match(captured[0].url, /models\/gemini-2\.5-flash:generateContent\?key=g-key/);
  const body = JSON.parse(String(captured[0].init.body));
  assert.equal(body.systemInstruction.parts[0].text, 'be brief');
  assert.ok(JSON.stringify(body.contents).includes('functionResponse'));
  assert.equal(res.text, 'Shaka plays ragas.');
  assert.equal(res.usage.inputTokens, 70);
});

test('estimateCost scales with maxTokens and refuses to be zero for a paid provider', () => {
  const provider = new OpenAICompatibleProvider({
    id: '0g',
    baseUrl: 'https://router-api.0g.ai/v1',
    defaultModel: 'm',
    transport: 'direct',
    capabilities: ['tools'],
    priceUsdPerMTok: { input: 0.2, output: 0.8 },
    fetchImpl: fakeFetch({}).fetchImpl,
  });
  const cheap = provider.estimateCost({ model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });
  const dear = provider.estimateCost({ model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 1000 });
  assert.ok(cheap > 0);
  assert.ok(dear > cheap);
});

test('meter transport: a 403 SPEND_CAP_EXCEEDED keeps its code through the adapter', async () => {
  const payer: Payer = {
    kind: 'mock',
    async fetch() {
      return new Response(JSON.stringify({ error: 'SPEND_CAP_EXCEEDED', code: 'SPEND_CAP_EXCEEDED' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
  const provider = new OpenAICompatibleProvider({
    id: '0g',
    baseUrl: 'https://router-api.0g.ai/v1',
    defaultModel: 'm',
    transport: 'x402-meter',
    meter: { url: 'http://localhost:8402/meter/v1/chat/completions', payer },
    capabilities: ['tools'],
    priceUsdPerMTok: { input: 0.2, output: 0.8 },
  });
  await assert.rejects(
    () => provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    (err: Error & { code?: string }) => err.code === 'SPEND_CAP_EXCEEDED',
  );
});
