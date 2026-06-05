import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryChallengeStore } from '../src/server/challenge-store.js';
import type { ChallengeRecord } from '../src/server/challenge-store.js';
import { MPX_VERSION } from '../src/protocol/meta.js';

function makeRecord(ttlMs = 60_000): ChallengeRecord {
  return {
    challenge: {
      mpxVersion: MPX_VERSION,
      paymentRequestId: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      reason: { tool: 'test_tool', description: 'Test payment' },
      amount: { value: '1.00', currency: 'USDC', decimals: 6 },
      accepts: [{ rail: 'test-rail', payTo: '0xpayee', requirements: {} }],
    },
    intent: {
      amount: { value: '1.00', currency: 'USDC', decimals: 6 },
      payTo: '0xpayee',
      binding: { kind: 'test', id: 'abc' },
    },
    offers: { 'test-rail': { rail: 'test-rail', payTo: '0xpayee', requirements: {} } },
  };
}

describe('InMemoryChallengeStore', () => {
  it('save then get returns the record', async () => {
    const store = new InMemoryChallengeStore();
    const record = makeRecord();
    await store.save(record);
    const found = await store.get(record.challenge.paymentRequestId);
    assert.deepEqual(found, record);
  });

  it('get returns undefined for unknown id', async () => {
    const store = new InMemoryChallengeStore();
    const found = await store.get(crypto.randomUUID());
    assert.equal(found, undefined);
  });

  it('get returns undefined for an expired record', async () => {
    const store = new InMemoryChallengeStore();
    const record = makeRecord(-1); // already expired
    await store.save(record);
    const found = await store.get(record.challenge.paymentRequestId);
    assert.equal(found, undefined);
  });

  it('consume returns record and makes it unavailable', async () => {
    const store = new InMemoryChallengeStore();
    const record = makeRecord();
    await store.save(record);
    const consumed = await store.consume(record.challenge.paymentRequestId);
    assert.deepEqual(consumed, record);
    // Second consume of the same id must return undefined (single-use).
    const again = await store.consume(record.challenge.paymentRequestId);
    assert.equal(again, undefined);
  });

  it('consume returns undefined for unknown id', async () => {
    const store = new InMemoryChallengeStore();
    const result = await store.consume(crypto.randomUUID());
    assert.equal(result, undefined);
  });

  it('consume returns undefined for expired record', async () => {
    const store = new InMemoryChallengeStore();
    const record = makeRecord(-1);
    await store.save(record);
    const result = await store.consume(record.challenge.paymentRequestId);
    assert.equal(result, undefined);
  });

  it('get after consume returns undefined', async () => {
    const store = new InMemoryChallengeStore();
    const record = makeRecord();
    await store.save(record);
    await store.consume(record.challenge.paymentRequestId);
    const found = await store.get(record.challenge.paymentRequestId);
    assert.equal(found, undefined);
  });

  it('release restores a consumed challenge for retry', async () => {
    const store = new InMemoryChallengeStore();
    const record = makeRecord();
    await store.save(record);
    const id = record.challenge.paymentRequestId;

    await store.consume(id);
    assert.equal(await store.get(id), undefined);

    await store.release(record);
    assert.deepEqual(await store.get(id), record);
  });

  it('release is a no-op for an expired record', async () => {
    const store = new InMemoryChallengeStore();
    const record = makeRecord(-1);
    await store.save(record);
    const id = record.challenge.paymentRequestId;

    await store.consume(id);
    await store.release(record);
    assert.equal(await store.get(id), undefined);
  });
});
