import type { MpxAmount, MpxChallenge, RailOffer } from '../protocol/schema.js';

// ── Intent ───────────────────────────────────────────────────────────────────

/**
 * Everything the MPX core needs to issue a challenge for one gated tool call.
 * Produced by the application's PaymentSpec.intent(); opaque to the rail.
 */
export interface PaymentIntent {
  amount: MpxAmount;
  /** Destination address/account on the chosen rail. */
  payTo: string;
  /**
   * Application-level data that will be passed back to SettlementStrategy.settle()
   * after verification. The package treats it as opaque (unknown); the app narrows
   * it to whatever it needs (e.g. EscrowBinding).
   */
  binding: unknown;
  /** Per-rail hints (e.g. { network, maxTimeoutSeconds }). Forwarded to buildOffer(). */
  railHints?: Record<string, unknown>;
}

// ── Verified authorization ───────────────────────────────────────────────────

/**
 * What a rail's verify() returns after cryptographic + policy checks pass.
 * Handed back to SettlementStrategy.settle(); the core layer only reads rail + amount.
 */
export interface VerifiedAuthorization {
  rail: string;
  amount: MpxAmount;
  /**
   * Decoded, rail-specific signed payload — e.g. an x402 PaymentPayload with the
   * EIP-3009 authorization fields. Passed to SettlementStrategy.settle() as-is.
   */
  raw: unknown;
}

// ── Settlement ───────────────────────────────────────────────────────────────

export interface SettlementRef {
  /** Rail-specific primary reference (tx hash, charge ID, …). */
  ref: string;
  [extra: string]: unknown;
}

/**
 * Extra context the core hands to settle(). Lets a rail's settlement strategy
 * reach the original offer (e.g. x402 settlement needs the PaymentRequirements
 * that were presented). Additive — implementations may ignore it.
 */
export interface SettlementContext {
  /** The RailOffer that was presented for the chosen rail. */
  offer: RailOffer;
}

/**
 * Injected by the application. The package never knows what "settle" does —
 * it could be an Escrow deposit, a bare USDC transfer, a card capture, etc.
 *
 * The package ships ready-made strategies for the common cases as opt-in
 * sub-exports (e.g. `createStripeCaptureSettlement`, `createX402TransferSettlement`,
 * `devSignatureSettlement`); apps with bespoke settlement (escrow, ledgers)
 * implement this interface directly. Implementations may take two args and
 * ignore `context` — TypeScript allows the narrower signature.
 */
export interface SettlementStrategy {
  settle(
    verified: VerifiedAuthorization,
    /** The same binding the application put in PaymentIntent. */
    binding: unknown,
    context: SettlementContext,
  ): Promise<SettlementRef>;
}

// ── Rail adapter ─────────────────────────────────────────────────────────────

/**
 * A PaymentRail turns a PaymentIntent into a challenge offer, and verifies an
 * incoming authorization — but NEVER settles. Settlement is an injected strategy
 * so the rail stays generic and publishable without app knowledge.
 */
export interface PaymentRail {
  /** Stable identifier — used as the discriminant in challenge.accepts[].rail. */
  readonly id: string;

  /**
   * Build a RailOffer to include in a challenge's accepts[] array. May be async
   * so a rail can do IO while building the offer (e.g. create a Stripe
   * PaymentIntent, fetch a quote). For deterministic rails the same intent
   * should yield an equivalent offer.
   */
  buildOffer(intent: PaymentIntent): RailOffer | Promise<RailOffer>;

  /**
   * Verify a signed authorization payload against the offer that was presented.
   * Must NOT move any funds. Throws if verification fails.
   */
  verify(
    payload: unknown,
    offer: RailOffer,
  ): Promise<VerifiedAuthorization>;

  // ── Optional, rail-owned agent ergonomics ──────────────────────────────────
  // These let a rail own its agent-facing details (wire format, instructions,
  // log redaction) without leaking rail specifics into the generic core. The
  // core calls them defensively — a rail that omits them still works.

  /**
   * Normalize loosely-shaped agent input into something the core can validate
   * as an MPX authorization (`{ mpxVersion, paymentRequestId, rail, payload }`).
   * Standard LLM harnesses can't write `params._meta`, so agents pass a JSON
   * blob in an argument whose exact shape varies; this is where a rail accepts
   * its own conventions. Return the input unchanged if it can't be normalized —
   * the core will surface a schema error. The core tries each rail's coercer in
   * preference order and keeps the first result that schema-validates.
   */
  coerceAuthorization?(
    raw: unknown,
    hints: { paymentRequestId?: string },
  ): unknown;

  /**
   * Rail-specific "how to pay" text appended to the challenge content so an
   * agent can sign and retry. Omit to fall back to a generic instruction.
   */
  retryInstructions?(challenge: MpxChallenge): string;

  /**
   * Redact a signed payload down to a safe, structured summary for logs.
   * Must never include secrets/signatures in full. Omit to log nothing.
   */
  describePayload?(payload: unknown): unknown;

  /**
   * Human/agent-readable description for the `payment_authorization` tool
   * argument, surfaced by apps in their tool `inputSchema`. Omit if unused.
   */
  readonly authorizationArgDescription?: string;
}
