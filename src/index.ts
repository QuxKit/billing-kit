// billing-kit — usage-based billing as a library, over a provider you choose.
//
// This entry point exports the core only: money, the shared vocabulary, ingest
// and the ledger. The provider adapters and the metering engine are separate
// entry points (`billing-kit/providers`, `billing-kit/metering`) rather than
// re-exports from here, for two reasons:
//
//   - An application that meters nothing and settles through one provider
//     should not load the other two adapters to call `Money.fromMinor`.
//   - The three parts are developed independently. A single barrel file makes
//     every one of them a build dependency of the others, so an error in an
//     adapter breaks the typecheck of code that does not use it.
//
// `createBilling` is a factory, not a singleton, and that distinction is the
// whole of the rule this file used to state as "no singleton yet".
// Configuration is still an argument and never a module-level global or
// `process.env` — a library that reads the environment cannot be instantiated
// twice in one process, which is what a test suite and a multi-region worker
// both need. An instance you construct twice keeps that property; a module that
// holds the connection does not.
//
// The free functions below are still the API. `createBilling` binds the
// executor and the clock over them for the common case where an application has
// one of each.

export type { BillingErrorCode, BillingFailure } from './errors';
export { BillingError } from './errors';
export type {
  AggregateUsageQuery,
  AggregationMethod,
  StoredUsageEvent,
  UsageAggregation,
  UsageQuery,
} from './events';
export { aggregateUsage, queryUsage, RECORD_MANY_MAX, record, recordMany, validateEvent } from './events';
export type { Billing, BillingOptions } from './instance';
export { createBilling } from './instance';
export type { BalanceQuery, EntriesQuery } from './ledger';
export {
  accrualPosting,
  assertBalanced,
  balance,
  creditNotePosting,
  ENTRIES_MAX_ROWS,
  entries,
  paymentPosting,
  post,
  refundPosting,
  settlementPosting,
  walletBalance,
  walletRedeemPosting,
  walletTopupPosting,
} from './ledger';
export type { MoneyJSON, PricedAmount, Tier, TierMode } from './money';
export {
  allocate,
  currencyExponent,
  DECIMAL_SCALE,
  isKnownCurrency,
  knownCurrencies,
  Money,
  price,
  priceTiered,
  Quantity,
  Rate,
  scaleFraction,
} from './money';

export type {
  AccountKind,
  BillingProvider,
  CancelAt,
  Clock,
  CustomerRef,
  LedgerEntry,
  LedgerLeg,
  LedgerPosting,
  LedgerSourceKind,
  Logger,
  PostedTransaction,
  ProviderCapabilities,
  ProviderCustomer,
  ProviderItem,
  ProviderSubscription,
  RawRequest,
  RecordedEvent,
  RefundAcknowledgement,
  RefundInput,
  SettlementLine,
  SettlementMode,
  SettlementRequest,
  SettlementResult,
  SettlementStatus,
  SqlExecutor,
  SubjectId,
  SubscriptionInput,
  SubscriptionStatus,
  TenantId,
  UsageEvent,
  UsageWindow,
  VerifiedEvent,
} from './types';
