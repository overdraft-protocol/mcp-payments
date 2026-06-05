/**
 * x402-evm-exact rail adapter.
 *
 * Implements buildOffer() and verify() using the x402 + viem libraries.
 * Settlement is deliberately NOT implemented here — inject a SettlementStrategy
 * from the application (e.g. an Escrow contract deposit, or exact.evm.settle for
 * a bare USDC transfer).
 *
 * Peer deps required: x402, viem.
 */

import type { PaymentRail, PaymentIntent, VerifiedAuthorization, SettlementStrategy, SettlementRef } from '../rail.js';
import type { RailOffer } from '../../protocol/schema.js';
import { inspectRawPaymentPayload, normalizeX402PaymentPayload } from './normalize.js';
import {
  coerceX402Authorization,
  x402RetryInstructions,
  X402_AUTHORIZATION_ARG_DESCRIPTION,
} from './authorization.js';
import { RAIL_ID } from './rail-id.js';

export { RAIL_ID };
export {
  coerceX402Authorization,
  x402RetryInstructions,
  X402_AUTHORIZATION_ARG_DESCRIPTION,
} from './authorization.js';

export interface X402EvmRailConfig {
  /** A viem PublicClient connected to the target network (e.g. Base mainnet). */
  // Using 'unknown' here so callers don't need to import viem types just to
  // construct the config. The real type is PublicClient from viem.
  publicClient: unknown;
  /** USDC (or other ERC-20) contract address on this network. */
  assetAddress: `0x${string}`;
  /** Network identifier as x402 expects it, e.g. "base". */
  network: string;
  /** EIP-712 domain chainId. When provided, included in challenge offers so
   *  agents with standard EIP-712 wallets can sign without mapping network strings. */
  chainId?: number | bigint;
  /** Token symbol for display, e.g. "USDC". */
  currencySymbol: string;
  /** Decimal places, e.g. 6 for USDC. */
  decimals: number;
  /** EIP-712 token name used in the x402 `extra` field. Default: "USD Coin". */
  assetName?: string;
  /** EIP-712 token version used in the x402 `extra` field. Default: "2". */
  assetVersion?: string;
}

/**
 * Convert a human USDC amount (e.g. "1.50") to the raw integer string (e.g. "1500000").
 */
function toRawAmount(value: string, decimals: number): string {
  const [whole = '0', frac = ''] = value.split('.');
  const fracPadded = frac.padEnd(decimals, '0').slice(0, decimals);
  return (BigInt(whole) * BigInt(10 ** decimals) + BigInt(fracPadded || '0')).toString();
}

/**
 * Convert a raw integer string back to a human decimal string.
 */
function fromRawAmount(raw: string, decimals: number): string {
  const value = BigInt(raw);
  const divisor = BigInt(10 ** decimals);
  const whole = value / divisor;
  const frac = (value % divisor).toString().padStart(decimals, '0');
  return `${whole}.${frac}`;
}

