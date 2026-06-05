import { randomUUID } from 'crypto';
import { META_KEYS, MPX_VERSION } from '../protocol/meta.js';
import {
  MpxAuthorizationSchema,
  MpxChallengeSchema,
  type MpxChallenge,
  type MpxReceipt,
} from '../protocol/schema.js';
import type { PaymentRail, PaymentIntent, VerifiedAuthorization, SettlementStrategy, SettlementRef } from '../rails/rail.js';
import type { ChallengeStore } from './challenge-store.js';
import { noopPaymentLogger, type PaymentLogger } from './logger.js';

// ── PaymentSpec — supplied by the application (Layer C) ──────────────────────

/**
 * Per-tool payment specification. The application implements intent() to
 * describe what payment is required for a given set of tool arguments.
 * Returning null/undefined means this particular call is not gated (e.g.
 * file_dispute when the seller is not staked).
 *
 * intent() may be async so implementations can do DB lookups (e.g. checking
 * seller stake before deciding whether to require payment).
 */
export interface PaymentSpec {
  /** Stable tool name — included in the challenge reason. */
  tool: string;
  /** Human/agent-readable description of what the payment is for. */
  description: string;
  intent(
    args: Record<string, unknown>,
  ): PaymentIntent | null | undefined | Promise<PaymentIntent | null | undefined>;
}

// ── Extra context passed to the wrapped handler ───────────────────────────────

export interface PaymentExtra {
  /**
   * The verified payment authorization, available when the tool was gated and
   * the agent supplied a valid authorization. Undefined when the call was not
   * gated (intent() returned null) or no auth was present (challenge was issued).
   *
   * Use this to access the raw rail payload (e.g. to extract an authorization
   * JSON for deferred on-chain settlement, as submit_bid does for acceptBid).
   */
  verifiedPayment: VerifiedAuthorization | undefined;

  /**
   * Call this from inside the tool handler — AFTER content-signature and
   * nonce checks pass — to settle the payment and get a receipt.
   * Returns undefined when the call was not gated (intent returned null).
   */
  settle(): Promise<SettlementRef | undefined>;
}

// ── Extension config — injected by the application ───────────────────────────

export interface PaymentExtensionConfig {
  /** Rails the server accepts, in preference order. */
  rails: PaymentRail[];
  /** Persists and retrieves issued challenges. */
  store: ChallengeStore;
  /** What "settle" actually does — Escrow deposit, bare transfer, card capture, … */
  settlement: SettlementStrategy;
  /** TTL for issued challenges in seconds. Default: 300 (5 minutes). */
  challengeTtlSeconds?: number;
  /**
   * Structured lifecycle logger. Default is a no-op — a library must not write
   * to console for its host. Pass `consolePaymentLogger` (from
   * '@overdraft-protocol/mpx') for verbose console output, or your own sink.
   */
  logger?: PaymentLogger;
}

// ── Result helpers ────────────────────────────────────────────────────────────

/** Fallback when the chosen rail provides no retryInstructions of its own. */
function genericRetryInstructions(challenge: MpxChallenge): string {
  return [
    '',
    'HOW TO PAY:',
    `  1. Sign the requirements in accepts[0] (rail "${challenge.accepts[0].rail}") with your wallet.`,
    '  2. Retry this exact tool call with identical arguments, adding the signed',
    `     authorization under params._meta["${META_KEYS.authorization}"] (or the`,
    '     payment_authorization argument) referencing this paymentRequestId:',
    `     ${challenge.paymentRequestId}`,
  ].join('\n');
}

function challengeResult(challenge: MpxChallenge, instructions: string) {
  // The full challenge is emitted in the text content (not only result._meta)
  // because standard LLM harnesses surface a tool result's `content` to the
  // model but not its `_meta`. An agent that cannot read `_meta` still needs
  // the paymentRequestId, amount, and rail offer to sign and retry, so we
  // inline the whole challenge as JSON here. The `_meta` copy is retained for
  // wallet-proxy clients that consume it programmatically.
  const text = [
    `payment_required: ${challenge.reason.description} (${challenge.amount.value} ${challenge.amount.currency}).`,
    '',
    'Payment challenge (sign this via your wallet MCP server, then retry the same tool call):',
    JSON.stringify(challenge, null, 2),
    '',
    instructions,
  ].join('\n');

  return {
    isError: true as const,
    content: [
      {
        type: 'text' as const,
        text,
      },
    ],
    _meta: {
      [META_KEYS.challenge]: challenge,
    },
  };
}

