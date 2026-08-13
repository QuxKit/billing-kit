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
// There is no `createBilling` singleton here yet. Configuration is an argument,
// never a module-level global and never `process.env`: a library that reads the
// environment cannot be instantiated twice in one process, which is what a test
// suite and a multi-region worker both need.

export {
  Money,
  Quantity,
  Rate,
  price,
  allocate,
  currencyExponent,
  isKnownCurrency,
  knownCurrencies,
  DECIMAL_SCALE,
} from './money';
export type { MoneyJSON, PricedAmount } from './money';

export { BillingError } from './errors';
export type { BillingFailure, BillingErrorCode } from './errors';

export { record, recordMany, queryUsage, validateEvent } from './events';
export type { UsageQuery, StoredUsageEvent } from './events';

export {
  post,
  balance,
  entries,
  assertBalanced,
  accrualPosting,
  settlementPosting,
  paymentPosting,
  refundPosting,
} from './ledger';
export type { BalanceQuery, EntriesQuery } from './ledger';

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
  UsageAggregate,
  UsageEvent,
  UsageWindow,
  VerifiedEvent,
} from './types';
