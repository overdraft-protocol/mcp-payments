// Protocol — schemas, types, _meta keys
export * from './protocol/meta.js';
export * from './protocol/schema.js';

// Rail interface + types
export type {
  PaymentRail,
  PaymentIntent,
  VerifiedAuthorization,
  SettlementStrategy,
  SettlementContext,
  SettlementRef,
} from './rails/rail.js';

// Challenge store interface + default
export type { ChallengeStore, ChallengeRecord } from './server/challenge-store.js';
export { InMemoryChallengeStore } from './server/challenge-store.js';

// Structured logging seam
export type { PaymentLogger, PaymentLogEvent } from './server/logger.js';
export { noopPaymentLogger, consolePaymentLogger } from './server/logger.js';

// Server-side withPayment wrapper
export type { PaymentSpec, PaymentExtra, PaymentExtensionConfig, AnyToolHandler } from './server/with-payment.js';
export { createPaymentExtension } from './server/with-payment.js';