function attachReceipt<T extends object>(result: T, receipt: MpxReceipt): T & { _meta: Record<string, unknown> } {
  const existing = (result as Record<string, unknown>)._meta as Record<string, unknown> | undefined;

  // Like the challenge, the receipt is also surfaced in the content text — not
  // only result._meta — so agents whose harness drops _meta can still confirm
  // payment settled and read the settlementRef. We append a text block rather
  // than mutate the handler's existing content.
  const withReceiptContent = (() => {
    const content = (result as Record<string, unknown>).content;
    if (!Array.isArray(content)) return result;
    const receiptText = {
      type: 'text' as const,
      text: `payment_settled: ${receipt.amount.value} ${receipt.amount.currency} (settlementRef ${receipt.settlementRef}).\n${JSON.stringify(receipt, null, 2)}`,
    };
    return { ...result, content: [...content, receiptText] };
  })();

  return {
    ...withReceiptContent,
    _meta: { ...existing, [META_KEYS.receipt]: receipt },
  };
}

function isErrorResult(result: unknown): result is { isError: true } {
  return typeof result === 'object'
    && result !== null
    && 'isError' in result
    && (result as { isError?: unknown }).isError === true;
}

// ── Main factory ──────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolHandler = (args: any, extra: any) => Promise<any>;

/**
 * Creates a withPayment() higher-order function with injected dependencies.
 * Call once at server startup; the returned wrapper is transport-agnostic.
 *
 * @example
 * const withPayment = createPaymentExtension({ rails, store, settlement });
 *
 * server.registerTool('submit_bid', schema,
 *   withPayment(spec, async (args, extra) => {
 *     // 1. validate content signature, consume nonce …
 *     // 2. do any deferred work that needs extra.verifiedPayment.raw
 *     await extra.settle();   // funds move HERE, after validation
 *     return { content: [...] };
 *   })
 * );
 */
