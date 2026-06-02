import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPaymentExtension } from '../src/server/with-payment.js';
import { InMemoryChallengeStore } from '../src/server/challenge-store.js';
import { META_KEYS, MPP_VERSION } from '../src/protocol/meta.js';
import type { PaymentRail, PaymentIntent, VerifiedAuthorization, SettlementStrategy, SettlementRef } from '../src/rails/rail.js';
import type { RailOffer } from '../src/protocol/schema.js';

// ── Fake rail — no x402, no viem, no network ─────────────────────────────────

const FAKE_RAIL_ID = 'fake-rail';

function makeFakeRail(opts: { verifyOk?: boolean } = {}): PaymentRail {
  return {
    id: FAKE_RAIL_ID,
    buildOffer(intent: PaymentIntent): RailOffer {
      return {
        rail: FAKE_RAIL_ID,
        payTo: intent.payTo,
        requirements: { amount: intent.amount.value },
      };
    },
    async verify(_payload: unknown, _offer: RailOffer): Promise<VerifiedAuthorization> {
      if (opts.verifyOk === false) throw new Error('verification refused');
      return {
        rail: FAKE_RAIL_ID,
        amount: { value: '1.00', currency: 'USDC', decimals: 6 },
        raw: { verified: true },
      };
    },
  };
}

// ── Fake settlement strategy ──────────────────────────────────────────────────

function makeSettlement(ref = 'tx-abc'): { strategy: SettlementStrategy; calls: unknown[] } {
  const calls: unknown[] = [];
  const strategy: SettlementStrategy = {
    async settle(verified, binding): Promise<SettlementRef> {
      calls.push({ verified, binding });
      return { ref };
    },
  };
  return { strategy, calls };
}

// ── PaymentSpec helpers ───────────────────────────────────────────────────────

function makeSpec(payTo = '0xpayee') {
  return {
    tool: 'test_tool',
    description: 'Test payment (1.00 USDC)',
    intent: (_args: Record<string, unknown>): PaymentIntent => ({
      amount: { value: '1.00', currency: 'USDC', decimals: 6 },
      payTo,
      binding: { kind: 'test', id: '123' },
    }),
  };
}

// ── Valid authorization builder ───────────────────────────────────────────────

