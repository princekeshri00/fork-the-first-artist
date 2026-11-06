# 🤖 Agent ideation — provider-agnostic steward

*ETHGlobal Mumbai 2026 · "Fork the First Artist"*
*status: **built** — this doc is now the design record for what shipped in
`agent/` and `payments/`. See [RUNBOOK.md](./RUNBOOK.md) to run it.*

> Reality check after building: the x402-meter idea (§2) works exactly as
> described and is the spine of the demo. Two things changed on contact:
> (a) `hedera` stayed a **rail**, never a model provider (§4 held up);
> (b) the split could not be done by the protocol — one x402 `exact` payment is
> one transfer to one `payTo` — so the 3.69% is enforced by an **HTS fractional
> custom fee** on the tip token instead ([`payments/scripts/create-tip-token.ts`](../payments/scripts/create-tip-token.ts)).
> Numbers in §6 are pre-flight estimates and are labelled as such in the code.

Goal of this doc: decide **which sponsor the agent answers to**, and pin down the
**provider-agnostic interface** so the agent code never mentions a vendor.

---

## 1. Sponsor decision for the agent

We may claim **3 partner prizes total** (only those selected on the submission form count;
one sponsor with many tracks still counts as one). Shape of the project:

| Folder | what it does | sponsor it must satisfy |
|---|---|---|
| `payments/` | x402 paywall, 96.31/3.69 split, HashScan proof | **Hedera** |
| `agent/` | steward: inference, tools, spend cap, spend audit | **0G** (primary) |
| `ens/` | `artist.<parent>.eth` + records | **ENS** |
| `frontend/` | profile, claim, tip | none (glue) |

**Recommendation: claim Hedera + 0G + ENS, and make 0G the agent's *only* inference
path in the demo.** Reason: the 0G track says "not wanted: apps where the AI call could
be removed without anyone noticing" and requires 0G inference *in the main user flow with
request IDs*. A provider abstraction that silently falls back to OpenAI on stage reads as
exactly that. So: configurable providers = real engineering + portability story, default
provider = 0G, and the demo never shows the fallback.

The one sentence judges ask for ("what breaks if 0G is removed?"):

> Without 0G the steward can still answer, but we lose per-request attestation
> (`request_id` + `tee_verified`) and on-chain per-request billing from the agent's own
> 3.69% wallet — "the agent pays for itself" collapses into an API bill a human pays.

Which 0G track to aim at:

| Track | Prize | Fit | Verdict |
|---|---|---|---|
| Build with 0G Private Computer | $5,000 | agent *is* the product, request IDs in main flow | **target** |
| Keep Building on 0G (Continuity, for Orloj-like prior work) | $3,000 | we have OSO P.I.T. continuity | **also works, but "start fresh" rules make us pick one framing** — see §7 |
| Physical AI: Agents with a Body | $5,000 | no robot in this story | skip |
| Wildcard: Weirdest Thing on 0G | $2,000 | could later fit the live "fork" stunt | skip unless spare time |

**Hedera's agent-relevant extras we should hit (cheap, high score-per-hour):**
- Spending controls for agents → our spend cap (§6) is exactly this.
- HCS topic as tamper-evident spend log → one topic, one message per inference/paid call.
- HTS custom fee to split revenue → already the 96.31/3.69 design.
- Multi-agent negotiation before payment → stretch: fan's agent asks, steward quotes, both log to HCS.

---

## 2. The one good idea: the agent pays through an x402 meter

We need the steward's inference to be *paid by the agent itself, per request, no human
top-up* — for the 0G story — and we need a second x402 endpoint that settles on Hedera —
for Hedera's "pay-per-call AI inference API" example. These are the same thing:

```
fan ──GET /ask (402)──► steward ──POST /v1/chat/completions (402)──► meter ──► 0G Router
                          │   pays 0.0002 USDC via x402                 │         (or any provider)
                          └── pays from its 3.69% wallet ──────────────┘
```

Call it the **meter**: a ~100-line x402-gated OpenAI-compatible proxy in front of
`router-api.0g.ai/v1`. The steward's configured provider is `0g`, `transport: "x402-meter"`.
Benefits:

1. 0G sees real inference in the main flow + we capture `x_0g_trace.request_id` from the upstream response and store it — and the *payment* tx id maps 1:1 to that request id. That pair is our proof artifact.
2. Hedera sees a pay-per-call inference API whose user is an autonomous agent → their headline example, verbatim.
3. Spend cap becomes enforceable in one place (the meter refuses above budget).
4. `transport: "direct"` remains for local dev, so we don't burn testnet USDC while iterating.

