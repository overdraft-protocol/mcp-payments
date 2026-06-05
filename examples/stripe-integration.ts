/**
 * Runnable end-to-end check of the Stripe rail against Stripe TEST MODE.
 *
 * It exercises the full loop the package can't fake:
 *   buildOffer (creates a real PaymentIntent)
 *     → payer confirms it with a Stripe test card (→ requires_capture)
 *       → verify (real retrieve, asserts the hold)
 *         → settle (real capture — money "moves" in test mode)
 *
 * Setup:
 *   npm i stripe
 *   export STRIPE_SECRET_KEY=sk_test_...      # from dashboard.stripe.com (test mode)
 *   npx tsx examples/stripe-integration.ts
 *
 * Safe: uses test keys + test cards only; no real money. Skips with a message
 * if STRIPE_SECRET_KEY is unset so it never breaks CI.
 */

import { createPaymentExtension, InMemoryChallengeStore } from '../src/index.js';
import { createStripeRail } from '../src/rails/stripe/index.js';
import type { SettlementRef, SettlementStrategy } from '../src/rails/rail.js';
import { META_KEYS } from '../src/protocol/meta.js';

const secretKey = process.env.STRIPE_SECRET_KEY;
if (!secretKey) {
  console.log('STRIPE_SECRET_KEY not set — skipping. See the header of this file to run it.');
  process.exit(0);
}
if (!secretKey.startsWith('sk_test_')) {
  console.error('Refusing to run: STRIPE_SECRET_KEY is not a test key (must start with sk_test_).');
  process.exit(1);
}

// Minimal shape we use from the Stripe SDK (avoids needing its types here).
interface StripeClient {
  paymentIntents: {
    create(p: Record<string, unknown>): Promise<{ id: string; client_secret: string | null; amount: number; currency: string; status: string }>;
    retrieve(id: string): Promise<{ id: string; status: string }>;
    confirm(id: string, p: Record<string, unknown>): Promise<{ id: string; status: string }>;
    capture(id: string): Promise<{ id: string; status: string }>;
  };
}

async function main(): Promise<void> {
  const specifier = 'stripe';
  const Stripe = (await import(specifier) as { default: new (k: string) => StripeClient }).default;
  const stripe = new Stripe(secretKey as string);

  const rail = createStripeRail({ stripe, currency: 'usd' });

  // Settlement = capture the authorized hold. The ONLY place money moves.
  const settlement: SettlementStrategy = {
    async settle(verified): Promise<SettlementRef> {
      const id = (verified.raw as { paymentIntentId: string }).paymentIntentId;
      const captured = await stripe.paymentIntents.capture(id);
      console.log(`  settle → captured ${captured.id} (status: ${captured.status})`);
      return { ref: captured.id };
    },
  };

  const withPayment = createPaymentExtension({
    rails: [rail],
    store: new InMemoryChallengeStore(),
    settlement,
  });

  const spec = {
    tool: 'demo_paid_tool',
    description: 'Demo card payment (1.50 USD)',
    intent: () => ({
      amount: { value: '1.50', currency: 'USD', decimals: 2 },
      payTo: 'acct_demo_merchant',
      binding: { kind: 'demo' },
    }),
  };

  const handler = withPayment(spec, async (_args, extra) => {
    await extra.settle();
    return { content: [{ type: 'text', text: 'tool ran' }] };
  });

  // 1. No auth → challenge (rail creates a real PaymentIntent).
  console.log('1. requesting challenge…');
  const challengeRes = await handler({}, { _meta: {} }) as Record<string, unknown>;
  const challenge = (challengeRes._meta as Record<string, unknown>)[META_KEYS.challenge] as {
    paymentRequestId: string;
    accepts: { requirements: Record<string, unknown> }[];
  };
  const piId = challenge.accepts[0].requirements.paymentIntentId as string;
  console.log(`   created PaymentIntent ${piId} (see it in your Stripe test dashboard)`);

  // 2. Payer confirms with a Stripe test card → requires_capture.
  console.log('2. confirming PaymentIntent with test card pm_card_visa…');
  const confirmed = await stripe.paymentIntents.confirm(piId, {
    payment_method: 'pm_card_visa',
  });
  console.log(`   status: ${confirmed.status}`);

  // 3. Retry the tool with the confirmed id → verify → settle captures.
  console.log('3. retrying tool with the authorization…');
  const result = await handler(
    { payment_authorization: JSON.stringify({ paymentRequestId: challenge.paymentRequestId, paymentIntentId: piId }) },
    {},
  ) as Record<string, unknown>;

  if (result.isError) {
    console.error('FAILED:', (result.content as { text: string }[])[0].text);
    process.exit(1);
  }
  const receipt = (result._meta as Record<string, unknown>)[META_KEYS.receipt];
  console.log('\n✅ success — receipt:', JSON.stringify(receipt, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
