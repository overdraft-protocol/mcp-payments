import type { MppChallenge } from '../protocol/schema.js';
import { MPP_VERSION } from '../protocol/meta.js';

const X402_EVM_RAIL_ID = 'x402-evm-exact';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function tryParseJson(text: string): unknown | null {
  try { return JSON.parse(text); } catch { return null; }
}

function paymentRequestIdFrom(value: Record<string, unknown>): string | undefined {
  if (typeof value.paymentRequestId === 'string') return value.paymentRequestId;
  if (typeof value.payment_request_id === 'string') return value.payment_request_id;
  return undefined;
}

/** x402 PaymentPayload envelope: { x402Version, scheme, network, payload } */
function isX402Envelope(v: unknown): v is Record<string, unknown> {
  if (!isRecord(v)) return false;
  return typeof v.scheme === 'string' && typeof v.network === 'string' && v.payload !== undefined;
}


/**
 * Normalize agent-supplied payment_authorization into a valid MPP authorization object.
 *
 * Expected format (x402 standard):
 *   { paymentRequestId: "<uuid from challenge>",
 *     paymentPayload: { x402Version, scheme, network, payload: { signature, authorization } } }
 *
 * Also accepts the full MPP envelope if the agent constructs it manually:
 *   { mppVersion, paymentRequestId, rail, payload: <x402 PaymentPayload> }
 */
export function coerceAgentPaymentAuthorization(
  raw: unknown,
  hints?: { paymentRequestId?: string },
): unknown {
  if (raw === undefined || raw === null) return raw;

  const parsed = typeof raw === 'string' ? (tryParseJson(raw) ?? raw) : raw;
  if (!isRecord(parsed)) return raw;

  const paymentRequestId = paymentRequestIdFrom(parsed) ?? hints?.paymentRequestId;
  const rail = typeof parsed.rail === 'string' ? parsed.rail : X402_EVM_RAIL_ID;
  const mppVersion = typeof parsed.mppVersion === 'number' ? parsed.mppVersion : MPP_VERSION;

  // Already a complete MPP authorization — pass through for schema validation.
  if (parsed.mppVersion !== undefined && paymentRequestId && parsed.payload !== undefined) {
    return parsed;
  }

  if (!paymentRequestId) return parsed;

  // Standard x402 format: { paymentRequestId, paymentPayload: <x402 envelope> }
  if (isX402Envelope(parsed.paymentPayload)) {
    return { mppVersion, paymentRequestId, rail, payload: parsed.paymentPayload };
  }

  // { paymentRequestId, payload: <x402 envelope> } — agent skipped the paymentPayload wrapper
  if (isX402Envelope(parsed.payload)) {
    return { mppVersion, paymentRequestId, rail, payload: parsed.payload };
  }

  return parsed;
}

export const PAYMENT_AUTHORIZATION_ARG_DESCRIPTION =
  'JSON string: { "paymentRequestId": "<uuid from challenge>", "paymentPayload": <x402 PaymentPayload from wallet> }. ' +
  'Sign with your wallet\'s x402 payment tool using accepts[0].requirements, ' +
  'then pass the returned paymentPayload here alongside the paymentRequestId from the challenge.';

export function paymentRetryInstructions(challenge: MppChallenge): string {
  const req = challenge.accepts[0]?.requirements;

  return [
    '',
    'HOW TO PAY:',
    '',
    'STEP 1 — Call the wallet tool sign_payment_authorization with this exact argument:',
    `  Argument name:  paymentRequirements`,
    `  Argument value: (the JSON object below)`,
    '',
    `  sign_payment_authorization({`,
    `    paymentRequirements: ${JSON.stringify(req)}`,
    `  })`,
    '',
    '  The wallet tool returns JSON in its result text. Extract "paymentPayload" from it.',
    '',
    'STEP 2 — Retry this exact tool call with identical arguments, adding:',
    `  payment_authorization = JSON.stringify({`,
    `    "paymentRequestId": "${challenge.paymentRequestId}",`,
    `    "paymentPayload": <the paymentPayload object from the wallet result>`,
    `  })`,
  ].join('\n');
}
