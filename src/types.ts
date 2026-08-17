// The shared vocabulary: what a provider is, what an executor is, and the
// shapes that cross between them.
//
// Everything here is a type or an interface. There is no runtime code in this
// file on purpose, so that `src/providers/` and `src/metering/` can depend on
// it without either depending on the other.
//
// One rule governs the provider half of this file, and it is checkable in
// review by grep: no branch anywhere in billing-kit reads `provider.name`.
// Every branch reads `capabilities`. A `name` comparison is how a library that
// claims to be provider-agnostic becomes Stripe with adapters, and it happens
// one innocent `if` at a time.

import type { Money, Quantity, Rate } from './money';

// --- database ---------------------------------------------------------------

/**
 * The whole database dependency.
 *
 * Narrow on purpose. Prisma is the house tool for schema and migrations, but
 * the engine is raw SQL, and requiring `@prisma/client` at runtime would make
 * every adopter carry a second connection pool and a generated client they do
 * not otherwise want. A bare `pg.Pool` satisfies this in about ten lines.
 *
 * `query` returns rows. Values arrive as the driver produces them — node-postgres
 * gives BIGINT and NUMERIC as strings, which is correct and must stay that way
 * until `Money.fromMinor` or `Rate.fromDecimalString` sees them.
 */
export interface SqlExecutor {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
  /**
   * Run `fn` inside one transaction, committing on resolve and rolling back on
   * throw. The executor handed to `fn` must be pinned to a single connection;
   * an implementation that hands back the pool will silently run the body's
   * statements on different connections and the rollback will cover nothing.
   */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

/** Injected so tests and driver timeouts do not depend on wall clock drift. */
export type Clock = () => Date;

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

// --- identity ---------------------------------------------------------------

/**
 * Our identifier for a billable party. Opaque to billing-kit.
 *
 * Note what is absent: there is no `providerCustomerId` in any public
 * parameter, anywhere in this library. It is resolved internally from the
 * subject. A provider customer id taken from a request body and passed to a
 * provider call is an IDOR — the caller names someone else's customer and the
 * provider obliges — and the type system is the enforcement.
 */
export type SubjectId = string;

/** Tenant boundary. Present on every ingest row so a leak needs a join, not a typo. */
export type TenantId = string;

// --- usage ------------------------------------------------------------------

/**
 * One thing that happened, that money may later be owed for.
 *
 * `externalId` is the caller's own unique id — their request id, their job id.
 * It is not generated here, because a value we generate cannot deduplicate a
 * retry: the retry would generate a second one.
 */
export interface UsageEvent {
  tenantId: TenantId;
  subjectId: SubjectId;
  /** Which producer this came from. Namespaces `externalId`. */
  source: string;
  externalId: string;
  /** What is being counted: `tokens.input`, `gb_hours`, `requests`. */
  metric: string;
  quantity: Quantity;
  /**
   * When it happened, from the caller. The partition key.
   *
   * Deliberately not the database's clock: an event's period membership is a
   * property of the event, and assigning it on arrival would move usage between
   * invoices whenever a queue backed up.
   */
  occurredAt: Date;
  metadata?: Record<string, unknown>;
}

export interface RecordedEvent {
  eventId: string;
  /**
   * True when this external id had already been recorded.
   *
   * The caller gets 200 and this flag, never a 409. A retrying client treats
   * 409 as fatal and either drops the event or wakes someone up; the entire
   * point of an idempotent ingest is that the retry is boring.
   */
  deduplicated: boolean;
  occurredAt: Date;
  receivedAt: Date;
}

export interface UsageWindow {
  /** Inclusive. */
  start: Date;
  /** Exclusive. Half-open, so consecutive windows can neither gap nor overlap. */
  end: Date;
}

// --- ledger -----------------------------------------------------------------

/**
 * The accounts billing-kit posts to.
 *
 * `settlement_variance` exists because under `quantity` settlement, or any
 * merchant-of-record provider, our computed amount is an estimate and theirs is
 * authoritative. The difference has to land somewhere named. Absorbing it into
 * revenue is how a systematic pricing disagreement stays invisible for a year.
 */
export type AccountKind =
  | 'customer_balance'
  | 'revenue_accrued'
  | 'revenue_settled'
  | 'settlement_variance'
  | 'cash'
  /**
   * Prepaid credit — a wallet. A liability: money the customer has paid us that
   * we have not yet earned, so it carries a credit (negative) balance and is
   * drawn down as usage is charged. It is not `cash` and not revenue; conflating
   * a topped-up balance with earned revenue is how a company recognises money it
   * still owes back.
   */
  | 'customer_credit'
  | 'tax_payable'
  | 'rounding'
  | 'write_off';

/** What caused a transaction. Half of its natural key. */
export type LedgerSourceKind = 'charge' | 'settlement' | 'payment' | 'refund' | 'adjustment' | 'opening_balance';

/**
 * One leg. Signed: positive is a debit, negative is a credit, and the legs of
 * a transaction sum to zero.
 *
 * Stating the convention once, here, is deliberate. A codebase that leaves it
 * implicit ends up with two halves that disagree about the sign of a credit,
 * and the symptom is a balance that is right in magnitude and wrong in sign
 * only for refunds.
 */
export interface LedgerLeg {
  account: AccountKind;
  subjectId: SubjectId;
  amount: Money;
  memo?: string;
}

export interface LedgerPosting {
  tenantId: TenantId;
  sourceKind: LedgerSourceKind;
  /** The id of the thing that caused this. With `sourceKind`, the natural key. */
  sourceId: string;
  legs: readonly LedgerLeg[];
  /** Provider or caller timestamp. Falls back to the database clock. */
  postedAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface LedgerEntry {
  id: string;
  transactionId: string;
  tenantId: TenantId;
  subjectId: SubjectId;
  account: AccountKind;
  amount: Money;
  legNo: number;
  sourceKind: LedgerSourceKind;
  sourceId: string;
  postedAt: Date;
  memo: string | null;
}

export interface PostedTransaction {
  transactionId: string;
  entries: readonly LedgerEntry[];
  /**
   * True when this posting already existed. Same contract as ingest: replaying
   * a posting is a no-op that reports itself, not an error.
   */
  deduplicated: boolean;
}

// --- provider ---------------------------------------------------------------

export type SettlementMode =
  /** Provider accepts priced lines we compose. Stripe, Lago. */
  | 'lines'
  /** Provider holds the price; we send a quantity only. Paddle, and the others
   *  when the operator chose to keep prices provider-side. */
  | 'quantity';

/** What a provider can do. Every branch in billing-kit reads this, never a name. */
export interface ProviderCapabilities {
  settlement: readonly SettlementMode[];
  /**
   * True when the provider is the legal seller. Suppresses our tax hooks and
   * makes our computed amounts advisory. The failure it prevents is a ledger
   * reconciling against a document we did not issue.
   */
  merchantOfRecord: boolean;
  /** False when settling does not collect money (Lago). A settled invoice is
   *  then not a paid one, and no cash posts until a PSP webhook arrives. */
  capturesPayment: boolean;
  /** True when a refund is a request that may be declined (Paddle). The ledger
   *  posts on the webhook, never on the call's return. */
  refundsAreAsynchronous: boolean;
  /** Provider-side request idempotency, if any. Always an optimisation on top
   *  of our own record: every provider's retention window is finite and
   *  shorter than a bad weekend. */
  idempotency: { header: string; retentionHours: number } | null;
}

export interface CustomerRef {
  /** Our key. Idempotency is by this, not by anything the provider minted. */
  key: string;
  subjectId: SubjectId;
  email: string | null;
  name: string | null;
  metadata?: Record<string, string>;
}

export interface ProviderCustomer {
  providerRef: string;
  key: string;
  raw: unknown;
}

export interface ProviderItem {
  itemId: string;
  metric: string;
}

export type SubscriptionStatus = 'active' | 'past_due' | 'paused' | 'cancelled' | 'unknown';

export interface ProviderSubscription {
  providerRef: string;
  status: SubscriptionStatus;
  raw: unknown;
}

export interface SubscriptionInput {
  key: string;
  customerRef: string;
  planKey: string;
  currency: string;
  metadata?: Record<string, string>;
}

export type CancelAt = 'immediately' | 'period_end';

export interface SettlementLine {
  metric: string;
  description: string;
  quantity: Quantity;
  unitRate: Rate;
  amount: Money;
}

export interface SettlementRequest {
  mode: SettlementMode;
  idempotencyKey: string;
  customerId: string;
  subscriptionId: string | null;
  period: UsageWindow;
  currency: string;
  /** Present when mode === 'lines'. Amounts are ours and authoritative. */
  lines?: readonly SettlementLine[];
  /** Present when mode === 'quantity'. No amounts; the provider prices it. */
  quantities?: readonly { itemId: string; quantity: string }[];
}

export type SettlementStatus = 'draft' | 'open' | 'settled' | 'void' | 'failed';

export interface SettlementResult {
  providerRef: string;
  status: SettlementStatus;
  /** What the provider says the period costs. Under `quantity` this is the
   *  first time we learn the real number. Null before they have priced it. */
  providerTotal: Money | null;
  /** Tax the provider computed and owns. Never folded into providerTotal by
   *  us: a merchant-of-record's tax is not our revenue. */
  providerTax: Money | null;
  raw: unknown;
}

export interface RefundInput {
  idempotencyKey: string;
  settlementRef: string;
  amount: Money;
  reason: string;
}

export interface RefundAcknowledgement {
  providerRef: string;
  /** On an asynchronous provider this means accepted, not that money moved. */
  accepted: boolean;
  raw: unknown;
}

/** Bytes, not a parsed body. See `verifyWebhook`. */
export interface RawRequest {
  rawBody: Uint8Array;
  headers: Readonly<Record<string, string | string[] | undefined>>;
}

export type VerifiedEvent = {
  providerEventId: string;
  /** The provider's ordering signal. Webhooks arrive out of order and the
   *  state machine uses this, never wall-clock arrival. */
  occurredAt: Date;
  raw: unknown;
} & (
  | { kind: 'payment.succeeded'; settlementRef: string; amount: Money }
  | { kind: 'payment.failed'; settlementRef: string; reason: string }
  | { kind: 'settlement.finalized'; settlementRef: string; total: Money; tax: Money | null }
  | { kind: 'settlement.voided'; settlementRef: string }
  | { kind: 'refund.settled'; refundRef: string; amount: Money }
  | { kind: 'refund.declined'; refundRef: string; reason: string }
  | { kind: 'subscription.changed'; subscriptionRef: string; status: SubscriptionStatus }
  /** Signature valid, meaning not modelled. Stored raw and acknowledged 200.
   *  This is the contract, not a gap: dropping an unmodelled event silently and
   *  500-ing on it both end with the endpoint disabled at the provider. */
  | { kind: 'unknown'; providerKind: string }
);

export interface BillingProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;

  ensureCustomer(ref: CustomerRef): Promise<ProviderCustomer>;
  /** Recovery path for providers with no request idempotency key. Required. */
  findCustomer(key: string): Promise<ProviderCustomer | null>;

  ensureSubscription(input: SubscriptionInput): Promise<ProviderSubscription>;
  cancelSubscription(id: string, at: CancelAt): Promise<ProviderSubscription>;
  resolveItem(subscriptionId: string, metric: string): Promise<ProviderItem | null>;

  /**
   * Settle one sealed period. `request.mode` is always one the provider
   * declared; the adapter does not choose and never falls back. A silent
   * fallback from `lines` to `quantity` changes who owns the price without
   * telling the ledger, and it surfaces a month later as unexplained drift.
   */
  settle(request: SettlementRequest): Promise<SettlementResult>;
  findSettlement(key: string): Promise<SettlementResult | null>;

  refund(input: RefundInput): Promise<RefundAcknowledgement>;

  /** Takes bytes, because a signature is over bytes. Async because at least one
   *  provider verifies an RS256 JWT against a key it must fetch. */
  verifyWebhook(input: RawRequest): Promise<VerifiedEvent>;
}
