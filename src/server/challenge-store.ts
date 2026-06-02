import type { MppChallenge, RailOffer } from '../protocol/schema.js';
import type { PaymentIntent } from '../rails/rail.js';

/**
 * A persisted challenge record — everything needed to validate an incoming
 * authorization and produce a settlement binding.
 */
export interface ChallengeRecord {
  challenge: MppChallenge;
  /** The original PaymentIntent, kept so the app's binding survives the round-trip. */
  intent: PaymentIntent;
  /** Per-rail offers indexed by rail id — the authoritative copy for verify(). */
  offers: Record<string, RailOffer>;
}

/**
 * Injected by the application. The package ships an InMemoryChallengeStore for
 * tests and single-process servers; production deployments should inject a
 * durable implementation (e.g. SQLite, Redis).
 */
export interface ChallengeStore {
  /**
   * Persist a newly issued challenge. The store must enforce that
   * paymentRequestId is unique across all live records.
   */
  save(record: ChallengeRecord): Promise<void>;

  /**
   * Look up a live (non-expired, non-consumed) challenge by its id.
   * Returns undefined if the id is unknown, expired, or already spent.
   */
  get(paymentRequestId: string): Promise<ChallengeRecord | undefined>;

  /**
   * Atomically consume a challenge — marking it as spent so it can never be
   * reused. Returns the record, or undefined if already spent / not found.
   * Implementations must make this atomic (INSERT … ON CONFLICT or equivalent).
   */
  consume(paymentRequestId: string): Promise<ChallengeRecord | undefined>;
}

// ── Default: in-memory (suitable for tests and single-process servers) ────────

export class InMemoryChallengeStore implements ChallengeStore {
  private readonly records = new Map<string, ChallengeRecord>();

  async save(record: ChallengeRecord): Promise<void> {
    this.records.set(record.challenge.paymentRequestId, record);
  }

  async get(paymentRequestId: string): Promise<ChallengeRecord | undefined> {
    const record = this.records.get(paymentRequestId);
    if (!record) return undefined;
    if (new Date(record.challenge.expiresAt) < new Date()) {
      this.records.delete(paymentRequestId);
      return undefined;
    }
    return record;
  }

  async consume(paymentRequestId: string): Promise<ChallengeRecord | undefined> {
    const record = await this.get(paymentRequestId);
    if (!record) return undefined;
    this.records.delete(paymentRequestId);
    return record;
  }
}
