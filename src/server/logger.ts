import type { MpxAmount } from '../protocol/schema.js';

/**
 * Structured payment lifecycle events emitted by the core. A library must not
 * decide where its host writes logs, so the core never calls `console` directly —
 * it emits these events to an injected {@link PaymentLogger}. The default is a
 * no-op; pass {@link consolePaymentLogger} to restore verbose console output.
 */
export type PaymentLogEvent =
  | {
      type: 'challenge_issued';
      tool: string;
      paymentRequestId: string;
      amount: MpxAmount;
      rails: string[];
      expiresAt: string;
    }
  | {
      type: 'authorization_received';
      tool: string;
      rail: string;
      paymentRequestId: string;
      source: 'params._meta' | 'payment_authorization' | 'unknown';
      /** Rail-redacted payload summary (rail.describePayload), if available. */
      payload?: unknown;
    }
  | {
      type: 'authorization_parse_failed';
      tool: string;
      source: 'params._meta' | 'payment_authorization' | 'unknown';
      error: string;
    }
  | {
      type: 'verify_started';
      tool: string;
      rail: string;
      paymentRequestId: string;
    }
  | {
      type: 'verify_succeeded';
      tool: string;
      rail: string;
      paymentRequestId: string;
      amount: MpxAmount;
    }
  | {
      type: 'verify_failed';
      tool: string;
      rail: string;
      paymentRequestId: string;
      error: string;
      /** Rail-redacted payload summary (rail.describePayload), if available. */
      payload?: unknown;
    }
  | {
      type: 'challenge_not_found';
      tool: string;
      paymentRequestId: string;
      /** 'lookup' (step 3) or 'consume' (step 5 race). */
      stage: 'lookup' | 'consume';
    }
  | {
      type: 'settled';
      tool: string;
      rail: string;
      paymentRequestId: string;
      settlementRef: string;
      amount: MpxAmount;
    };

export interface PaymentLogger {
  log(event: PaymentLogEvent): void;
}

/** Default — emits nothing. */
export const noopPaymentLogger: PaymentLogger = { log() {} };

/**
 * Opt-in logger that mirrors the package's previous behaviour: one tagged,
 * single-line JSON record per event on the appropriate console stream.
 */
export const consolePaymentLogger: PaymentLogger = {
  log(event: PaymentLogEvent): void {
    const { type, ...rest } = event;
    const line = `[mcp-payments] ${type}`;
    if (type === 'verify_failed' || type === 'authorization_parse_failed') {
      console.error(line, JSON.stringify(rest));
    } else {
      console.log(line, JSON.stringify(rest));
    }
  },
};
