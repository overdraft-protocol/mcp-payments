import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPaymentExtension } from '../src/server/with-payment.js';
import { InMemoryChallengeStore } from '../src/server/challenge-store.js';
import type { PaymentLogEvent, PaymentLogger } from '../src/server/logger.js';
import { META_KEYS } from '../src/protocol/meta.js';
import type { SettlementStrategy, SettlementRef } from '../src/rails/rail.js';
import type { RailOffer } from '../src/protocol/schema.js';
import { createDevSignatureRail, signDevAuthorization, RAIL_ID } from '../src/rails/dev-signature/index.js';

const SECRET = 'test-secret';

function makeSettlement(ref = 'dev-tx'): { strategy: SettlementStrategy; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    strategy: {
      async settle(verified, binding): Promise<SettlementRef> {
        calls.push({ verified, binding });
        return { ref };
      },
    },
  };
}

function makeSpec() {
  return {
    tool: 'paid_tool',
    description: 'Dev payment (1.00 USDC)',
    intent: () => ({
      amount: { value: '1.00', currency: 'USDC', decimals: 6 },
      payTo: '0xpayee',
      binding: { kind: 'test' },
    }),
  };
}

function capturingLogger(): { logger: PaymentLogger; events: PaymentLogEvent[] } {
  const events: PaymentLogEvent[] = [];
  return { events, logger: { log: e => events.push(e) } };
}

describe('dev-signature rail (rail-agnostic core proof)', () => {
  it('challenge → sign → retry via payment_authorization arg → settle + receipt', async () => {
    const store = new InMemoryChallengeStore();
    const { strategy, calls } = makeSettlement('dev-tx-1');
    const { logger, events } = capturingLogger();
    const withPayment = createPaymentExtension({
      rails: [createDevSignatureRail({ secret: SECRET })],
      store,
      settlement: strategy,
      logger,
    });
    const spec = makeSpec();

    // 1. No auth → challenge.
    const challengeWrap = withPayment(spec, async () => ({ content: [] }));
    const first = await challengeWrap({}, { _meta: {} }) as Record<string, unknown>;
    assert.equal(first.isError, true);
    const challenge = (first._meta as Record<string, unknown>)[META_KEYS.challenge] as {
      paymentRequestId: string;
      accepts: RailOffer[];
    };
    assert.equal(challenge.accepts[0].rail, RAIL_ID);
    // Retry instructions came from the rail, not the generic fallback.
    const text = (first.content as { text: string }[])[0].text;
    assert.ok(text.includes('HOW TO PAY (dev-signature)'));

    // 2. Payer signs the offer.
    const { signature } = signDevAuthorization(SECRET, challenge.accepts[0]);

    // 3. Retry using the argument fallback shorthand (exercises coerceAuthorization).
    let settled = false;
    const paidWrap = withPayment(spec, async (_args, extra) => {
      await extra.settle();
      settled = true;
      return { content: [{ type: 'text', text: 'done' }] };
    });
    const result = await paidWrap(
      { payment_authorization: JSON.stringify({ paymentRequestId: challenge.paymentRequestId, signature }) },
      {},
    ) as Record<string, unknown>;

    assert.equal(result.isError, undefined);
    assert.equal(settled, true);
    assert.equal(calls.length, 1);
    const receipt = (result._meta as Record<string, unknown>)[META_KEYS.receipt] as Record<string, unknown>;
    assert.equal(receipt.rail, RAIL_ID);
    assert.equal(receipt.settlementRef, 'dev-tx-1');

    // Logger saw the full lifecycle.
    const types = events.map(e => e.type);
    assert.ok(types.includes('challenge_issued'));
    assert.ok(types.includes('verify_succeeded'));
    assert.ok(types.includes('settled'));
  });

  it('bad signature → verify_failed, challenge not consumed', async () => {
    const store = new InMemoryChallengeStore();
    const { strategy, calls } = makeSettlement();
    const withPayment = createPaymentExtension({
      rails: [createDevSignatureRail({ secret: SECRET })],
      store,
      settlement: strategy,
    });
    const spec = makeSpec();

    const first = await withPayment(spec, async () => ({ content: [] }))({}, { _meta: {} }) as Record<string, unknown>;
    const challenge = (first._meta as Record<string, unknown>)[META_KEYS.challenge] as { paymentRequestId: string };

    const wrap = withPayment(spec, async (_a, extra) => { await extra.settle(); return { content: [] }; });
    const bad = await wrap(
      { payment_authorization: JSON.stringify({ paymentRequestId: challenge.paymentRequestId, signature: 'deadbeef' }) },
      {},
    ) as Record<string, unknown>;

    assert.equal(bad.isError, true);
    assert.ok((bad.content as { text: string }[])[0].text.includes('verification failed'));
    assert.equal(calls.length, 0);

    // Same paymentRequestId still usable with a correct signature (not consumed on verify failure).
    const offer = { rail: RAIL_ID, payTo: '0xpayee', requirements: { scheme: 'hmac-sha256', payTo: '0xpayee', amount: '1.00', currency: 'USDC', decimals: 6 } };
    const { signature } = signDevAuthorization(SECRET, offer);
    const good = await wrap(
      { payment_authorization: JSON.stringify({ paymentRequestId: challenge.paymentRequestId, signature }) },
      {},
    ) as Record<string, unknown>;
    assert.equal(good.isError, undefined);
    assert.equal(calls.length, 1);
  });
});
