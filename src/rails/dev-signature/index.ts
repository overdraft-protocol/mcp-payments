/**
 * dev-signature rail — a zero-dependency reference PaymentRail.
 *
 * It exists for three reasons:
 *   1. To prove the core is genuinely rail-agnostic (no x402/viem anywhere).
 *   2. As a runnable rail for local development, demos, and CI — no chain, no
 *      network, no peer dependencies (uses only Node's built-in `crypto`).
 *   3. As the canonical template to copy when writing a real rail.
 *
 * It is NOT a payment system: "authorization" is an HMAC-SHA256 over the offer
 * terms using a shared secret, standing in for a wallet signature. Verification
 * recomputes the HMAC and checks it matches. Do not use it to move real funds.
 *
 * Settlement is still injected (a SettlementStrategy) exactly like every other
 * rail — this rail only builds offers and verifies authorizations.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PaymentRail, PaymentIntent, VerifiedAuthorization, SettlementStrategy, SettlementRef } from '../rail.js';
import type { MpxChallenge, RailOffer } from '../../protocol/schema.js';
import { MPX_VERSION } from '../../protocol/meta.js';

export const RAIL_ID = 'dev-signature';

/**
 * No-op settlement for the dev-signature rail — there is nothing to capture or
 * transfer, so it just mints a fake reference. Lets the example server and dev
 * setups run the full flow (incl. a receipt) with zero external dependencies.
 */
export const devSignatureSettlement: SettlementStrategy = {
  async settle(): Promise<SettlementRef> {
    return { ref: `dev-settle-${randomUUID()}` };
  },
};

export interface DevSignatureRailConfig {
  /**
   * Shared secret the payer and verifier both hold. In a real rail this would
   * be the payer's private key signing and the verifier checking a public key —
   * here a symmetric HMAC keeps the example dependency-free.
   */
  secret: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** The exact string the payer must HMAC — derived deterministically from the offer. */
function canonicalMessage(req: Record<string, unknown>): string {
  return JSON.stringify({
    rail: RAIL_ID,
    payTo: req.payTo,
    amount: req.amount,
    currency: req.currency,
    decimals: req.decimals,
  });
}

function sign(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}

/**
 * Helper a payer (wallet) uses to produce the authorization payload for a given
 * offer. Exported so tests, demos, and example wallets don't reimplement it.
 */
export function signDevAuthorization(secret: string, offer: RailOffer): { signature: string } {
  return { signature: sign(secret, canonicalMessage(offer.requirements)) };
}

export function createDevSignatureRail(cfg: DevSignatureRailConfig): PaymentRail {
  return {
    id: RAIL_ID,

    buildOffer(intent: PaymentIntent): RailOffer {
      return {
        rail: RAIL_ID,
        payTo: intent.payTo,
        requirements: {
          scheme: 'hmac-sha256',
          payTo: intent.payTo,
          amount: intent.amount.value,
          currency: intent.amount.currency,
          decimals: intent.amount.decimals,
        },
      };
    },

    async verify(payload: unknown, offer: RailOffer): Promise<VerifiedAuthorization> {
      if (!isRecord(payload) || typeof payload.signature !== 'string') {
        throw new Error(
          'dev-signature authorization.payload must be { signature: "<hex hmac>" } — ' +
          'sign canonicalMessage(offer.requirements) with HMAC-SHA256 and the shared secret.',
        );
      }
      const expected = sign(cfg.secret, canonicalMessage(offer.requirements));
      const got = payload.signature;
      // Constant-time compare; lengths must match for timingSafeEqual.
      const ok = got.length === expected.length
        && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
      if (!ok) throw new Error('dev-signature verification failed: signature mismatch.');

      const req = offer.requirements;
      return {
        rail: RAIL_ID,
        amount: {
          value: String(req.amount),
          currency: String(req.currency),
          decimals: Number(req.decimals),
        },
        raw: { signature: got },
      };
    },

    coerceAuthorization(raw: unknown, hints: { paymentRequestId?: string }): unknown {
      const parsed = typeof raw === 'string'
        ? (() => { try { return JSON.parse(raw); } catch { return raw; } })()
        : raw;
      if (!isRecord(parsed)) return raw;

      const paymentRequestId = typeof parsed.paymentRequestId === 'string'
        ? parsed.paymentRequestId
        : hints.paymentRequestId;
      if (!paymentRequestId) return parsed;

      // Already a full MPX authorization — leave it for schema validation.
      if (parsed.mpxVersion !== undefined && parsed.payload !== undefined) return parsed;

      // Shorthand: { paymentRequestId, signature } → MPX authorization envelope.
      if (typeof parsed.signature === 'string') {
        return {
          mpxVersion: MPX_VERSION,
          paymentRequestId,
          rail: RAIL_ID,
          payload: { signature: parsed.signature },
        };
      }
      return parsed;
    },

    retryInstructions(challenge: MpxChallenge): string {
      const offer = challenge.accepts.find(a => a.rail === RAIL_ID) ?? challenge.accepts[0];
      return [
        '',
        'HOW TO PAY (dev-signature):',
        '  1. HMAC-SHA256 the canonical message for this offer with the shared secret.',
        `     offer.requirements = ${JSON.stringify(offer?.requirements)}`,
        '  2. Retry this tool call with payment_authorization = JSON.stringify({',
        `       "paymentRequestId": "${challenge.paymentRequestId}", "signature": "<hex hmac>" })`,
      ].join('\n');
    },

    describePayload(payload: unknown): unknown {
      if (!isRecord(payload)) return { type: typeof payload };
      const sig = typeof payload.signature === 'string' ? payload.signature : undefined;
      return { has_signature: !!sig, signature_prefix: sig ? sig.slice(0, 10) + '…' : null };
    },

    authorizationArgDescription:
      'JSON string: { "paymentRequestId": "<uuid from challenge>", "signature": "<hex HMAC-SHA256 of canonicalMessage(offer.requirements)>" }.',
  };
}
