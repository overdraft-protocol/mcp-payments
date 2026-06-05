/**
 * Stripe card rail — a production, non-crypto PaymentRail.
 *
 * Demonstrates that the MPX core is rail-agnostic beyond crypto: payment is a
 * Stripe PaymentIntent with **manual capture**, so verification confirms an
 * authorized hold and the injected SettlementStrategy captures it. This
 * preserves verify-before-settle exactly like the on-chain rails — the hold is
 * verified before the handler runs; money is captured only when the handler
 * calls `extra.settle()` after its own validation.
 *
 * Flow:
 *   1. buildOffer() creates a PaymentIntent (capture_method: 'manual') and
 *      returns its id + client_secret in the offer requirements.
 *   2. The payer (agent/host) confirms the PaymentIntent with a payment method,
 *      moving it to status 'requires_capture', and echoes the id back.
 *   3. verify() retrieves the PaymentIntent, asserts status 'requires_capture'
 *      and that amount/currency match the offer. No capture here.
 *   4. The app's SettlementStrategy.settle() calls
 *      stripe.paymentIntents.capture(id) — money moves here.
 *
 * `stripe` is an optional peer dependency, imported dynamically only when a
 * secretKey is given. For tests and custom clients, inject `stripe` directly.
 */

import type { PaymentRail, PaymentIntent, VerifiedAuthorization, SettlementStrategy, SettlementRef } from '../rail.js';
import type { MpxChallenge, RailOffer } from '../../protocol/schema.js';
import { MPX_VERSION } from '../../protocol/meta.js';

export const RAIL_ID = 'stripe-card';

/** Minimal subset of the Stripe SDK this rail uses. */
export interface StripePaymentIntent {
  id: string;
  client_secret?: string | null;
  amount: number;
  currency: string;
  status: string;
}

export interface StripeLike {
  paymentIntents: {
    create(params: {
      amount: number;
      currency: string;
      capture_method: 'manual';
      metadata?: Record<string, string>;
    }): Promise<StripePaymentIntent>;
    retrieve(id: string): Promise<StripePaymentIntent>;
    /** Used by `confirmStripePaymentIntent` (payer helper). */
    confirm?(id: string, params: Record<string, unknown>): Promise<StripePaymentIntent>;
    /** Used by `createStripeCaptureSettlement`. */
    capture?(id: string): Promise<StripePaymentIntent>;
  };
}

