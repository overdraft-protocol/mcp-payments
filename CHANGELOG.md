# Changelog

All notable changes to `@overdraft/mcp-payments` are documented here. This
project adheres to [Semantic Versioning](https://semver.org/). The on-the-wire
protocol is versioned separately by `mpxVersion` (currently `1`); a breaking
protocol change bumps that field and the package major.

## [Unreleased]

### Changed (breaking — package API)

- **The core is now genuinely rail-agnostic.** All x402-specific logic has been
  moved out of `server/` and behind optional `PaymentRail` hooks:
  `coerceAuthorization`, `retryInstructions`, `describePayload`, and
  `authorizationArgDescription`. The core calls these generically, so a payment
  rail owns its own agent-facing ergonomics with no app- or rail-knowledge in
  the wrapper.
- **Removed the `@overdraft/mcp-payments/server/authorization-shape` export.**
  `coerceAgentPaymentAuthorization`, `paymentRetryInstructions`, and
  `PAYMENT_AUTHORIZATION_ARG_DESCRIPTION` now live with the x402 rail and are
  exported from `@overdraft/mcp-payments/rails/x402-evm` as
  `coerceX402Authorization`, `x402RetryInstructions`, and
  `X402_AUTHORIZATION_ARG_DESCRIPTION`.
- **`server/payment-log` is now rail-agnostic.** `inspectMpxAuthorization` reads
  only envelope fields and passes the rail-specific `payload` through untouched;
  the x402 payload inspection moved to the x402 rail (`describePayload`).

### Added

- **Injectable structured logging.** `createPaymentExtension` accepts a
  `logger: PaymentLogger` that receives typed `PaymentLogEvent`s. The default is
  a no-op (a library must not write to a host's console). `consolePaymentLogger`
  restores the previous verbose console output.
- **`dev-signature` reference rail** (`@overdraft/mcp-payments/rails/dev-signature`).
  A zero-dependency HMAC rail for local development, demos, and CI — and the
  canonical template for writing a new rail.
- **`stripe-card` rail** (`@overdraft/mcp-payments/rails/stripe`). A production
  card rail (Stripe PaymentIntent with manual capture) proving the core is
  rail-agnostic beyond crypto. `stripe` is an optional peer dependency.
- **`PaymentRail.buildOffer` may now be async** (`RailOffer | Promise<RailOffer>`),
  so a rail can do IO while building an offer (e.g. create a PaymentIntent).
  Backward compatible — existing synchronous rails are unaffected.
- **Per-rail confirmation & settlement helpers** so both ends are
  batteries-included while the core stays settlement-agnostic:
  payer helpers `signDevAuthorization`, `signX402Authorization`,
  `confirmStripePaymentIntent`; settlement strategies `devSignatureSettlement`,
  `createX402TransferSettlement`, `createStripeCaptureSettlement`.
- **`SettlementStrategy.settle` receives a third `context` argument**
  (`{ offer }`) so rail settlements can reach the verified offer (x402 needs the
  `PaymentRequirements`). Additive — two-parameter implementations are unaffected.
- **Example server** `examples/stdio-server.ts` — a minimal runnable MCP server
  with a paid tool (dev-signature rail), plus a `--demo` self-driver.
- **Configurable x402 token metadata.** `createX402EvmRail` accepts `assetName`
  and `assetVersion` for the EIP-712 `extra` field (was hardcoded to USDC).

## [0.1.0]

- Initial internal release: MCP Payments Extension (MPX) core, x402-evm-exact rail,
  in-memory challenge store.
