import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MpxAuthorizationSchema } from '../src/protocol/schema.js';
import { MPX_VERSION } from '../src/protocol/meta.js';
import { coerceX402Authorization, RAIL_ID } from '../src/rails/x402-evm/index.js';

const PR_ID = '11111111-1111-1111-1111-111111111111';

const envelope = {
  x402Version: 1,
  scheme: 'exact',
  network: 'base',
  payload: { signature: '0xsig', authorization: { from: '0xa', to: '0xb', value: '1000000', validAfter: '0', validBefore: '99', nonce: '0x01' } },
};

function assertValidMpx(out: unknown) {
  const parsed = MpxAuthorizationSchema.safeParse(out);
  assert.ok(parsed.success, `expected schema-valid MPX authorization, got: ${JSON.stringify(out)}`);
  return parsed.success ? parsed.data : undefined;
}

describe('coerceX402Authorization', () => {
  it('standard wallet shape { paymentRequestId, paymentPayload } → MPX authorization', () => {
    const out = coerceX402Authorization({ paymentRequestId: PR_ID, paymentPayload: envelope });
    const mpx = assertValidMpx(out);
    assert.equal(mpx?.rail, RAIL_ID);
    assert.equal(mpx?.mpxVersion, MPX_VERSION);
    assert.equal(mpx?.paymentRequestId, PR_ID);
  });

  it('agent skipped the wrapper: { paymentRequestId, payload: <envelope> }', () => {
    const out = coerceX402Authorization({ paymentRequestId: PR_ID, payload: envelope });
    assertValidMpx(out);
  });

  it('JSON string input is parsed', () => {
    const out = coerceX402Authorization(JSON.stringify({ paymentRequestId: PR_ID, paymentPayload: envelope }));
    assertValidMpx(out);
  });

  it('paymentRequestId supplied via hints when absent from body', () => {
    const out = coerceX402Authorization({ paymentPayload: envelope }, { paymentRequestId: PR_ID });
    const mpx = assertValidMpx(out);
    assert.equal(mpx?.paymentRequestId, PR_ID);
  });

  it('already-complete MPX authorization passes through unchanged', () => {
    const complete = { mpxVersion: MPX_VERSION, paymentRequestId: PR_ID, rail: RAIL_ID, payload: envelope };
    const out = coerceX402Authorization(complete);
    assertValidMpx(out);
  });

  it('snake_case payment_request_id is accepted', () => {
    const out = coerceX402Authorization({ payment_request_id: PR_ID, paymentPayload: envelope });
    const mpx = assertValidMpx(out);
    assert.equal(mpx?.paymentRequestId, PR_ID);
  });

  it('null / undefined pass through untouched', () => {
    assert.equal(coerceX402Authorization(null), null);
    assert.equal(coerceX402Authorization(undefined), undefined);
  });
});