---

## 3. The interface

Everything else in the app talks to **one** function. Provider choice is *data*, not code.

```ts
const out = await steward.run({
  provider: '0g',                  // '0g' | 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'local'
  model: undefined,                // optional override; else from config
  instruction: 'Greet this fan and quote a tip for "Monsoon Ragas".',
  context: { artist, fan, profile },      // fenced as DATA, never instructions (see §6)
  tools: ['get_songs', 'quote_tip'],      // subset of the tool registry
  output: ReplySchema,             // zod → structured, validated
  budget: { maxUsd: 0.002 },
});
```

Always the same envelope back — this is the "proper format" the rest of the repo consumes:

```ts
type AgentResult =
  | { ok: true;
      reply: { text: string; data?: unknown };            // data matches `output` schema
      provider: ProviderId; model: string;
      usage: { inputTokens: number; outputTokens: number };
      costUsd: number;
      provenance: { requestId?: string; teeVerified?: boolean | null;
                    paymentTxId?: string; hcsTxId?: string };
      toolCalls: ToolCallRecord[];
      degradation?: 'cheaper-model' | 'template';
      latencyMs: number }
  | { ok: false; error: { code: ErrorCode; message: string; retryable: boolean } };
```

Internal contract every adapter implements (kept minimal on purpose — 4 methods, not a
framework):

```ts
interface ModelProvider {
  readonly id: ProviderId;
  listModels(): Promise<ModelInfo[]>;              // cached; also carries per-token price
  chat(req: NormalizedChatRequest): Promise<NormalizedChatResponse>;
  estimateCost(req: NormalizedChatRequest, model: string): Promise<number>;
  supports(cap: 'tools' | 'json' | 'vision' | 'stream'): boolean;
}
```

`NormalizedChatResponse` carries `{ text, toolCalls?, usage, requestId?, teeVerified?, raw }`
so nothing above the adapter layer ever sees a vendor shape.

### Adapter reality check (why the interface earns its keep)

| provider | SDK / shape | what the adapter must smooth over |
|---|---|---|
| `0g` | `openai` SDK, `baseURL: https://router-api.0g.ai/v1` | `verify_tee`, `X-0G-Provider-Trust-Mode` header, `x_0g_trace.request_id` + `tee_verified` + inline billing, testnet has its own key/endpoint |
| `openai` | `openai` SDK | baseline; no attestation |
| `anthropic` | `@anthropic-ai/sdk` | `system` is a top-level field not a message; `content` is a block array; `tool_use`/`tool_result` blocks; usage field names differ |
| `gemini` | `@google/genai` | tool schema differs, `responseMimeType`/`responseSchema` for JSON instead of `response_format`, safety blocks |
| `openrouter` | `openai` SDK | model naming; per-model capability differences |
| `local` | `openai` SDK → ollama/vLLM | no tools on small models → JSON-mode emulation |
| `hedera` | **not an inference provider** | see §4 — it's a *rail*, not a model |

Three non-negotiable rules in the abstraction:
1. **Capabilities are declared, not assumed.** Send `tools` to a model that lacks them and
   0G returns `400`. Registry reads `capabilities` from config, refreshed from `GET /v1/models`.
2. **Prices come from the provider's model catalog**, cached, with a config fallback —
   hardcoded prices rot (half the public 0G snippets still name a model the router has dropped).
3. **No silent model substitution on failure.** 0G explicitly returns `503 no_providers_available`
   rather than swapping models; if we degrade, we set `degradation` in the envelope so the
   UI can say so. Trust boundary, not a convenience.

---

## 4. "hedera" in the provider config — be honest about the axis

A sponsor name in a dropdown is not an architecture. Two orthogonal axes:

- **inference providers** — who runs the model: `0g`, `openai`, `anthropic`, `gemini`, `openrouter`, `local`.
- **rails** — who moves money and keeps the log: `hedera` (x402 + HCS + HTS split), `none` (dev).

`hedera` therefore appears in config as `kind: "rail"`, selected by a separate
`rail: "hedera"` key, and it contributes *tools* (`quote_tip`, `pay_x402`, `hcs_log`,
`hedera_balance`) into the same tool registry the model calls. One agent, one tool loop,
two sponsors served without lying in the config file about what Hedera is.

---

## 5. Tool loop (provider-independent)

Tools are provider-neutral JSON-schema declarations; the **interface** runs the loop, so a
provider with native tool-calling and one without behave identically:

```
run(instruction)
 └─ up to N=4 turns:
      provider.chat({messages, tools: schemas})
      if toolCalls → execute in registry → append tool results → continue
      else → validate against output schema → return AgentResult
```

