# @overdraft-protocol/mpx

A transport-safe, in-band payment extension for MCP servers.

Standard MCP payment approaches using HTTP headers (e.g. x402's `X-PAYMENT-REQUIRED`) are invisible to agents: the MCP client transport swallows non-2xx HTTP responses before the JSON-RPC layer and never exposes arbitrary response headers to the model. This package implements the **MCP Payments Extension (MPX)** — a payment handshake that lives entirely inside JSON-RPC message bodies, works identically over stdio and Streamable HTTP, and is visible to any MCP-capable agent.

## The protocol

All payment signaling travels in `_meta` fields on JSON-RPC messages, using the reserved namespace `mpx/v1.*`. No HTTP headers or status codes are used.

### 1. Challenge (server → agent)

When a tool is called without a valid payment authorization, the server returns an `isError` result:

```json
{
  "isError": true,
  "content": [{ "type": "text", "text": "payment_required: ... (1.50 USDC). Retry with _meta authorization." }],
  "_meta": {
    "mpx/v1.challenge": {
      "mpxVersion": 1,
      "paymentRequestId": "<uuid>",
      "expiresAt": "<ISO-8601>",
      "reason": { "tool": "<tool-name>", "description": "<human-readable purpose>" },
      "amount": { "value": "1.50", "currency": "USDC", "decimals": 6 },
      "accepts": [
        {
          "rail": "x402-evm-exact",
          "payTo": "<payee address>",
          "requirements": { "...": "rail-specific requirements" }
        }
      ]
    }
  }
}
```

The `content` text duplicates the key facts so agents that don't read `_meta` still see a meaningful error. Machine clients read `_meta` for the structured challenge.

### 2. Authorization (agent → server)

The agent re-issues the **same** `tools/call` (identical arguments) and adds the signed authorization to `params._meta`:

```json
{
  "method": "tools/call",
  "params": {
    "name": "<tool>",
    "arguments": { "...": "unchanged" },
    "_meta": {
      "mpx/v1.authorization": {
        "mpxVersion": 1,
        "paymentRequestId": "<uuid from challenge>",
        "rail": "x402-evm-exact",
        "payload": { "...": "rail-specific signed payload" }
      }
    }
  }
}
```

### 3. Receipt (server → agent)

On success, the result carries a receipt in `result._meta`:

```json
{
  "_meta": {
    "mpx/v1.receipt": {
      "mpxVersion": 1,
      "paymentRequestId": "<uuid>",
      "rail": "x402-evm-exact",
      "settlementRef": "<rail-specific reference>",
      "amount": { "value": "1.50", "currency": "USDC", "decimals": 6 },
      "settledAt": "<ISO-8601>"
    }
  }
}
```

### Security

- **Single-use on success** — each `paymentRequestId` is consumed only after the handler completes successfully. Verification and handler failures release the challenge so the agent can retry with the same signed authorization until `expiresAt`. A replay after success is rejected even though the authorization still verifies cryptographically.
- **Expiry** — challenges expire (default 300 seconds). The server rejects authorizations after `expiresAt`.
- **Verify before settle** — the package verifies the authorization before calling the tool handler. The handler's `settle()` callback moves funds *after* any application-level validation (e.g. content signatures). Money never moves on an invalid request.
- **Conditional gating** — `intent()` can return `null` to skip the challenge entirely for calls that don't require payment.

## Why `isError: true` and not a proper JSON-RPC error?

A payment challenge semantically isn't a tool failure — it's a mid-execution pause
requesting input. A JSON-RPC `error` object with a fixed code and structured `data`
would be the right shape, but the installed MCP SDK (`@modelcontextprotocol/sdk`
v1.29.0, current latest) catches all `McpError` throws from tool handlers and
flattens them to a plain `isError` text result, **dropping `data` entirely** — except
for the single special code `UrlElicitationRequired`.

The `isError: true` + `_meta` approach is therefore the only channel that reliably
carries structured challenge data to the caller today. It is also consistent with the
MCP spec, which says tool-originated errors should live in `isError` results so the
LLM can see and react to them.

**The long-term path is MCP elicitation (`elicitation/create`).** When a
`PaymentAuthorizationRequired` error code is added to the SDK (following the same
carve-out as `UrlElicitationRequired`), `withPayment` can be updated to throw it
instead of returning an `isError` result. No tool handler or marketplace wiring
changes — the switch is entirely inside the wrapper. See the [protocol design
notes](https://github.com/overdraft-protocol/overdraft-marketplace/blob/main/docs/mcp-payment-protocol.md)
for a detailed analysis of why elicitation is not yet feasible.

## Installation

```bash
npm install @overdraft-protocol/mpx
```

The x402-evm rail additionally requires `x402` and `viem` as peer dependencies:

```bash
npm install x402 viem
```

## Usage

### 1. Create the extension

```ts
import { createPaymentExtension, InMemoryChallengeStore } from '@overdraft-protocol/mpx';

import { consolePaymentLogger } from '@overdraft-protocol/mpx';

const withPayment = createPaymentExtension({
  rails: [myRail],           // PaymentRail[] — see Implementing a rail below
  store: new InMemoryChallengeStore(),  // or your durable ChallengeStore
  settlement: mySettlement,  // SettlementStrategy — what "settle" does in your app
  challengeTtlSeconds: 300,  // optional, default 300
  logger: consolePaymentLogger, // optional, default no-op — see Logging below
});
```

### 2. Wrap tool handlers

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const server = new McpServer({ name: 'my-server', version: '1.0.0' });

server.registerTool(
  'my_paid_tool',
  { inputSchema: { amount_usdc: z.number() } },
  withPayment(
    {
      tool: 'my_paid_tool',
      description: 'Service description shown in the challenge',
      intent(args) {
        return {
          amount: { value: String(args.amount_usdc), currency: 'USDC', decimals: 6 },
          payTo: '0x...',
          binding: { myAppData: 'for settlement' },
        };
      },
    },
    async (args, extra) => {
      // 1. Do your application validation here (content sig, nonce, etc.)
      // 2. Call settle() after validation passes — this is when money moves.
      const receipt = await extra.settle();
      // extra.verifiedPayment is also available for accessing the raw rail payload.
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    },
  ),
);
```

### 3. Argument fallback for agents that cannot set `params._meta`

Standard LLM harnesses only let the model control `arguments` — `params._meta` is populated by the client host. `withPayment` automatically checks `args.payment_authorization` if `_meta` does not contain an authorization. The value must be a JSON string of the authorization object, or the object itself:

```json
{ "arguments": { "..": "..", "payment_authorization": "{\"mpxVersion\":1,\"paymentRequestId\":\"...\",\"rail\":\"x402-evm-exact\",\"payload\":{...}}" } }
```

To make `payment_authorization` reachable in the handler (Zod strips unknown fields), declare it in the tool's `inputSchema`:

```ts
inputSchema: {
  amount_usdc: z.number(),
  payment_authorization: z.string().optional().describe(
    'JSON-encoded MPX authorization. Alternative to params._meta["mpx/v1.authorization"].'
  ),
}
```

`params._meta` always takes priority if both are present.

### 4. Conditional gating

Return `null` from `intent()` to skip payment for calls that don't require it:

```ts
{
  tool: 'file_dispute',
  description: 'Buyer dispute stake',
  async intent(args) {
    const needsPayment = await checkIfPaymentRequired(args.bid_id);
    if (!needsPayment) return null;  // no challenge issued, handler called directly
    return { amount: ..., payTo: ..., binding: ... };
  },
}
```

`intent()` may be synchronous or async.

## Implementing a rail

A `PaymentRail` has two **required** responsibilities: building the offer shown in the challenge, and verifying a signed authorization. It never settles — settlement is an injected `SettlementStrategy`. The core is fully rail-agnostic: it knows nothing about x402, EVM, cards, or any specific scheme.

```ts
import type { PaymentRail, PaymentIntent, VerifiedAuthorization } from '@overdraft-protocol/mpx';
import type { RailOffer } from '@overdraft-protocol/mpx';

const myRail: PaymentRail = {
  id: 'my-rail',

  buildOffer(intent: PaymentIntent): RailOffer {
    return {
      rail: 'my-rail',
      payTo: intent.payTo,
      requirements: {
        // rail-specific fields the payer needs to sign
        amount: intent.amount.value,
        currency: intent.amount.currency,
      },
    };
  },

  async verify(payload: unknown, offer: RailOffer): Promise<VerifiedAuthorization> {
    // verify the signed payload against the offer — throw if invalid
    const verified = await myVerifyFn(payload, offer);
    return {
      rail: 'my-rail',
      amount: { value: verified.amount, currency: 'USDC', decimals: 6 },
      raw: verified,  // passed to SettlementStrategy.settle()
    };
  },
};
```

### Optional rail hooks (agent ergonomics)

A rail can own its agent-facing details so they never leak into the core. All are optional — a rail that omits them still works, falling back to generic behaviour.

| Hook | Purpose |
|---|---|
| `coerceAuthorization(raw, hints)` | Normalize loosely-shaped agent input (the common case: a JSON blob in a `payment_authorization` argument because the harness can't write `params._meta`) into a schema-valid MPX authorization. The core tries each rail's coercer in order and keeps the first result that validates. |
| `retryInstructions(challenge)` | Rail-specific "how to pay" text appended to the challenge content. |
| `describePayload(payload)` | Redact a signed payload to a safe summary for the structured logger (never log secrets/signatures in full). |
| `authorizationArgDescription` | Description for the `payment_authorization` tool argument, surfaced by apps in their `inputSchema`. |

The cleanest reference implementation of all of these is the **`dev-signature` rail** ([`src/rails/dev-signature/index.ts`](src/rails/dev-signature/index.ts)) — it's zero-dependency and self-contained; copy it as a starting point.

## Bundled rails

Three rails ship with the package: [`dev-signature`](#dev-signature-reference--dev--ci) (zero-dependency, for dev/CI/reference), [`x402-evm-exact`](#x402-evm-exact-production-evm-stablecoins) (EVM stablecoin payments), and [`stripe-card`](#stripe-card-production-cards) (card payments via Stripe) — proof the core is rail-agnostic across both crypto and traditional rails.

### `dev-signature` (reference / dev / CI)

A zero-dependency rail at `@overdraft-protocol/mpx/rails/dev-signature`. "Authorization" is an HMAC-SHA256 over the offer terms with a shared secret, standing in for a wallet signature. It moves no real funds — use it for local development, demos, CI, and as the template for a real rail.

```ts
import { createDevSignatureRail, signDevAuthorization } from '@overdraft-protocol/mpx/rails/dev-signature';

const rail = createDevSignatureRail({ secret: process.env.DEV_PAY_SECRET! });
// A payer signs an offer with: signDevAuthorization(secret, challenge.accepts[0])
```

## Implementing a SettlementStrategy

```ts
import type { SettlementStrategy, VerifiedAuthorization, SettlementRef } from '@overdraft-protocol/mpx';

const mySettlement: SettlementStrategy = {
  async settle(verified: VerifiedAuthorization, binding: unknown): Promise<SettlementRef> {
    const b = binding as MyAppBinding;  // narrow the opaque binding here
    const ref = await myOnChainDeposit(verified.raw, b.orderId);
    return { ref };
  },
};
```

The `binding` parameter is exactly what you returned in `intent()`. The package treats it as opaque (`unknown`) so it never leaks application concerns into the generic layer.

## Implementing a ChallengeStore

The default `InMemoryChallengeStore` is suitable for single-process servers and tests. For production, implement `ChallengeStore` backed by a database:

```ts
import type { ChallengeStore, ChallengeRecord } from '@overdraft-protocol/mpx';

class MyDurableChallengeStore implements ChallengeStore {
  async save(record: ChallengeRecord): Promise<void> {
    await db.insert('payment_challenges', {
      id: record.challenge.paymentRequestId,
      expires_at: record.challenge.expiresAt,
      data: JSON.stringify(record),
    });
  }

  async get(paymentRequestId: string): Promise<ChallengeRecord | undefined> {
    const row = await db.get('payment_challenges', { id: paymentRequestId, consumed: false });
    if (!row || new Date(row.expires_at) < new Date()) return undefined;
    return JSON.parse(row.data);
  }

  async consume(paymentRequestId: string): Promise<ChallengeRecord | undefined> {
    // Must be atomic — only one caller should succeed
    const record = await this.get(paymentRequestId);
    if (!record) return undefined;
    await db.update('payment_challenges', { consumed: true }, { id: paymentRequestId });
    return record;
  }

  async release(record: ChallengeRecord): Promise<void> {
    if (new Date(record.challenge.expiresAt) < new Date()) return;
    await db.update('payment_challenges', { consumed: false, data: JSON.stringify(record) }, {
      id: record.challenge.paymentRequestId,
    });
  }
}
```

### x402-evm-exact (production EVM stablecoins)

A generic x402 EVM rail at the `@overdraft-protocol/mpx/rails/x402-evm` subpath. It requires `x402` and `viem` as peer dependencies, imported dynamically inside `verify()` so the core compiles and runs without them when this rail isn't used.

```ts
import { createX402EvmRail } from '@overdraft-protocol/mpx/rails/x402-evm';
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

const rail = createX402EvmRail({
  publicClient: createPublicClient({ chain: base, transport: http() }),
  assetAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',  // USDC on Base
  network: 'base',
  chainId: 8453,        // optional — included in offers for EIP-712 wallets
  currencySymbol: 'USDC',
  decimals: 6,
  // Optional EIP-712 token metadata (defaults shown — for USDC):
  assetName: 'USD Coin',
  assetVersion: '2',
});
```

This rail handles `buildOffer` (constructs x402 `PaymentRequirements`) and `verify` (`exact.evm.verify` — no on-chain action). It also wires the optional hooks (`coerceAuthorization`, `retryInstructions`, `describePayload`, `authorizationArgDescription`), exported individually as `coerceX402Authorization`, `x402RetryInstructions`, and `X402_AUTHORIZATION_ARG_DESCRIPTION`. Settlement is always injected: the rail has no `depositBid`, no `Escrow.sol`, no application knowledge.

### `stripe-card` (production cards)

A card rail at `@overdraft-protocol/mpx/rails/stripe`, proving the core works for traditional payments, not just crypto. `stripe` is an optional peer dependency, imported dynamically only when you pass a `secretKey` (inject a `stripe` client directly for tests).

```ts
import { createStripeRail } from '@overdraft-protocol/mpx/rails/stripe';

const rail = createStripeRail({
  secretKey: process.env.STRIPE_SECRET_KEY!,  // or: stripe: new Stripe(key)
  currency: 'usd',
  publishableKey: process.env.STRIPE_PUBLISHABLE_KEY, // optional, for client confirmation
});
```

It maps cleanly onto the small rail interface, and shows the two enhancements that make non-crypto rails possible:

1. **`buildOffer(intent)` is async** — it creates a Stripe PaymentIntent (`capture_method: 'manual'`) and returns its `id` + `client_secret` in `requirements`. (`buildOffer` may return a promise; the core awaits it.)
2. **`verify(payload, offer)`** — `payload` carries the confirmed PaymentIntent id; the rail retrieves it and asserts `status === 'requires_capture'` and that amount/currency match the offer. **No money moves** — an uncaptured authorization is just a hold.
3. **Settlement stays injected** — your `SettlementStrategy.settle()` calls `stripe.paymentIntents.capture(id)`. This is what preserves *verify-before-settle*: the hold is verified before the handler runs, capture happens only after the handler validates and calls `extra.settle()`.
4. **Optional hooks** are wired: `coerceAuthorization` accepts `{ paymentRequestId, paymentIntentId }` shorthand; `retryInstructions` tells the agent how to confirm the PaymentIntent; `describePayload` logs only the id.

The single invariant every rail must uphold: **`verify()` proves funds are committed but moves nothing; only the injected `settle()` moves money.** Everything else is rail-specific.

**Try it against Stripe test mode** — [`examples/stripe-integration.ts`](examples/stripe-integration.ts) runs the whole loop (create → confirm with a test card → verify → capture) against real Stripe test APIs:

```bash
npm i stripe
export STRIPE_SECRET_KEY=sk_test_...   # test mode only; the script refuses live keys
npx tsx examples/stripe-integration.ts
```

## Confirmation & settlement helpers

Settlement stays **injected** into `createPaymentExtension` — the core never moves money itself, and apps with bespoke settlement (escrow, ledgers, the marketplace) implement `SettlementStrategy` directly. But for the common cases you don't have to write it: each rail ships an opt-in **settlement strategy** and a **payer-side helper** (signing/confirming an offer), so both ends are batteries-included.

| Rail | Payer helper (client side) | Settlement strategy (server side) |
|---|---|---|
| `dev-signature` | `signDevAuthorization(secret, offer)` | `devSignatureSettlement` (no-op) |
| `x402-evm-exact` | `signX402Authorization({ account, offer })` | `createX402TransferSettlement({ wallet })` — bare USDC transfer via `exact.evm.settle` |
| `stripe-card` | `confirmStripePaymentIntent(stripe, offer, { paymentMethod })` | `createStripeCaptureSettlement(stripe)` — captures the hold |

```ts
import { createStripeRail, createStripeCaptureSettlement } from '@overdraft-protocol/mpx/rails/stripe';

const stripe = new Stripe(key);
const withPayment = createPaymentExtension({
  rails: [createStripeRail({ stripe, currency: 'usd' })],
  store,
  settlement: createStripeCaptureSettlement(stripe),  // ← shipped, no custom code
});
```

Settlement strategies that need the original offer (e.g. x402 needs the verified `PaymentRequirements`) receive it via the third `settle(verified, binding, context)` argument — `context.offer`. The argument is additive: existing two-parameter strategies keep working unchanged.

## Example server

[`examples/stdio-server.ts`](examples/stdio-server.ts) is a minimal MCP server with one paid tool, using the zero-dependency `dev-signature` rail — no chain, keys, or network. Run it as a real stdio server, or self-contained:

```bash
# real stdio MCP server (connect any MCP client / inspector):
npx tsx examples/stdio-server.ts

# self-contained demo — drives itself and prints challenge → sign → pay → receipt:
npx tsx examples/stdio-server.ts --demo
```

Swapping in a real rail is the same wiring: replace the rail + settlement with `createX402EvmRail`/`createX402TransferSettlement` or `createStripeRail`/`createStripeCaptureSettlement`.

## Logging

The core never writes to `console` — it emits structured `PaymentLogEvent`s to an injected `PaymentLogger`:

```ts
import { createPaymentExtension, consolePaymentLogger, type PaymentLogger } from '@overdraft-protocol/mpx';

// Built-ins: noopPaymentLogger (default), consolePaymentLogger.
// Or forward to your own structured logger:
const logger: PaymentLogger = {
  log(event) { myLogger.info({ mcpPayment: event }); },
};

const withPayment = createPaymentExtension({ rails, store, settlement, logger });
```

Event `type`s: `challenge_issued`, `authorization_received`, `authorization_parse_failed`, `verify_started`, `verify_succeeded`, `verify_failed`, `challenge_not_found`, `settled`. Payload fields are redacted by the rail's `describePayload` — the core never logs raw signatures.

## API

### `createPaymentExtension(config)`

Returns a `withPayment(spec, handler)` function. Config:

| Field | Type | Description |
|---|---|---|
| `rails` | `PaymentRail[]` | Supported payment rails, in preference order |
| `store` | `ChallengeStore` | Challenge persistence (use `InMemoryChallengeStore` for dev/tests) |
| `settlement` | `SettlementStrategy` | What `settle()` does — injected by the application |
| `challengeTtlSeconds` | `number?` | Challenge TTL in seconds (default: 300) |
| `logger` | `PaymentLogger?` | Structured event sink (default: no-op). See [Logging](#logging) |

### `withPayment(spec, handler)`

Returns an `AnyToolHandler` suitable for passing to `server.registerTool()`.

The `handler` receives `(args, extra)` where `extra` is augmented with:

| Field | Type | Description |
|---|---|---|
| `extra.verifiedPayment` | `VerifiedAuthorization \| undefined` | Verified rail payload; undefined when call is not gated |
| `extra.settle()` | `() => Promise<SettlementRef \| undefined>` | Call after validation to move funds; idempotent; returns undefined when not gated |

### `PaymentSpec`

| Field | Type | Description |
|---|---|---|
| `tool` | `string` | Tool name (shown in challenge reason) |
| `description` | `string` | Human-readable payment purpose |
| `intent(args)` | `PaymentIntent \| null \| Promise<...>` | Return a `PaymentIntent` to gate the call; `null` to skip payment |

### `PaymentIntent`

| Field | Type | Description |
|---|---|---|
| `amount` | `MpxAmount` | `{ value, currency, decimals }` |
| `payTo` | `string` | Payee address/account |
| `binding` | `unknown` | App-specific data passed unchanged to `SettlementStrategy.settle()` |
| `railHints` | `Record<string, unknown>?` | Opaque hints forwarded to `rail.buildOffer()` |

## Boundary rules

This package has a hard dependency boundary: it must never import from application code. It depends only on `@modelcontextprotocol/sdk` and `zod` (plus `x402`/`viem` inside the optional x402 rail subpath). All application concerns — persistence, settlement, gating logic, chain access — are injected through interfaces.

The package `tsconfig.json` has no `baseUrl`/`paths` aliases so it is structurally impossible to import application modules. The `eslint.config.js` adds a `no-restricted-imports` rule as a second line of defense.

## License

MIT
