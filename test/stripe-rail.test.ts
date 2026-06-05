import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPaymentExtension } from '../src/server/with-payment.js';
import { InMemoryChallengeStore } from '../src/server/challenge-store.js';
import { META_KEYS } from '../src/protocol/meta.js';
import type { SettlementStrategy, SettlementRef } from '../src/rails/rail.js';
import type { RailOffer } from '../src/protocol/schema.js';
import {
  createStripeRail,
  createStripeCaptureSettlement,
  confirmStripePaymentIntent,
  RAIL_ID,
  type StripeLike,
  type StripePaymentIntent,
} from '../src/rails/stripe/index.js';

// ── Fake Stripe — an in-memory PaymentIntent store with manual capture ────────

function makeFakeStripe() {
  const intents = new Map<string, StripePaymentIntent>();
  const captured: string[] = [];
  let n = 0;

  const stripe: StripeLike = {
    paymentIntents: {
      async create(params) {
        const id = `pi_${++n}`;
        const pi: StripePaymentIntent = {
          id,
          client_secret: `${id}_secret`,
          amount: params.amount,
          currency: params.currency,
          status: 'requires_payment_method',
        };
        intents.set(id, pi);
        return pi;
      },
      async retrieve(id) {
        const pi = intents.get(id);
        if (!pi) throw new Error(`no such payment_intent: ${id}`);
        return pi;
      },
      async confirm(id) {
        const pi = intents.get(id)!;
        pi.status = 'requires_capture';
        return pi;
      },
      async capture(id) {
        const pi = intents.get(id)!;
        pi.status = 'succeeded';
        captured.push(id);
        return pi;
      },
    },
  };

  // Test helpers simulating the payer's wallet + the app's settlement.
  const confirm = (id: string) => { intents.get(id)!.status = 'requires_capture'; };
  const capture = (id: string) => { intents.get(id)!.status = 'succeeded'; captured.push(id); };

  return { stripe, confirm, capture, captured, intents };
}

function makeSpec() {
  return {
    tool: 'paid_tool',
    description: 'Card payment (1.50 USD)',
    intent: () => ({
      amount: { value: '1.50', currency: 'USD', decimals: 2 },
      payTo: 'acct_merchant',
      binding: { kind: 'order', id: 'o1' },
    }),
  };
}

describe('stripe-card rail', () => {
  it('challenge creates a PaymentIntent; verify-before-capture; settle captures', async () => {
    const fake = makeFakeStripe();
    const rail = createStripeRail({ stripe: fake.stripe, currency: 'usd' });

    // Settlement captures the authorized hold — this is the only place money moves.
    const settlement: SettlementStrategy = {
      async settle(verified): Promise<SettlementRef> {
        const id = (verified.raw as { paymentIntentId: string }).paymentIntentId;
        fake.capture(id);
        return { ref: id };
      },
    };

    const store = new InMemoryChallengeStore();
    const withPayment = createPaymentExtension({ rails: [rail], store, settlement });
    const spec = makeSpec();

    // 1. No auth → challenge with a created PaymentIntent.
    const first = await withPayment(spec, async () => ({ content: [] }))({}, { _meta: {} }) as Record<string, unknown>;
    assert.equal(first.isError, true);
    const challenge = (first._meta as Record<string, unknown>)[META_KEYS.challenge] as {
      paymentRequestId: string;
      accepts: RailOffer[];
    };
    const offer = challenge.accepts[0];
    assert.equal(offer.rail, RAIL_ID);
    const piId = offer.requirements.paymentIntentId as string;
    assert.ok(piId.startsWith('pi_'));
    assert.equal(offer.requirements.amount, 150); // 1.50 USD → 150 cents
    assert.equal(fake.intents.get(piId)!.status, 'requires_payment_method');

    // 2. Payer confirms the PaymentIntent (→ requires_capture).
    fake.confirm(piId);

    // 3. Retry with the id via the argument fallback (exercises coerceAuthorization).
    const paid = withPayment(spec, async (_a, extra) => {
      await extra.settle();
      return { content: [{ type: 'text', text: 'ok' }] };
    });
    const result = await paid(
      { payment_authorization: JSON.stringify({ paymentRequestId: challenge.paymentRequestId, paymentIntentId: piId }) },
      {},
    ) as Record<string, unknown>;

    assert.equal(result.isError, undefined);
    assert.deepEqual(fake.captured, [piId]);
    const receipt = (result._meta as Record<string, unknown>)[META_KEYS.receipt] as Record<string, unknown>;
    assert.equal(receipt.rail, RAIL_ID);
    assert.equal(receipt.settlementRef, piId);
  });

  it('shipped helpers: confirmStripePaymentIntent + createStripeCaptureSettlement', async () => {
    const fake = makeFakeStripe();
    const rail = createStripeRail({ stripe: fake.stripe, currency: 'usd' });
    const store = new InMemoryChallengeStore();
    const withPayment = createPaymentExtension({
      rails: [rail],
      store,
      settlement: createStripeCaptureSettlement(fake.stripe), // batteries-included
    });
    const spec = makeSpec();

    const first = await withPayment(spec, async () => ({ content: [] }))({}, { _meta: {} }) as Record<string, unknown>;
    const challenge = (first._meta as Record<string, unknown>)[META_KEYS.challenge] as {
      paymentRequestId: string; accepts: RailOffer[];
    };

    // Payer helper confirms the offer and returns the authorization payload.
    const { paymentIntentId } = await confirmStripePaymentIntent(fake.stripe, challenge.accepts[0], {
      paymentMethod: 'pm_card_visa',
    });

    const paid = withPayment(spec, async (_a, extra) => { await extra.settle(); return { content: [] }; });
    const result = await paid(
      { payment_authorization: JSON.stringify({ paymentRequestId: challenge.paymentRequestId, paymentIntentId }) },
      {},
    ) as Record<string, unknown>;

    assert.equal(result.isError, undefined);
    assert.deepEqual(fake.captured, [paymentIntentId]);
  });

  it('verify fails when the PaymentIntent is not yet confirmed (no capture)', async () => {
    const fake = makeFakeStripe();
    const rail = createStripeRail({ stripe: fake.stripe, currency: 'usd' });
    let captured = false;
    const settlement: SettlementStrategy = {
      async settle(): Promise<SettlementRef> { captured = true; return { ref: 'x' }; },
    };
    const store = new InMemoryChallengeStore();
    const withPayment = createPaymentExtension({ rails: [rail], store, settlement });
    const spec = makeSpec();

    const first = await withPayment(spec, async () => ({ content: [] }))({}, { _meta: {} }) as Record<string, unknown>;
    const challenge = (first._meta as Record<string, unknown>)[META_KEYS.challenge] as {
      paymentRequestId: string; accepts: RailOffer[];
    };
    const piId = challenge.accepts[0].requirements.paymentIntentId as string;

    // Do NOT confirm — status stays requires_payment_method.
    const paid = withPayment(spec, async (_a, extra) => { await extra.settle(); return { content: [] }; });
    const result = await paid(
      { payment_authorization: JSON.stringify({ paymentRequestId: challenge.paymentRequestId, paymentIntentId: piId }) },
      {},
    ) as Record<string, unknown>;

    assert.equal(result.isError, true);
    assert.ok((result.content as { text: string }[])[0].text.includes('requires_capture'));
    assert.equal(captured, false);
  });
});
