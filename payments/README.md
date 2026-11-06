# 💸 payments — x402 on Hedera

Two x402-protected endpoints, one split, one audit log.

| Endpoint | Who pays | Price | Goes to |
|---|---|---|---|
| `POST /ask` | a fan (or a fan's agent) | 0.10 USDC | the **artist's** account |
| `POST /meter/v1/chat/completions` | the artist's **steward agent** | 0.002 USDC | agent compute account |

The second one is the important one: it is an OpenAI-compatible inference proxy
that charges per call, so the agent pays for its own thinking out of its own
wallet with no human in the loop.

```
fan ──POST /ask (402)──► payments ──► steward ──POST /meter/… (402)──► meter ──► 0G Router
         pay 0.10                │        pay 0.002                  │
         settle ◄────────────────┘        settle ◄───────────────────┘
            │                                 │
            └── 96.31% artist / 3.69% agent ───┴── HCS spend topic (audit)
```

## Quickstart — dev mode (no keys, nothing on chain)

```bash
npm install
cp .env.example .env          # PAYMENTS_MODE=dev
npm start                     # :8402
npm test                      # 12 tests
```

`PAYMENTS_MODE=dev` uses a **mock gate**: 402 challenges are protocol-shaped and
every settlement id is `mock-…`. Nothing touches Hedera. This is what the test
suite and the offline demo run against.

## Live mode (Hedera testnet, real settlement)

```bash
cp .env.example .env
# PAYMENTS_MODE=live and:
#   HEDERA_ARTIST_ACCOUNT_ID / HEDERA_COMPUTE_ACCOUNT_ID  (testnet, ECDSA)
#   HEDERA_AGENT_PRIVATE_KEY                             (compute account key — HCS + demo payer)
#   HCS_SPEND_TOPIC_ID                                   (create a topic in the portal)
npm run token:create     # optional: OSOTIP token with the 3.69% HTS custom fee
npm start
```

Settlement uses a facilitator from the Hedera docs (default
`https://x402.org/facilitator`, which advertises `hedera:testnet`). The
facilitator pays the network fee, so the paying agent never needs HBAR for gas.
Boot fails loudly if the facilitator does not advertise `hedera:testnet` — that
is better than discovering it during the demo.

**Record every settled transaction id in [`docs/TX-PROOF.md`](../docs/TX-PROOF.md).**
The submission needs at least one; the demo video needs the HashScan link.

## Architecture (5 files that matter)

| File | Job |
|---|---|
| `src/gate/types.ts` | the payment gate interface + the dev mock gate. The rest of the service imports *only* this. |
| `src/gate/hedera.ts` | live gate: `/supported`, `/verify`, `/settle` against a facilitator. Loaded lazily, so dev mode needs no x402 packages. |
| `src/meter.ts` | the pay-per-call inference proxy. Budget check → 402 → verify → infer → settle → log. |
| `src/paywall.ts` | `/ask`: 402 → verify → steward answers → settle → respond with proof. |
| `src/split.ts` | the 96.31 / 3.69 arithmetic, integer atomic units, remainder to the artist. |

Plus `src/spend-log.ts`: one line per paid call, and budget totals are a reduce
over that file — one set of books, not two.

## Three decisions worth knowing

**1. Settlement happens last.** `verify → serve → settle`. If the steward is down
or the model fails, the fan is not charged and the response says
`"settled": false`. Standard x402 allows handler-then-settle; we rely on it.

**2. The budget gate runs before the quote.** When the agent is out of compute
budget the meter returns `403 SPEND_CAP_EXCEEDED` and *no payment requirements*,
so there is no way to take money for an answer that will never be generated.
Caps: per call, per hour, total (`BUDGET_*`).

**3. The split needs the asset, not the protocol.** One x402 `exact` payment is
one transfer to one `payTo`. So the 3.69% is enforced by an **HTS fractional
custom fee** on the tip token (`scripts/create-tip-token.ts`: 369/10000 → compute
account), and the artist receives the rest in the same atomic transfer. Before
the token exists, the API still reports the exact split in `/split-preview` and
on every `/ask` response so the maths is verifiable.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /health` | mode, gate, network, asset, split |
| `GET /.well-known/x402` | machine-readable discovery: prices, payees, split |
| `GET /meter/info` | price + budget + upstream model, for the steward |
| `GET /meter/v1/models` | free catalog passthrough |
| `GET /ledger/recent?n=20` | the spend log tail + totals |
| `GET /split-preview?amount=1` | 96.31 / 3.69 for any amount |

## Sponsor mapping

- **Hedera — AI Agents That Pay: x402.** x402 endpoints settling on testnet;
  an agent completes a paid request end to end with no human approval;
  spending controls (budget gate); HCS topic as a tamper-evident spend log;
  HTS custom fee to split revenue.
- **0G — Build with 0G Private Computer.** Every `/meter` response carries the
  upstream `x_0g_trace.request_id` and `tee_verified`, bound 1:1 to the payment
  transaction id.

Not done here: recurring/subscription payments, and multi-agent negotiation
(`A2A`/`ACP`) before payment. Both are stretch, both are listed in the ideation
doc rather than half-built.
