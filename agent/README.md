# 🤖 agent — the artist steward

One function is the whole agent:

```ts
const out = await steward.run({
  provider: '0g',                                  // or openai / anthropic / gemini / local
  instruction: 'Greet this fan and quote a tip.',
  tools: ['get_artist_profile', 'get_songs', 'quote_tip'],
  output: ReplySchema,                             // optional structured output
  budget: { maxUsd: 0.002 },
});
```

```ts
// always this envelope — the caller never sees a vendor shape
{
  ok: true,
  reply: { text, data? },
  provider: '0g', model: '0gm-1.0-35b-a3b',
  usage: { inputTokens, outputTokens }, costUsd,
  provenance: { requestId, teeVerified, paymentTxId, hcsTxId },   // ← the proof
  toolCalls: [...], degradation?, latencyMs
}
```

Provider choice is **data** (`config/providers.json`), not code. The rest of the
repo imports `createSteward` and nothing else.

## Quickstart

```bash
npm install
cp .env.example .env
npm test          # 25 tests, no keys, no network
npm start         # :8403  → /health, /agent-card, POST /ask
npm run smoke     # one real call, prints the 0G request id
npm run demo      # full fan→artist→meter loop (needs payments/ running)
```

Without any keys the whole loop still runs: the 0G adapter reaches the
**meter** in `payments/`, and the meter holds the upstream key. `STEWARD_MODE=fake`
switches to an offline deterministic provider for UI work.

## Files

| File | Job |
|---|---|
| `src/steward.ts` | the interface implementation: consent → affordability → provider → tool loop → schema → record spend |
| `src/types.ts` | `ModelProvider`, `AgentResult`, `AgentRunRequest`. No vendor types above `src/providers/`. |
| `src/providers/openai-compatible.ts` | 0G, OpenAI, OpenRouter, local. Owns `verify_tee`, the trust-mode header and `x_0g_trace`. |
| `src/providers/anthropic.ts` / `google.ts` | the two that do **not** speak OpenAI (top-level `system`, `tool_result` blocks, `functionDeclarations`) |
| `src/providers/registry.ts` | provider id → adapter. Missing credentials = **unavailable**, never a silent fallback. |
| `src/budget.ts` | three ceilings, persisted to jsonl, checked *before* any network call |
| `src/rails/payer.ts` | the wallet: pays the meter via x402 (`setSpendControls` as a second line of defence) |
| `src/fence.ts` | every artist fact reaches the model as fenced DATA, never as instructions |
| `src/tools.ts` | tool registry (provider-neutral) + `get_artist_profile`, `get_songs`, `quote_tip` |

## Why the abstraction earns its keep

- **0G** — `verify_tee`, `X-0G-Provider-Trust-Mode`, and `x_0g_trace.request_id`
  + `tee_verified` live in one adapter.
- **Anthropic** — `system` is a top-level field; tool output is a `tool_result`
  block inside a user message; `max_tokens` is required.
- **Gemini** — `contents`/`parts`, `functionDeclarations`, JSON via
  `responseMimeType`, model name in the URL.
- **Tools to a model that can't call them** — the adapter falls back to putting
  the JSON schemas in the prompt; the *steward* runs the loop, so behaviour is
  identical either way.

Three non-negotiables:

1. **Capabilities are declared, not assumed.** Sending `tools` to a model that
   lacks them returns `400` on 0G.
2. **No silent model substitution.** 0G returns `503 no_providers_available`
   rather than swapping models; we do the same, and any degradation we *do*
   choose is reported in `degradation`.
3. **Prices come from config/model catalog, not from hopes.** `priceFallbackUsdPerMTok`
   is a pre-flight estimate; real cost comes from `usage`.

## The degradation ladder

The per-request estimate is checked against the budget **before** the first
network call:

```
full tier (maxTokens 400) → halved maxTokens → cheaper model (if fallback enabled) → template reply
```

A `template-reply` is built from the artist's own data with no model call — it
costs $0, still answers something true, and sets `degradation` so the UI can say
so. This is the fan-facing half of the spend cap; the meter's 403 is the
agent-facing half.

## Sponsor mapping

- **0G — Build with 0G Private Computer.** 0G is the default and only inference
  path in the demo (`fallback.enabled: false` on purpose). Every response carries
  a request id and TEE verification, bound to a payment tx id by the meter.
- **Hedera.** The steward is the autonomous payer: it signs an x402 transfer for
  every inference call, under two independent sets of spending controls.

**What breaks if 0G is removed (the sentence the track asks for):** the steward
can still answer, but we lose per-request attestation (`request_id` +
`tee_verified`) and the ability to bill each model run through our own x402
meter — "the agent pays for itself" collapses into an API invoice a human pays.

## Known limits (honest list)

- `stream()` exists in the original interface sketch but is **not** implemented;
  `run()` is the only path. Streaming through a 402 paywall needs the payment to
  settle before the first token, which changes the economics — out of scope.
- Per-token price in `providers.json` is a fallback, not a live quote. Verify
  against `GET /v1/models` before quoting a number in public.
- No cross-provider retry. If 0G is down, the steward degrades; it does not
  quietly re-answer on another vendor.
