// providers/index.ts
//
// The provider layer's public surface, and no more of it.
//
// What is deliberately not exported:
//
//   normaliseStripeEvent / normalisePaddleEvent — the functions that turn a
//     request body into something the ledger acts on. They are reachable only
//     through `verifyWebhook`, which means there is no code path anywhere that
//     credits an account from an unverified payload. That is the structural
//     form of the check the reference application had commented out.
//
//   the HTTP client and the signature primitives — internal mechanics. A host
//     application that can reach them can construct provider calls that bypass
//     the idempotency the interface guarantees.

export {
  assertSettlementMode,
  canCreateSubscriptions,
  canFindCustomer,
  ourAmountIsAuthoritative,
  settlementModeFor,
  settlementPostsCash,
  supportsSettlement,
  taxIsOurs,
} from './capabilities';
export { isProviderError, ProviderError, type ProviderErrorKind } from './errors';
/** Injected in tests and in any runtime without a global `fetch`. */
export type { FetchLike, HttpRequestInit, HttpResponseLike } from './http';
export {
  createPaddleProvider,
  type PaddleCapabilities,
  type PaddleConfig,
} from './paddle';
export {
  createStripeProvider,
  STRIPE_CAPABILITIES,
  type StripeCapabilities,
  type StripeConfig,
} from './stripe';
export type {
  BillingProvider,
  CancelAt,
  CustomerRef,
  ProviderCapabilities,
  ProviderCustomer,
  ProviderCustomerId,
  ProviderId,
  ProviderIdempotency,
  ProviderItem,
  ProviderItemId,
  ProviderRefundId,
  ProviderSettlementId,
  ProviderSubscription,
  ProviderSubscriptionId,
  RawRequest,
  RefundAcknowledgement,
  RefundInput,
  SettlementLine,
  SettlementLookup,
  SettlementMode,
  SettlementModeOf,
  SettlementQuantity,
  SettlementRequest,
  SettlementResult,
  SettlementStatus,
  SubscriptionInput,
  SubscriptionStatus,
  VerifiedEvent,
} from './types';
export { providerIdFromOurRecords } from './types';
