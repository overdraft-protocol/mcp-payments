/**
 * Generic, rail-agnostic inspection of an incoming MPX authorization for logs.
 *
 * The core emits structured events through an injected {@link PaymentLogger}
 * (see ./logger.ts) — this helper is exported for hosts that want to summarize a
 * raw authorization off the request path (e.g. HTTP access logs) without
 * parsing the MPX schema themselves. It reads only the envelope fields and
 * passes the rail-specific `payload` through untouched.
 */

export function previewJson(value: unknown, maxLen = 1200): string {
  try {
    const text = JSON.stringify(value);
    return text.length <= maxLen ? text : `${text.slice(0, maxLen)}… (${text.length} chars total)`;
  } catch {
    return String(value);
  }
}

export function inspectMpxAuthorization(
  raw: unknown,
  source: 'params._meta' | 'payment_authorization' | 'unknown' = 'unknown',
): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') {
    return { source, present: false, raw_type: typeof raw };
  }
  const obj = raw as Record<string, unknown>;
  return {
    source,
    present: true,
    mpxVersion: obj.mpxVersion ?? null,
    paymentRequestId: obj.paymentRequestId ?? null,
    rail: obj.rail ?? null,
    payload: obj.payload ?? null,
  };
}
