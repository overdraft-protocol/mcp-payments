import { z } from 'zod';
import { MPP_VERSION } from './meta.js';

// ── Shared primitives ────────────────────────────────────────────────────────

export const MppAmountSchema = z.object({
  /** Decimal string, e.g. "1.50". Never a float. */
  value: z.string().regex(/^\d+(\.\d+)?$/, 'amount value must be a decimal string'),
  /** ISO 4217 or well-known crypto ticker, e.g. "USDC". */
  currency: z.string().min(1),
  /** Exponent: 10^-decimals gives the smallest unit, e.g. 6 for USDC. */
  decimals: z.number().int().nonnegative(),
});
export type MppAmount = z.infer<typeof MppAmountSchema>;

// ── Rail offer (one entry in challenge.accepts) ──────────────────────────────

export const RailOfferSchema = z.object({
  /** Identifies the rail adapter, e.g. "x402-evm-exact". */
  rail: z.string().min(1),
  /** The payee address/account on this rail. */
  payTo: z.string().min(1),
  /**
   * Rail-specific requirements (opaque to the core layer).
   * For x402-evm-exact this is a verbatim PaymentRequirements object.
   */
  requirements: z.record(z.string(), z.unknown()),
});
export type RailOffer = z.infer<typeof RailOfferSchema>;

// ── Challenge — result._meta["mcp-payments/v1.challenge"] ───────────────────

export const MppChallengeSchema = z.object({
  mppVersion: z.literal(MPP_VERSION),
  /** Opaque ID correlating this challenge with the authorization and receipt. */
  paymentRequestId: z.string().uuid(),
  /** ISO-8601 expiry — the server will reject authorizations after this time. */
  expiresAt: z.string().datetime(),
  reason: z.object({
    /** The tool that triggered the challenge. */
    tool: z.string().min(1),
    /** Human/agent-readable description of the payment purpose. */
    description: z.string().min(1),
  }),
  amount: MppAmountSchema,
  /** Ordered list of payment rails the server accepts; payer picks one. */
  accepts: z.array(RailOfferSchema).min(1),
});
export type MppChallenge = z.infer<typeof MppChallengeSchema>;

// ── Authorization — params._meta["mcp-payments/v1.authorization"] ───────────

export const MppAuthorizationSchema = z.object({
  mppVersion: z.literal(MPP_VERSION),
  /** Must echo the paymentRequestId from the challenge. */
  paymentRequestId: z.string().uuid(),
  /** Which rail the payer chose from challenge.accepts. */
  rail: z.string().min(1),
  /**
   * Rail-specific signed payload (opaque to the core layer).
   * For x402-evm-exact this is a decoded x402 PaymentPayload object.
   */
  payload: z.unknown(),
});
export type MppAuthorization = z.infer<typeof MppAuthorizationSchema>;

// ── Receipt — result._meta["mcp-payments/v1.receipt"] ───────────────────────

export const MppReceiptSchema = z.object({
  mppVersion: z.literal(MPP_VERSION),
  paymentRequestId: z.string().uuid(),
  rail: z.string().min(1),
  /**
   * Rail-specific settlement reference (opaque to the core layer).
   * For x402-evm-exact this is a transaction hash.
   */
  settlementRef: z.string().min(1),
  amount: MppAmountSchema,
  settledAt: z.string().datetime(),
});
export type MppReceipt = z.infer<typeof MppReceiptSchema>;
