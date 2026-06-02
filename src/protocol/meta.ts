/**
 * Reserved _meta key namespace for the MCP Payment Profile (MPP).
 *
 * All keys are prefixed with "mcp-payments/v1." so they can't collide with
 * other _meta users. Bump the major version if the shape changes in a breaking
 * way; add a new key for additive changes.
 */

export const MPP_VERSION = 1;

export const META_KEYS = {
  /** Carried in a tool's isError result._meta — the payment challenge. */
  challenge: 'mcp-payments/v1.challenge',
  /** Carried in a retry tools/call params._meta — the signed authorization. */
  authorization: 'mcp-payments/v1.authorization',
  /** Carried in a successful tool result._meta — the settlement receipt. */
  receipt: 'mcp-payments/v1.receipt',
} as const;

export type MetaKey = (typeof META_KEYS)[keyof typeof META_KEYS];
