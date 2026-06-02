import type { MppAmount, RailOffer } from '../protocol/schema.js';

// ── Intent ───────────────────────────────────────────────────────────────────

/**
 * Everything the MPP core needs to issue a challenge for one gated tool call.
 * Produced by the application's PaymentSpec.intent(); opaque to the rail.
 */
export interface PaymentIntent {
  amount: MppAmount;
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
  amount: MppAmount;
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
 * Injected by the application. The package never knows what "settle" does —
 * it could be an Escrow deposit, a bare USDC transfer, a card capture, etc.
 */
export interface SettlementStrategy {
  settle(
    verified: VerifiedAuthorization,
    /** The same binding the application put in PaymentIntent. */
    binding: unknown,
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
   * Build a RailOffer to include in a challenge's accepts[] array.
   * Must be deterministic for the same intent (same paymentRequestId → same offer).
   */
  buildOffer(intent: PaymentIntent): RailOffer;

  /**
   * Verify a signed authorization payload against the offer that was presented.
   * Must NOT move any funds. Throws if verification fails.
   */
  verify(
    payload: unknown,
    offer: RailOffer,
  ): Promise<VerifiedAuthorization>;
}