export function createX402EvmRail(cfg: X402EvmRailConfig): PaymentRail {
  return {
    id: RAIL_ID,

    buildOffer(intent: PaymentIntent): RailOffer {
      const rawAmount = toRawAmount(intent.amount.value, cfg.decimals);
      const hints = intent.railHints ?? {};
      const maxTimeoutSeconds = typeof hints.maxTimeoutSeconds === 'number'
        ? hints.maxTimeoutSeconds
        : 3600;

      const chainId = cfg.chainId !== undefined ? Number(cfg.chainId) : undefined;

      return {
        rail: RAIL_ID,
        payTo: intent.payTo,
        requirements: {
          scheme: 'exact',
          network: cfg.network,
          ...(chainId !== undefined ? { chainId } : {}),
          maxAmountRequired: rawAmount,
          resource: typeof hints.resource === 'string' ? hints.resource : '',
          description: intent.amount.value + ' ' + intent.amount.currency,
          mimeType: 'application/json',
          payTo: intent.payTo,
          maxTimeoutSeconds,
          asset: cfg.assetAddress,
          extra: { name: cfg.assetName ?? 'USD Coin', version: cfg.assetVersion ?? '2' },
        },
      };
    },

    async verify(payload: unknown, offer: RailOffer): Promise<VerifiedAuthorization> {
      // Dynamic imports keep x402/viem as optional peer deps — the package
      // compiles without them if this rail is never instantiated.
      const { exact } = await import('x402/schemes');
      const { safeBase64Encode } = await import('x402/shared');

      const requirements = offer.requirements;

      // Diagnostic context is attached to thrown errors (and surfaced via the
      // core's structured logger) rather than written to console here — a
      // library must not decide where its host logs.
      const normalized = normalizeX402PaymentPayload(payload, requirements);

      const payloadJson = safeBase64Encode(JSON.stringify(normalized));
      let decoded;
      try {
        decoded = exact.evm.decodePayment(payloadJson);
      } catch (err) {
        throw new Error(
          `${String(err)}. ` +
          'MPX authorization.payload must be the x402 PaymentPayload from sign_payment_authorization.paymentPayload ' +
          '(top-level network:"base", scheme:"exact") — not the wallet tool wrapper or inner signature/authorization only.',
        );
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await exact.evm.verify(cfg.publicClient as any, decoded, requirements as any);
      if (!result.isValid) {
        throw new Error(`x402 verification failed: ${result.invalidReason ?? 'unknown'}`);
      }

      // Extract actual authorized amount from the EIP-3009 field.
      const evmPayload = decoded.payload as { authorization: { value: string } };
      const rawValue = evmPayload.authorization?.value ?? requirements.maxAmountRequired as string;
      const humanValue = fromRawAmount(rawValue.toString(), cfg.decimals);

      return {
        rail: RAIL_ID,
        amount: {
          value: humanValue,
          currency: cfg.currencySymbol,
          decimals: cfg.decimals,
        },
        raw: decoded,
      };
    },

    coerceAuthorization: coerceX402Authorization,
    retryInstructions: x402RetryInstructions,
    describePayload: inspectRawPaymentPayload,
    authorizationArgDescription: X402_AUTHORIZATION_ARG_DESCRIPTION,
  };
}

// ── Payer-side helper ─────────────────────────────────────────────────────────

/**
 * Payer-side signing: produce the x402 PaymentPayload for a challenge offer
 * using a viem account/wallet, via x402's `exact.evm.createPayment`. Wrap the
 * result as `{ paymentRequestId, paymentPayload }` and send it back as the
 * `payment_authorization` argument (or `params._meta` authorization).
 *
 * In agent setups the wallet MCP server signs instead; this helper covers
 * scripted/test/non-agent payers. Requires the `x402` and `viem` peer deps.
 */
export async function signX402Authorization(opts: {
  /** A viem LocalAccount or SignerWallet for the payer. */
  account: unknown;
  /** The chosen offer from challenge.accepts (must be this rail). */
  offer: RailOffer;
  /** x402 protocol version. Default 1. */
  x402Version?: number;
}): Promise<{ paymentPayload: unknown }> {
  const { exact } = await import('x402/schemes');
  const paymentPayload = await exact.evm.createPayment(
    opts.account as never,
    opts.x402Version ?? 1,
    opts.offer.requirements as never,
  );
  return { paymentPayload };
}

// ── Settlement strategy ───────────────────────────────────────────────────────

/**
 * Ready-made SettlementStrategy that performs a bare USDC transfer on-chain via
 * x402's `exact.evm.settle` (transferWithAuthorization). This is the generic
 * "pay the payee directly" path — use it when you do NOT need application
 * binding in contract storage. Apps that bind funds to an order/escrow
 * (like a marketplace) implement their own SettlementStrategy instead.
 *
 * Uses the offer requirements from the settlement `context`, so the same terms
 * that were verified are the ones settled. Requires the `x402`/`viem` peer deps.
 */
export function createX402TransferSettlement(opts: {
  /** A viem SignerWallet (the facilitator/operator) that submits the transfer. */
  wallet: unknown;
}): SettlementStrategy {
  return {
    async settle(verified, _binding, context): Promise<SettlementRef> {
      const { exact } = await import('x402/schemes');
      const res = (await exact.evm.settle(
        opts.wallet as never,
        verified.raw as never,
        context.offer.requirements as never,
      )) as unknown as { success: boolean; transaction?: string; network?: string; errorReason?: string };
      if (!res.success) {
        throw new Error(`x402 settle failed: ${res.errorReason ?? 'unknown'}`);
      }
      return { ref: res.transaction ?? '', network: res.network };
    },
  };
}
