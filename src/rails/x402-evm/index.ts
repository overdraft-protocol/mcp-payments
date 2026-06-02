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

import type { PaymentRail, PaymentIntent, VerifiedAuthorization } from '../rail.js';
import type { RailOffer } from '../../protocol/schema.js';

export const RAIL_ID = 'x402-evm-exact';

export interface X402EvmRailConfig {
  /** A viem PublicClient connected to the target network (e.g. Base mainnet). */
  // Using 'unknown' here so callers don't need to import viem types just to
  // construct the config. The real type is PublicClient from viem.
  publicClient: unknown;
  /** USDC (or other ERC-20) contract address on this network. */
  assetAddress: `0x${string}`;
  /** Network identifier as x402 expects it, e.g. "base". */
  network: string;
  /** Token symbol for display, e.g. "USDC". */
  currencySymbol: string;
  /** Decimal places, e.g. 6 for USDC. */
  decimals: number;
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

      return {
        rail: RAIL_ID,
        payTo: intent.payTo,
        requirements: {
          scheme: 'exact',
          network: cfg.network,
          maxAmountRequired: rawAmount,
          resource: typeof hints.resource === 'string' ? hints.resource : '',
          description: intent.amount.value + ' ' + intent.amount.currency,
          mimeType: 'application/json',
          payTo: intent.payTo,
          maxTimeoutSeconds,
          asset: cfg.assetAddress,
          extra: { name: 'USD Coin', version: '2' },
        },
      };
    },

    async verify(payload: unknown, offer: RailOffer): Promise<VerifiedAuthorization> {
      // Dynamic imports keep x402/viem as optional peer deps — the package
      // compiles without them if this rail is never instantiated.
      const { exact } = await import('x402/schemes');
      const { safeBase64Encode } = await import('x402/shared');

      // Reconstruct PaymentRequirements from the stored offer.requirements
      const requirements = offer.requirements;

      // payload must be a decoded PaymentPayload object (not base64).
      const payloadJson = safeBase64Encode(JSON.stringify(payload));
      const decoded = exact.evm.decodePayment(payloadJson);

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
  };
}