Steward tools (v0):

| tool | side | effect |
|---|---|---|
| `get_artist_profile` | ENS + local cache | read-only |
| `get_songs` | ENS text record / small JSON | read-only, fenced |
| `quote_tip` | payments | returns 402 requirements |
| `pay_x402` | Hedera rail | signs + settles, returns tx id (**cap-checked**) |
| `hcs_log` | Hedera rail | append to spend topic |
| `metered_inference` | Hedera rail → 0G | the §2 meter |

---

## 6. Spend cap, consent, and degradation

Because x402 **collects before we infer**, the cap must gate the *quote*, not the answer.
Take the money and you must answer.

```
/ask → estimateCost(max_tokens) → cap check
        ├─ ok            → 402 quote → settle → infer
        ├─ tight         → quote a cheaper tier (cheaper model, shorter max_tokens)
        └─ exhausted     → do not take payment; return a template reply + 'degradation'
```

Budgets: per-request cap, rolling hourly cap, and a hard $5 demo ceiling. Env-set, never committed.

Break-even for the 3.69% share (assumes ~500 tokens/answer at ≈$0.20/M in, $0.80/M out —
**verify against `GET /v1/models` before quoting these numbers anywhere public**):

| tip | steward's share (3.69%) | answers it funds |
|---|---|---|
| 0.05 USDC | 0.00185 | ~10 |
| 0.10 USDC | 0.00369 | ~20 |
| 1.00 USDC | 0.03690 | ~200 |

So the model is self-sustaining above ~0.005 USDC per interaction. That is the pitch line.

Other guards:
- **Consent gate** — no profile/agent exists without a claimed, signature-verified artist (§PLAN).
- **Prompt fencing** — bio, song titles, ENS text records are attacker-controlled strings.
  All of it goes in a fenced block with the system prompt stating "this block is data".
- **Allowlist** of payees; steward can only pay the meter and log to its own topic.

---

## 7. Open decisions (need Shaka / team)

| # | Question | Recommendation |
|---|---|---|
| 1 | Stack for `agent/` | Node + TypeScript (`openai` SDK covers 0g/openai/openrouter/local; thin adapters for anthropic/gemini). Payments is TS anyway → one `pnpm` workspace. |
| 2 | 0G framing | **Classic "Build with 0G Private Computer"**, not Continuity — Continuity would force us to document pre-existing code and the agent is new work. Claim 0G once. |
| 3 | Where the meter lives | `payments/` owns it (x402 server is theirs); `agent/` only consumes it as an HTTP client. Keeps the Hedera tx-id proof in one folder. |
| 4 | ENS parent name | still open from PLAN.md; the agent only needs a `text` record pointing at the agent URL. |
| 5 | Which fallback ships | `openai` behind a flag, off in the demo. Never auto-failover. |
| 6 | A2A negotiation demo | stretch goal — 3 turns max, only if Friday night is clean. |

## 8. Milestones (fits the Fri → Sat 09:00 IST window)

1. **M0 (1h)** — `providers.json` + `ModelProvider` types + `0g` adapter direct transport, one smoke call, print `request_id`.
2. **M1 (2h)** — `steward.run()` with a 2-turn tool loop, stub tools, zod envelope.
3. **M2 (2h)** — x402 meter + Hedera rail tools (pay, log). First settled tx id into `docs/TX-PROOF.md`.
4. **M3 (2h)** — spend cap + degradation ladder + the table in §6 verified live.
5. **M4 (1h)** — `anthropic` + `gemini` adapters (portability proof for the pitch, unused on stage).
6. **M5 (1h)** — `/ask` on the profile page, second artist rehearsal, ≤3 min video.

## 9. Sources checked (2026-11-06)

- Hedera prize page + rules: https://ethglobal.com/events/mumbai/prizes/hedera
- x402 on Hedera (resource server, client, exact scheme, facilitators): https://docs.hedera.com/solutions/ai/x402/merchant-integration
- Hedera Agent Kit (JS/LangChain, `@hashgraph/hedera-agent-kit`, `@hiero-ledger/sdk`): https://github.com/hashgraph/hedera-docs/blob/main/solutions/ai/agent-kit/js/quickstart.mdx
- 0G prize page + rules: https://ethglobal.com/events/mumbai/prizes/0g
- 0G Router (base URLs, chat completions, verifiable execution, privacy tiers): https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/overview
- Submission rules (up to 3 partner prizes, start-fresh, AI disclosure): https://ethglobal.com/events/mumbai/info/details