export function createPaymentExtension(cfg: PaymentExtensionConfig) {
  const railMap = new Map(cfg.rails.map(r => [r.id, r]));
  const ttlMs = (cfg.challengeTtlSeconds ?? 300) * 1000;
  const logger = cfg.logger ?? noopPaymentLogger;

  /**
   * Turn loosely-shaped agent input into an MPX authorization the schema can
   * validate. If it already validates, use it. Otherwise let each rail attempt
   * to normalize it (in preference order) and keep the first schema-valid
   * result — this is how the core stays rail-agnostic while supporting each
   * rail's own wire conventions.
   */
  function coerceAuthorization(raw: unknown, hints: { paymentRequestId?: string }): unknown {
    if (raw === undefined || raw === null) return raw;
    if (MpxAuthorizationSchema.safeParse(raw).success) return raw;
    for (const rail of cfg.rails) {
      const coerced = rail.coerceAuthorization?.(raw, hints);
      if (coerced !== undefined && MpxAuthorizationSchema.safeParse(coerced).success) {
        return coerced;
      }
    }
    return raw;
  }

  return function withPayment(
    spec: PaymentSpec,
    handler: (
      args: Record<string, unknown>,
      extra: Record<string, unknown> & PaymentExtra,
    ) => Promise<unknown>,
  ): AnyToolHandler {
    return async (
      args: Record<string, unknown>,
      extra: Record<string, unknown>,
    ): Promise<unknown> => {
      // ── Step 1: ask the application whether this call is gated ──────────
      const intent = await spec.intent(args);
      if (!intent) {
        // Not gated — pass straight through with no-op settle + no verifiedPayment.
        return handler(args, {
          ...extra,
          verifiedPayment: undefined,
          settle: async () => undefined,
        });
      }

      // ── Step 2: check for an incoming authorization ──────────────────────
      // Primary channel: params._meta (set by wallet-proxy clients).
      // Fallback: payment_authorization argument (JSON string, for agents whose
      // MCP clients cannot write to params._meta — the common case with standard
      // LLM harnesses where the model only controls `arguments`).
      const rawMeta = (extra._meta as Record<string, unknown> | undefined) ?? {};
      const authFromMeta = rawMeta[META_KEYS.authorization];
      const authFromArg = (() => {
        const v = args.payment_authorization;
        if (!v) return undefined;
        if (typeof v === 'string') {
          try { return JSON.parse(v); } catch { return undefined; }
        }
        return typeof v === 'object' ? v : undefined;
      })();
      const authSource = authFromMeta !== undefined
        ? 'params._meta' as const
        : authFromArg !== undefined
          ? 'payment_authorization' as const
          : null;
      const authRaw = coerceAuthorization(authFromMeta ?? authFromArg, {
        paymentRequestId: typeof args.payment_request_id === 'string'
          ? args.payment_request_id
          : undefined,
      });
      const authParsed = MpxAuthorizationSchema.safeParse(authRaw);

      if (!authParsed.success) {
        if (authRaw !== undefined) {
          logger.log({
            type: 'authorization_parse_failed',
            tool: spec.tool,
            source: authSource ?? 'unknown',
            error: authParsed.error.message,
          });
        }
        // No valid authorization — issue a challenge.
        const paymentRequestId = randomUUID();
        const expiresAt = new Date(Date.now() + ttlMs).toISOString();

        const offers = Object.fromEntries(
          await Promise.all(cfg.rails.map(async r => [r.id, await r.buildOffer(intent)] as const)),
        );

        const challenge = MpxChallengeSchema.parse({
          mpxVersion: MPX_VERSION,
          paymentRequestId,
          expiresAt,
          reason: { tool: spec.tool, description: spec.description },
          amount: intent.amount,
          accepts: Object.values(offers),
        });

        await cfg.store.save({ challenge, intent, offers });
        logger.log({
          type: 'challenge_issued',
          tool: spec.tool,
          paymentRequestId,
          amount: challenge.amount,
          rails: Object.keys(offers),
          expiresAt: challenge.expiresAt,
        });
        const firstRail = railMap.get(challenge.accepts[0].rail);
        const instructions = firstRail?.retryInstructions?.(challenge)
          ?? genericRetryInstructions(challenge);
        return challengeResult(challenge, instructions);
      }

      const auth = authParsed.data;
      logger.log({
        type: 'authorization_received',
        tool: spec.tool,
        rail: auth.rail,
        paymentRequestId: auth.paymentRequestId,
        source: authSource ?? 'unknown',
        payload: railMap.get(auth.rail)?.describePayload?.(auth.payload),
      });

      // ── Step 3: load the challenge (not consumed until handler succeeds) ───
      const record = await cfg.store.get(auth.paymentRequestId);
      if (!record) {
        logger.log({
          type: 'challenge_not_found',
          tool: spec.tool,
          paymentRequestId: auth.paymentRequestId,
          stage: 'lookup',
        });
        return {
          isError: true as const,
          content: [{ type: 'text' as const, text: 'payment_error: challenge expired, already used, or not found. Restart the payment flow by calling the tool without authorization first.' }],
        };
      }

      // ── Step 4: find the rail + verify (no money moves yet) ─────────────
      const rail = railMap.get(auth.rail);
      if (!rail) {
        return {
          isError: true as const,
          content: [{ type: 'text' as const, text: `payment_error: unknown rail "${auth.rail}". Supported: ${[...railMap.keys()].join(', ')}.` }],
        };
      }

      const offer = record.offers[auth.rail];
      if (!offer) {
        return {
          isError: true as const,
          content: [{ type: 'text' as const, text: `payment_error: no offer was issued for rail "${auth.rail}".` }],
        };
      }

      logger.log({
        type: 'verify_started',
        tool: spec.tool,
        rail: auth.rail,
        paymentRequestId: auth.paymentRequestId,
      });

      let verified: VerifiedAuthorization;
      try {
        verified = await rail.verify(auth.payload, offer);
      } catch (err) {
        logger.log({
          type: 'verify_failed',
          tool: spec.tool,
          rail: auth.rail,
          paymentRequestId: auth.paymentRequestId,
          error: String(err),
          payload: rail.describePayload?.(auth.payload),
        });
        return {
          isError: true as const,
          content: [{ type: 'text' as const, text: `payment_error: authorization verification failed — ${String(err)}. You may retry with the same paymentRequestId and signed authorization, or call the tool without authorization to get a fresh challenge.` }],
        };
      }

      logger.log({
        type: 'verify_succeeded',
        tool: spec.tool,
        rail: verified.rail,
        paymentRequestId: auth.paymentRequestId,
        amount: verified.amount,
      });

      // ── Step 5: claim the challenge before handler side effects ────────────
      const claimed = await cfg.store.consume(auth.paymentRequestId);
      if (!claimed) {
        logger.log({
          type: 'challenge_not_found',
          tool: spec.tool,
          paymentRequestId: auth.paymentRequestId,
          stage: 'consume',
        });
        return {
          isError: true as const,
          content: [{ type: 'text' as const, text: 'payment_error: challenge expired, already used, or not found. Restart the payment flow by calling the tool without authorization first.' }],
        };
      }

      // ── Step 6: inject settle() + verifiedPayment — handler calls settle() post-validation
      let settlementRef: SettlementRef | undefined;
      const settle = async (): Promise<SettlementRef> => {
        if (settlementRef) return settlementRef; // idempotent
        settlementRef = await cfg.settlement.settle(verified, record.intent.binding, { offer });
        logger.log({
          type: 'settled',
          tool: spec.tool,
          rail: verified.rail,
          paymentRequestId: auth.paymentRequestId,
          settlementRef: settlementRef.ref,
          amount: verified.amount,
        });
        return settlementRef;
      };

      let result: unknown;
      try {
        result = await handler(args, {
          ...extra,
          verifiedPayment: verified,
          settle,
        });
      } catch (err) {
        await cfg.store.release(claimed);
        throw err;
      }

      if (isErrorResult(result)) {
        await cfg.store.release(claimed);
        return result;
      }

      // ── Step 7: attach receipt if settlement occurred ────────────────────
      if (settlementRef) {
        const receipt: MpxReceipt = {
          mpxVersion: MPX_VERSION,
          paymentRequestId: auth.paymentRequestId,
          rail: auth.rail,
          settlementRef: settlementRef.ref,
          amount: verified.amount,
          settledAt: new Date().toISOString(),
        };
        return attachReceipt(result as object, receipt);
      }

      return result;
    };
  };
}