export interface StripeRailConfig {
  /** Inject a Stripe (or Stripe-compatible) client. Use this for tests. */
  stripe?: StripeLike;
  /** Or pass a secret key and the rail lazily `import('stripe')` to build one. */
  secretKey?: string;
  /** ISO 4217 currency code Stripe charges in, e.g. "usd". */
  currency: string;
  /** Symbol shown in MpxAmount; defaults to currency.toUpperCase(). */
  currencySymbol?: string;
  /** Minor-unit exponent for this currency. Default 2 (cents). */
  decimals?: number;
  /** Optional publishable key surfaced to the payer for client-side confirmation. */
  publishableKey?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Human decimal string → integer minor units (e.g. "1.50" → 150 for decimals=2). */
function toMinorUnits(value: string, decimals: number): number {
  const [whole = '0', frac = ''] = value.split('.');
  const fracPadded = frac.padEnd(decimals, '0').slice(0, decimals);
  return Number(BigInt(whole) * BigInt(10 ** decimals) + BigInt(fracPadded || '0'));
}

/** Integer minor units → human decimal string. */
function fromMinorUnits(amount: number, decimals: number): string {
  const divisor = 10 ** decimals;
  const whole = Math.trunc(amount / divisor);
  const frac = String(amount % divisor).padStart(decimals, '0');
  return decimals > 0 ? `${whole}.${frac}` : String(whole);
}

export function createStripeRail(cfg: StripeRailConfig): PaymentRail {
  const decimals = cfg.decimals ?? 2;
  const currencySymbol = cfg.currencySymbol ?? cfg.currency.toUpperCase();

  let clientPromise: Promise<StripeLike> | undefined;
  async function getStripe(): Promise<StripeLike> {
    if (cfg.stripe) return cfg.stripe;
    if (!clientPromise) {
      if (!cfg.secretKey) {
        throw new Error('stripe rail: provide a `stripe` client or a `secretKey`.');
      }
      // Indirect specifier so TypeScript doesn't require `stripe` to be present
      // at build time — it's an optional peer dependency, imported only here.
      const specifier = 'stripe';
      clientPromise = import(specifier).then((m: { default: new (key: string) => unknown }) => {
        const Stripe = m.default;
        return new Stripe(cfg.secretKey as string) as unknown as StripeLike;
      });
    }
    return clientPromise;
  }

  return {
    id: RAIL_ID,

    async buildOffer(intent: PaymentIntent): Promise<RailOffer> {
      const stripe = await getStripe();
      const amount = toMinorUnits(intent.amount.value, decimals);
      const pi = await stripe.paymentIntents.create({
        amount,
        currency: cfg.currency,
        capture_method: 'manual',
        metadata: { mpx_payTo: intent.payTo },
      });
      return {
        rail: RAIL_ID,
        payTo: intent.payTo,
        requirements: {
          scheme: 'stripe-payment-intent',
          paymentIntentId: pi.id,
          clientSecret: pi.client_secret ?? null,
          amount,
          currency: cfg.currency,
          captureMethod: 'manual',
          ...(cfg.publishableKey ? { publishableKey: cfg.publishableKey } : {}),
        },
      };
    },

    async verify(payload: unknown, offer: RailOffer): Promise<VerifiedAuthorization> {
      const piId = isRecord(payload) && typeof payload.paymentIntentId === 'string'
        ? payload.paymentIntentId
        : undefined;
      if (!piId) {
        throw new Error(
          'stripe authorization.payload must be { paymentIntentId: "pi_..." } — ' +
          'confirm the PaymentIntent from the offer with a payment method, then send its id back.',
        );
      }

      const req = offer.requirements;
      if (piId !== req.paymentIntentId) {
        throw new Error('stripe verification failed: paymentIntentId does not match the offer.');
      }

      const stripe = await getStripe();
      const pi = await stripe.paymentIntents.retrieve(piId);

      if (pi.status !== 'requires_capture') {
        throw new Error(
          `stripe verification failed: PaymentIntent status is "${pi.status}", expected "requires_capture". ` +
          'Confirm the PaymentIntent with a payment method (it must authorize a hold, not capture).',
        );
      }
      if (pi.amount !== req.amount || pi.currency !== req.currency) {
        throw new Error('stripe verification failed: amount/currency do not match the offer.');
      }

      return {
        rail: RAIL_ID,
        amount: {
          value: fromMinorUnits(pi.amount, decimals),
          currency: currencySymbol,
          decimals,
        },
        // Settlement captures using this id: stripe.paymentIntents.capture(id).
        raw: { paymentIntentId: pi.id },
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

      if (parsed.mpxVersion !== undefined && parsed.payload !== undefined) return parsed;

      const piId = typeof parsed.paymentIntentId === 'string'
        ? parsed.paymentIntentId
        : typeof parsed.payment_intent === 'string'
          ? parsed.payment_intent
          : undefined;
      if (piId) {
        return {
          mpxVersion: MPX_VERSION,
          paymentRequestId,
          rail: RAIL_ID,
          payload: { paymentIntentId: piId },
        };
      }
      return parsed;
    },

    retryInstructions(challenge: MpxChallenge): string {
      const offer = challenge.accepts.find(a => a.rail === RAIL_ID) ?? challenge.accepts[0];
      const req = offer?.requirements ?? {};
      return [
        '',
        'HOW TO PAY (stripe-card):',
        `  1. Confirm PaymentIntent ${req.paymentIntentId} with a payment method`,
        `     (clientSecret: ${req.clientSecret}). It must reach status "requires_capture".`,
        '  2. Retry this tool call with payment_authorization = JSON.stringify({',
        `       "paymentRequestId": "${challenge.paymentRequestId}", "paymentIntentId": "${req.paymentIntentId}" })`,
      ].join('\n');
    },

    describePayload(payload: unknown): unknown {
      if (!isRecord(payload)) return { type: typeof payload };
      return { paymentIntentId: payload.paymentIntentId ?? null };
    },

    authorizationArgDescription:
      'JSON string: { "paymentRequestId": "<uuid from challenge>", "paymentIntentId": "pi_... (confirmed, requires_capture)" }.',
  };
}

// ── Payer-side helper ─────────────────────────────────────────────────────────

/**
 * Payer-side confirmation: confirm the PaymentIntent from a Stripe-rail offer
 * with a payment method, moving it to `requires_capture`, and return the MPX
 * authorization payload to send back (`{ paymentIntentId }`).
 *
 * For tests/demos use a Stripe test card (`pm_card_visa`). In production the
 * confirmation usually happens client-side with the `clientSecret`; this helper
 * covers server-side and scripted flows.
 */
export async function confirmStripePaymentIntent(
  stripe: StripeLike,
  offer: RailOffer,
  opts: { paymentMethod: string; returnUrl?: string },
): Promise<{ paymentIntentId: string }> {
  const id = offer.requirements.paymentIntentId;
  if (typeof id !== 'string') {
    throw new Error('confirmStripePaymentIntent: offer.requirements.paymentIntentId is missing.');
  }
  if (!stripe.paymentIntents.confirm) {
    throw new Error('confirmStripePaymentIntent: the provided Stripe client has no paymentIntents.confirm.');
  }
  await stripe.paymentIntents.confirm(id, {
    payment_method: opts.paymentMethod,
    ...(opts.returnUrl ? { return_url: opts.returnUrl } : {}),
  });
  return { paymentIntentId: id };
}

// ── Settlement strategy ───────────────────────────────────────────────────────

/**
 * Ready-made SettlementStrategy for the Stripe rail: captures the authorized
 * PaymentIntent. This is the only place money actually moves. Pass it straight
 * to `createPaymentExtension({ settlement })`.
 */
export function createStripeCaptureSettlement(stripe: StripeLike): SettlementStrategy {
  return {
    async settle(verified): Promise<SettlementRef> {
      const id = (verified.raw as { paymentIntentId?: string }).paymentIntentId;
      if (!id) throw new Error('stripe settlement: verified.raw has no paymentIntentId.');
      if (!stripe.paymentIntents.capture) {
        throw new Error('stripe settlement: the provided Stripe client has no paymentIntents.capture.');
      }
      const captured = await stripe.paymentIntents.capture(id);
      return { ref: captured.id, status: captured.status };
    },
  };
}
