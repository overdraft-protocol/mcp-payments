/**
 * Normalize agent payment payloads into the canonical x402 envelope expected by decodePayment.
 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function fieldToString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return undefined;
}

function looksLikePaymentRequirements(v: unknown): boolean {
  if (!isRecord(v)) return false;
  return (
    typeof v.maxAmountRequired === 'string'
    && typeof v.asset === 'string'
    && 'payTo' in v
    && !('signature' in v)
  );
}

/** Normalize { signature, authorization } — coerce field types to strings. */
function normalizeInnerEvm(v: unknown): Record<string, unknown> | null {
  if (!isRecord(v)) return null;
  const signature = typeof v.signature === 'string' ? v.signature : undefined;
  if (!signature || !isRecord(v.authorization)) return null;
  const a = v.authorization;
  const from = fieldToString(a.from);
  const to = fieldToString(a.to);
  const value = fieldToString(a.value);
  const validAfter = fieldToString(a.validAfter);
  const validBefore = fieldToString(a.validBefore);
  const nonce = fieldToString(a.nonce);
  if (!from || !to || !value || !validAfter || !validBefore || !nonce) return null;
  return { signature, authorization: { from, to, value, validAfter, validBefore, nonce } };
}

/**
 * Normalize agent-supplied payload into the canonical x402 envelope:
 *   { x402Version, scheme, network, payload: { signature, authorization } }
 *
 * Expects a standard x402 PaymentPayload envelope from wallet.paymentPayload.
 */
export function normalizeX402PaymentPayload(
  payload: unknown,
  requirements: Record<string, unknown>,
): Record<string, unknown> {
  if (looksLikePaymentRequirements(payload)) {
    throw new Error(
      'authorization.payload looks like the raw challenge requirements (unsigned). ' +
      'Sign with your wallet using these requirements as paymentRequirements, ' +
      'then pass the returned paymentPayload here.',
    );
  }

  const reqNetwork = typeof requirements.network === 'string' ? requirements.network : 'base';

  if (!isRecord(payload)) {
    throw new Error(
      `Invalid payment payload: expected x402 PaymentPayload object, got ${typeof payload}. ` +
      `Pass wallet.paymentPayload from your x402 signing tool.`,
    );
  }

  // x402 PaymentPayload envelope: { x402Version, scheme, network, payload: { signature, authorization } }
  if (typeof payload.scheme === 'string' && typeof payload.network === 'string' && payload.payload !== undefined) {
    const inner = normalizeInnerEvm(payload.payload);
    if (inner) {
      return {
        x402Version: typeof payload.x402Version === 'number' ? payload.x402Version : 1,
        scheme: 'exact',
        network: typeof payload.network === 'string' ? payload.network : reqNetwork,
        payload: inner,
      };
    }
  }

  throw new Error(
    `Invalid payment payload. Expected x402 PaymentPayload: ` +
    `{ x402Version, scheme, network, payload: { signature, authorization: { from, to, value, validAfter, validBefore, nonce } } }. ` +
    `Received keys: ${Object.keys(payload).join(', ')}`,
  );
}

/** Debug summary of what the agent sent (safe for server logs). */
export function inspectRawPaymentPayload(payload: unknown): string {
  if (payload === null || payload === undefined) return String(payload);
  if (typeof payload === 'string') return `string(${payload.length}): ${payload.slice(0, 60)}`;
  if (!isRecord(payload)) return `typeof ${typeof payload}`;
  const keys = Object.keys(payload);
  const inner = isRecord(payload.payload) ? payload.payload : null;
  const auth = (inner && isRecord(inner.authorization)) ? inner.authorization
    : isRecord(payload.authorization) ? payload.authorization : null;
  return JSON.stringify({
    keys,
    scheme: payload.scheme ?? null,
    network: payload.network ?? null,
    has_payload: 'payload' in payload,
    authorization_from: auth ? (auth.from ?? null) : null,
    authorization_to: auth ? (auth.to ?? null) : null,
    signature_prefix: typeof (inner?.signature ?? payload.signature) === 'string'
      ? String(inner?.signature ?? payload.signature).slice(0, 14) + '…'
      : null,
  });
}