function makeAuth(paymentRequestId: string) {
  return {
    [META_KEYS.authorization]: {
      mppVersion: MPP_VERSION,
      paymentRequestId,
      rail: FAKE_RAIL_ID,
      payload: { signed: true },
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createPaymentExtension / withPayment', () => {
  it('no authorization → returns challenge result with _meta.challenge', async () => {
    const store = new InMemoryChallengeStore();
    const { strategy } = makeSettlement();
    const withPayment = createPaymentExtension({ rails: [makeFakeRail()], store, settlement: strategy });
    const handler = withPayment(makeSpec(), async () => ({ content: [{ type: 'text', text: 'ok' }] }));

    const result = await handler({}, { _meta: {} }) as Record<string, unknown>;

    assert.equal(result.isError, true);
    const meta = result._meta as Record<string, unknown>;
    const challenge = meta[META_KEYS.challenge] as Record<string, unknown>;
    assert.equal(challenge.mppVersion, MPP_VERSION);
    assert.ok(typeof challenge.paymentRequestId === 'string');
    assert.ok(Array.isArray(challenge.accepts));
    assert.equal((challenge.accepts as unknown[]).length, 1);
  });

  it('valid authorization → handler is called and settle() moves funds', async () => {
    const store = new InMemoryChallengeStore();
    const { strategy, calls } = makeSettlement('tx-settled');
    const withPayment = createPaymentExtension({ rails: [makeFakeRail()], store, settlement: strategy });
    const spec = makeSpec();

    // First call — get a challenge
    const challenge = await handler1(withPayment, spec, store);
    const id = challenge.paymentRequestId as string;

    // Second call — supply authorization
    let settleCalled = false;
    const wrappedHandler = withPayment(spec, async (_args, extra) => {
      await extra.settle();
      settleCalled = true;
      return { content: [{ type: 'text', text: 'done' }] };
    });

    const result = await wrappedHandler({}, { _meta: makeAuth(id) }) as Record<string, unknown>;

    assert.equal(result.isError, undefined); // not an error
    assert.equal(settleCalled, true);
    assert.equal(calls.length, 1);

    // Receipt attached
    const meta = result._meta as Record<string, unknown>;
    const receipt = meta[META_KEYS.receipt] as Record<string, unknown>;
    assert.equal(receipt.rail, FAKE_RAIL_ID);
    assert.equal(receipt.settlementRef, 'tx-settled');
    assert.equal(receipt.paymentRequestId, id);
  });

  it('replay: using a paymentRequestId twice is rejected', async () => {
    const store = new InMemoryChallengeStore();
    const { strategy } = makeSettlement();
    const withPayment = createPaymentExtension({ rails: [makeFakeRail()], store, settlement: strategy });
    const spec = makeSpec();

    const challenge = await handler1(withPayment, spec, store);
    const id = challenge.paymentRequestId as string;
    const auth = { _meta: makeAuth(id) };

    const wrapped = withPayment(spec, async (_args, extra) => { await extra.settle(); return { content: [] }; });

    // First use — ok
    await wrapped({}, auth);
    // Second use — the challenge was consumed
    const result2 = await wrapped({}, auth) as Record<string, unknown>;
    assert.equal(result2.isError, true);
    const text = (result2.content as { text: string }[])[0].text;
    assert.ok(text.includes('expired') || text.includes('already used') || text.includes('not found'));
  });

  it('unknown rail in authorization is rejected', async () => {
    const store = new InMemoryChallengeStore();
    const { strategy } = makeSettlement();
    const withPayment = createPaymentExtension({ rails: [makeFakeRail()], store, settlement: strategy });
    const spec = makeSpec();

    const challenge = await handler1(withPayment, spec, store);
    const id = challenge.paymentRequestId as string;

    const badAuth = {
      _meta: {
        [META_KEYS.authorization]: {
          mppVersion: MPP_VERSION,
          paymentRequestId: id,
          rail: 'nonexistent-rail',
          payload: {},
        },
      },
    };

    const wrapped = withPayment(spec, async () => ({ content: [] }));
    const result = await wrapped({}, badAuth) as Record<string, unknown>;
    assert.equal(result.isError, true);
    const text = (result.content as { text: string }[])[0].text;
    assert.ok(text.includes('unknown rail'));
  });

  it('rail verify failure is returned as isError', async () => {
    const store = new InMemoryChallengeStore();
    const { strategy } = makeSettlement();
    const withPayment = createPaymentExtension({
      rails: [makeFakeRail({ verifyOk: false })],
      store,
      settlement: strategy,
    });
    const spec = makeSpec();

    const challenge = await handler1(withPayment, spec, store);
    const id = challenge.paymentRequestId as string;

    const wrapped = withPayment(spec, async () => ({ content: [] }));
    const result = await wrapped({}, { _meta: makeAuth(id) }) as Record<string, unknown>;
    assert.equal(result.isError, true);
    const text = (result.content as { text: string }[])[0].text;
    assert.ok(text.includes('verification failed'));
  });

  it('conditional gating: intent() returning null passes through without payment', async () => {
    const store = new InMemoryChallengeStore();
    const { strategy, calls } = makeSettlement();
    const withPayment = createPaymentExtension({ rails: [makeFakeRail()], store, settlement: strategy });

    const ungatedSpec = {
      tool: 'test_tool',
      description: 'Conditionally gated',
      intent: () => null,
    };

    let handlerCalled = false;
    const wrapped = withPayment(ungatedSpec, async () => {
      handlerCalled = true;
      return { content: [{ type: 'text', text: 'ungated' }] };
    });

    const result = await wrapped({}, {}) as Record<string, unknown>;
    assert.equal(handlerCalled, true);
    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 0);
  });

  it('settle() is idempotent — calling it twice only settles once', async () => {
    const store = new InMemoryChallengeStore();
    const { strategy, calls } = makeSettlement();
    const withPayment = createPaymentExtension({ rails: [makeFakeRail()], store, settlement: strategy });
    const spec = makeSpec();

    const challenge = await handler1(withPayment, spec, store);
    const id = challenge.paymentRequestId as string;

    const wrapped = withPayment(spec, async (_args, extra) => {
      await extra.settle();
      await extra.settle(); // second call — must be no-op
      return { content: [] };
    });

    await wrapped({}, { _meta: makeAuth(id) });
    assert.equal(calls.length, 1);
  });

  it('no receipt attached when handler never calls settle()', async () => {
    const store = new InMemoryChallengeStore();
    const { strategy } = makeSettlement();
    const withPayment = createPaymentExtension({ rails: [makeFakeRail()], store, settlement: strategy });
    const spec = makeSpec();

    const challenge = await handler1(withPayment, spec, store);
    const id = challenge.paymentRequestId as string;

    // Handler deliberately does not call settle()
    const wrapped = withPayment(spec, async () => ({ content: [{ type: 'text', text: 'no settle' }] }));
    const result = await wrapped({}, { _meta: makeAuth(id) }) as Record<string, unknown>;

    const meta = result._meta as Record<string, unknown> | undefined;
    assert.equal(meta?.[META_KEYS.receipt], undefined);
  });
});

// ── Helper: issue a challenge and return the challenge object ─────────────────

async function handler1(
  withPayment: ReturnType<typeof createPaymentExtension>,
  spec: ReturnType<typeof makeSpec>,
  store: InMemoryChallengeStore,
): Promise<Record<string, unknown>> {
  const wrapped = withPayment(spec, async () => ({ content: [] }));
  const result = await wrapped({}, { _meta: {} }) as Record<string, unknown>;
  assert.equal(result.isError, true, 'expected a challenge');
  const meta = result._meta as Record<string, unknown>;
  return meta[META_KEYS.challenge] as Record<string, unknown>;
}
