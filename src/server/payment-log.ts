import type { MppAuthorization } from '../protocol/schema.js';
import { inspectRawPaymentPayload } from '../rails/x402-evm/normalize.js';

function previewJson(value: unknown, maxLen = 1200): string {
  try {
    const text = JSON.stringify(value);
    return text.length <= maxLen ? text : `${text.slice(0, maxLen)}… (${text.length} chars total)`;
  } catch {
    return String(value);
  }
}

export function inspectMppAuthorization(
  raw: unknown,
  source: 'params._meta' | 'payment_authorization' | 'unknown',
): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') {
    return { source, present: false, raw_type: typeof raw };
  }
  const obj = raw as Record<string, unknown>;
  return {
    source,
    present: true,
    mppVersion: obj.mppVersion ?? null,
    paymentRequestId: obj.paymentRequestId ?? null,
    rail: obj.rail ?? null,
    payload: inspectRawPaymentPayload(obj.payload),
    raw_payload_json: previewJson(obj.payload),
  };
}

export function logPaymentChallenge(tool: string, paymentRequestId: string, details: Record<string, unknown>): void {
  console.log(`[payment] challenge tool=${tool} paymentRequestId=${paymentRequestId}`, JSON.stringify(details));
}

export function logPaymentAuthReceived(tool: string, inspection: Record<string, unknown>): void {
  console.log(`[payment] auth_received tool=${tool}`, JSON.stringify(inspection));
}

export function logPaymentAuthParseFailed(tool: string, source: string, raw: unknown, zodError: string): void {
  console.warn(`[payment] auth_parse_failed tool=${tool} source=${source} zod=${zodError}`);
  console.warn(`[payment] auth_parse_failed raw=${previewJson(raw, 800)}`);
}

export function logPaymentVerifyStart(
  tool: string,
  auth: MppAuthorization,
  offerSummary: Record<string, unknown>,
): void {
  console.log(
    `[payment] verify_start tool=${tool} paymentRequestId=${auth.paymentRequestId} rail=${auth.rail}`,
    JSON.stringify({
      offer: offerSummary,
      payload_inspection: inspectRawPaymentPayload(auth.payload),
    }),
  );
}

export function logPaymentVerifyOk(
  tool: string,
  paymentRequestId: string,
  details: Record<string, unknown>,
): void {
  console.log(`[payment] verify_ok tool=${tool} paymentRequestId=${paymentRequestId}`, JSON.stringify(details));
}

export function logPaymentVerifyFailed(
  tool: string,
  paymentRequestId: string,
  err: unknown,
  context: Record<string, unknown>,
): void {
  console.error(
    `[payment] verify_failed tool=${tool} paymentRequestId=${paymentRequestId} error=${String(err)}`,
    JSON.stringify(context),
  );
}
