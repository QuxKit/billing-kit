// providers/types.ts
//
// The provider boundary.
//
// billing-kit owns metering, aggregation, pricing, the ledger and idempotency.
// The provider owns customers, subscriptions, settlement of a closed period,
// payment capture, refunds and webhook signatures. This file is the whole of
// the contract between the two, and it is deliberately smaller than any one
// provider's API.
//
// It is not Stripe's object model with the word Stripe deleted. That interface
// — createInvoice / addLineItem / finalizeInvoice — cannot be implemented by a
// merchant of record, which does not accept arbitrary lines and issues the
// document itself. An adapter that fakes it by accumulating lines in memory
// disagrees with the real invoice the first time tax or a currency conversion
// enters, and the disagreement surfaces as a ledger that will not reconcile.
//
// So the contract is built from where the providers genuinely agree, which is
// `settle(period)` and nothing earlier.
//
// Three anti-patterns are structurally excluded here, each noted at the point
// where the exclusion happens:
//   - crediting a balance from a request body  (search: NO CREDIT)
//   - an unauthenticated billing trigger       (search: NO ENDPOINT)
//   - trusting a client-supplied customer id   (search: NO CLIENT IDS)

import type { Money } from '../money';

// ---------------------------------------------------------------------------
// Provider-side identifiers
// ---------------------------------------------------------------------------

declare const idBrand: unique symbol;

/**
 * An identifier that belongs to the provider, not to us.
 *
 * NO CLIENT IDS. This is the enforcement, and it is a type error rather than a
 * review comment. A provider id can only be obtained from an object an adapter
 * returned — which means it came out of our own database on a subsequent
 * request — or from `providerIdFromOurRecords`, whose name is chosen so that
 * calling it on `req.body.customerId` reads as the mistake it is.
 *
 * The defect this prevents was live in the reference application: a portal
 * endpoint took a Stripe customer id from the client and opened a session
 * against it, which is any customer's billing history for anyone who can guess
 * an id. With this type, `openPortal(req.body.customerId)` does not compile,
 * because `string` is not assignable to `ProviderId<'customer'>`.
 */
export type ProviderId<Kind extends string> = string & { readonly [idBrand]: Kind };

export type ProviderCustomerId = ProviderId<'customer'>;
export type ProviderSubscriptionId = ProviderId<'subscription'>;
export type ProviderItemId = ProviderId<'item'>;
export type ProviderSettlementId = ProviderId<'settlement'>;
export type ProviderRefundId = ProviderId<'refund'>;

/**
 * Lift a raw string we stored ourselves back into a provider id.
 *
 * The only legitimate caller is the persistence layer rehydrating a row it
 * wrote from an adapter's return value. It is exported because that layer is in
 * another module, and it is greppable so a review can check every call site.
 * There are no others by design.
 */
export const providerIdFromOurRecords = <Kind extends string>(stored: string): ProviderId<Kind> =>
  stored as ProviderId<Kind>;

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export type SettlementMode =
  /** The provider accepts priced lines we compose. Stripe, Lago. */
  | 'lines'
  /** The provider holds the price; we send a quantity and it decides the
   *  amount. Paddle, and Stripe or Lago when the operator chose to keep prices
   *  on the provider side. */
  | 'quantity';

export interface ProviderIdempotency {
  /** Header name, e.g. `Idempotency-Key`. */
  header: string;
  /**
   * How long the provider remembers a key. Always shorter than a bad weekend,
   * which is why our own `idempotency_records` table exists regardless and this
   * is an optimisation on top of it, never a substitute.
   */
  retentionHours: number;
}

/**
 * What a provider can do.
 *
 * billing-kit branches on this and never on `provider.name`. That rule is what
 * keeps a fourth provider from being a rewrite, and it is enforceable in review
 * by grepping the source for `.name` — outside of logging and error
 * construction there should be no hits.
 */
export interface ProviderCapabilities {
  /** Every mode this provider will accept. Paddle declares exactly one. */
  readonly settlement: readonly SettlementMode[];
  /**
   * True when the provider is the legal seller. Its total is authoritative and
   * ours is an estimate; its tax is its liability, not our revenue. The ledger
   * records both numbers and posts the difference to a variance account rather
   * than absorbing it.
   */
  readonly merchantOfRecord: boolean;
  /**
   * False when settling does not collect money — Lago invoices and hands off to
   * a PSP. Callers must not read `status: 'settled'` as paid; cash posts on a
   * payment webhook that may arrive days later.
   */
  readonly capturesPayment: boolean;
  /**
   * True when a refund is a request a human may decline. The ledger posts on
   * the webhook in every case anyway, so the two paths stay identical and the
   * synchronous provider does not grow a second code path that only it uses.
   */
  readonly refundsAreAsynchronous: boolean;
  /**
   * True when the provider retries a failed payment on its own schedule.
   *
   * The one capability that exists to stop us doing something rather than to
   * let us. Stripe's Smart Retries and Paddle's recovery both charge the card
   * again and both email the customer; a dunning policy that also retries
   * charges twice and mails twice, and the customer reads that as our bug.
   * `dunning/forProvider()` reads this and forces the policy to observe.
   *
   * Required rather than optional on purpose. The safe default would have to be
   * `false`, and a provider adapter that forgot to say so would silently opt
   * its users into double-dunning; a required field makes the omission a
   * compile error in the adapter instead.
   */
  readonly retriesPayments: boolean;
  /** Provider-side request idempotency, if any. Null is a real answer. */
  readonly idempotency: ProviderIdempotency | null;
  /**
   * True when a subscription can be created by an API call.
   *
   * It is false on a checkout-driven provider, where a subscription only comes
   * into existence when a customer completes a payment flow and first appears
   * on a `subscription.changed` webhook. That is a genuine difference in what
   * the provider *is*, not a missing endpoint, and the interface states it:
   * `ensureSubscription` is present on the type only when this is true, so the
   * call does not compile against a provider that cannot serve it.
   */
  readonly createsSubscriptions: boolean;
  /**
   * What `findCustomer` can search by.
   *
   * Recovery after an ambiguous create depends on being able to ask "did this
   * land?", and providers differ in what they will answer that question about.
   * A provider that indexes only email cannot find a customer created without
   * one, and a caller that assumes otherwise creates a duplicate customer every
   * time a request times out.
   */
  readonly customerLookup: readonly ('key' | 'email')[];
}

/** The settlement modes a particular provider's capabilities admit. */
export type SettlementModeOf<Caps extends ProviderCapabilities> = Caps['settlement'][number];

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * How we name a customer. `key` is ours — our subject id — and it is the only
 * thing that crosses the boundary in that direction.
 */
export interface CustomerRef {
  /** Our subject id. Stable for the life of the subject, never reused. */
  key: string;
  /** Used by providers that dedupe on email. Not an identifier for us. */
  email?: string;
  name?: string;
  /** Two-letter country code, when the provider needs it for tax. */
  country?: string;
}

export interface ProviderCustomer {
  id: ProviderCustomerId;
  /** Our key, read back from the provider, so a mismatch is detectable. */
  key: string | null;
  email: string | null;
  raw: unknown;
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'paused' | 'canceled' | 'incomplete' | 'unknown';

export interface SubscriptionInput {
  /** Ours. See NO CLIENT IDS above — the adapter resolves the provider id. */
  customerId: ProviderCustomerId;
  /** Our plan key: regular, elite, pro, enterprise. */
  planKey: string;
  /** Provider-side price identifiers this plan maps to. */
  items: readonly { priceId: string; quantity?: string }[];
  currency: string;
  idempotencyKey: string;
}

export interface ProviderSubscription {
  id: ProviderSubscriptionId;
  status: SubscriptionStatus;
  currentPeriod: { start: Date; end: Date } | null;
  raw: unknown;
}

export type CancelAt = 'immediately' | 'period_end';

/** The thing a quantity is pushed against, resolved from our metric key. */
export interface ProviderItem {
  id: ProviderItemId;
  /** Our metric key, as read back from the provider's metadata. */
  metric: string;
  raw: unknown;
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

export interface SettlementLine {
  /** Our metric or product key. Appears on the invoice. */
  description: string;
  /** Exact decimal string. Not a number — a gigabyte-hour is not an integer
   *  and a float quantity multiplied by a rate is a wrong total. */
  quantity: string;
  /** What we computed. Authoritative under `lines`, ignored otherwise. */
  amount: Money;
  /** Free-form, passed through to the provider for reconciliation. */
  metadata?: Readonly<Record<string, string>>;
}

export interface SettlementQuantity {
  itemId: ProviderItemId;
  /** Exact decimal string, as above. */
  quantity: string;
}

interface SettlementCommon {
  /** Ours, and the recovery handle. Must be derived from the period being
   *  settled so that the same period always produces the same key. */
  idempotencyKey: string;
  customerId: ProviderCustomerId;
  subscriptionId: ProviderSubscriptionId | null;
  /** Half-open, [start, end). Consecutive periods can then neither gap nor
   *  overlap. */
  period: { start: Date; end: Date };
  currency: string;
  metadata?: Readonly<Record<string, string>>;
}

/**
 * Two request shapes, not one optional field.
 *
 * A single interface with `lines?` and `quantities?` compiles when both are
 * missing and fails at runtime inside the adapter, at which point the period is
 * half-settled. The discriminated union makes the wrong request unrepresentable
 * instead.
 */
export type SettlementRequest<Mode extends SettlementMode = SettlementMode> = Extract<
  | (SettlementCommon & { mode: 'lines'; lines: readonly SettlementLine[] })
  | (SettlementCommon & { mode: 'quantity'; quantities: readonly SettlementQuantity[] }),
  { mode: Mode }
>;

export type SettlementStatus = 'draft' | 'open' | 'settled' | 'void' | 'failed';

export interface SettlementResult {
  ref: ProviderSettlementId;
  /**
   * `settled` means the provider considers the period closed. It does NOT mean
   * paid unless `capabilities.capturesPayment` is true. Reading it as paid on a
   * provider that only invoices posts cash that never arrived.
   */
  status: SettlementStatus;
  /**
   * What the provider says the period costs. Under `quantity` this is the first
   * time we learn the real number. Null when it has not priced it yet, which is
   * normal on a merchant of record and arrives later on
   * `settlement.finalized` — a null here is not an error and must not be
   * defaulted to zero.
   */
  providerTotal: Money | null;
  /** Tax the provider computed and owns. Never folded into `providerTotal` by
   *  us: a merchant of record's tax is its liability, not our revenue. */
  providerTax: Money | null;
  raw: unknown;
}

/**
 * Everything needed to find a settlement again after an ambiguous failure.
 *
 * This deviates from the original sketch, which was `findSettlement(key)`. That
 * signature is not implementable on a provider whose list endpoints filter by
 * customer and date but not by arbitrary metadata — the second adapter turned
 * that up immediately. The caller always holds these fields, because they are
 * the same ones it just passed to `settle`, so widening the parameter costs
 * nothing and removes a provider class from the "cannot implement" column.
 */
export interface SettlementLookup {
  key: string;
  customerId: ProviderCustomerId;
  period: { start: Date; end: Date };
}

// ---------------------------------------------------------------------------
// Money out
// ---------------------------------------------------------------------------

export interface RefundInput {
  /** Ours. */
  idempotencyKey: string;
  settlementRef: ProviderSettlementId;
  /** Null refunds the whole settlement. */
  amount: Money | null;
  reason?: string;
}

export interface RefundAcknowledgement {
  ref: ProviderRefundId;
  /**
   * `pending` is the normal answer on a provider where refunds are approved by
   * a human. It is not a failure and must not be retried — the request landed.
   */
  status: 'pending' | 'settled' | 'declined';
  raw: unknown;
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

export interface RawRequest {
  /**
   * The bytes exactly as received. Not a parsed object, not a re-serialised
   * string.
   *
   * A signature is computed over bytes. `JSON.parse` then `JSON.stringify`
   * changes key order, whitespace and number formatting, the HMAC no longer
   * matches, and every webhook fails verification with no clue why. This is the
   * single most common integration bug in payment code, and the parameter type
   * is the defence: there is no overload taking an object.
   */
  body: Uint8Array;
  headers: Readonly<Record<string, string | string[] | undefined>>;
}

interface VerifiedEventBase {
  /** The provider's event id. Unique key for our `provider_events` table. */
  providerEventId: string;
  /**
   * The provider's own ordering signal. Webhooks arrive out of order; state
   * transitions are guarded by this and never by wall-clock arrival. A
   * `settlement.voided` that overtakes the `settlement.finalized` it voids must
   * not resurrect the settlement.
   */
  occurredAt: Date;
  raw: unknown;
}

/**
 * The normalised event union, deliberately smaller than any provider's
 * catalogue.
 *
 * NO CREDIT. There is no event or method on this boundary that moves money into
 * a balance on our say-so. Cash posts to the ledger from `payment.succeeded`
 * and from nowhere else, and a `payment.succeeded` can only be produced by
 * `verifyWebhook` — the mapping functions that build one are module-private in
 * every adapter and are not exported. The reference application credited a
 * balance straight from a request body with no processor call; here there is no
 * function to call with a request body.
 */
export type VerifiedEvent = VerifiedEventBase &
  (
    | { kind: 'payment.succeeded'; settlementRef: string; amount: Money }
    | { kind: 'payment.failed'; settlementRef: string; reason: string }
    | { kind: 'settlement.finalized'; settlementRef: string; total: Money; tax: Money | null }
    | { kind: 'settlement.voided'; settlementRef: string }
    | { kind: 'refund.settled'; refundRef: string; settlementRef: string | null; amount: Money }
    | { kind: 'refund.declined'; refundRef: string; reason: string }
    | { kind: 'subscription.changed'; subscriptionRef: string; status: SubscriptionStatus }
    /**
     * Signature valid, meaning not modelled. Stored raw and acknowledged 200.
     *
     * This is the contract, not a gap. A kit that invents a normalised kind for
     * every provider event ends up with one provider's catalogue and two others
     * crammed into it. Dropping the event silently and returning 500 both end
     * the same way: a provider that disables the endpoint.
     */
    | { kind: 'unknown'; providerKind: string }
  );

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

/**
 * What every adapter implements.
 *
 * NO ENDPOINT. Nothing here is an HTTP handler, and billing-kit exports no
 * route. The reference application shipped a billing trigger whose shared
 * secret check was commented out; there is nothing here to comment out, because
 * how a run is triggered and authenticated belongs to the host application and
 * is documented rather than shipped.
 *
 * `Caps` is a type parameter so that a provider can be described precisely
 * enough for the compiler to reject a call it cannot serve. See `settle`.
 */
export type BillingProvider<Caps extends ProviderCapabilities = ProviderCapabilities> = ProviderCore<Caps> &
  SubscriptionCreation<Caps>;

/**
 * The half of the interface that varies by capability.
 *
 * When a provider declares `createsSubscriptions: true` the method is required
 * and callable. Otherwise it is optional and absent, so `provider.ensureSubscription(x)`
 * is a compile error under `strictNullChecks` rather than a runtime throw
 * discovered by a customer at checkout. The optional form is deliberate rather
 * than `never`: it keeps a concrete provider assignable to the general
 * `BillingProvider`, which polymorphic code needs.
 */
export type SubscriptionCreation<Caps extends ProviderCapabilities> = Caps['createsSubscriptions'] extends true
  ? {
      ensureSubscription(input: SubscriptionInput): Promise<ProviderSubscription>;
    }
  : {
      ensureSubscription?: (input: SubscriptionInput) => Promise<ProviderSubscription>;
    };

interface ProviderCore<Caps extends ProviderCapabilities = ProviderCapabilities> {
  /** For logs, metrics and error messages. Never branched on. */
  readonly name: string;
  readonly capabilities: Caps;

  // --- identity ------------------------------------------------------------

  /**
   * Idempotent by `ref.key`, which is ours.
   *
   * "A customer with this email already exists" is success, not failure, and
   * the adapter must return the existing id. A provider that dedupes on email
   * answers a create with a conflict, and an adapter that propagates it makes
   * every retry after a timeout permanently fatal.
   */
  ensureCustomer(ref: CustomerRef): Promise<ProviderCustomer>;

  /**
   * Look up by our reference. Required, not optional.
   *
   * This is the recovery path for providers with no request idempotency key:
   * after a timeout we cannot safely repeat a create, so we must be able to ask
   * whether the first one landed. It takes the full ref rather than the key
   * alone because some providers can only search by email, which is also what
   * `capabilities.customerLookup` declares — a ref missing the field this
   * provider indexes raises `unsupported` rather than answering `null`, because
   * `null` here means "it did not land" and would cause a duplicate create.
   */
  findCustomer(ref: CustomerRef): Promise<ProviderCustomer | null>;

  // --- subscriptions -------------------------------------------------------
  //
  // `ensureSubscription` is not here. It lives on `SubscriptionCreation` above,
  // present only when the provider declares it can create one.

  cancelSubscription(id: ProviderSubscriptionId, at: CancelAt): Promise<ProviderSubscription>;

  /**
   * Resolve our metric key to the provider-side item a quantity is pushed
   * against. Null when this provider holds no price for that metric, which is
   * the normal answer where prices live on our side.
   */
  resolveItem(subscriptionId: ProviderSubscriptionId, metric: string): Promise<ProviderItem | null>;

  // --- settlement ----------------------------------------------------------

  /**
   * Settle one sealed period.
   *
   * The parameter is narrowed to the modes this provider declared, so asking a
   * merchant of record for `lines` is a compile error at every statically typed
   * call site rather than a throw halfway through a period. The runtime guard
   * in `capabilities.ts` exists only for the dynamic path, where the mode was
   * chosen from a database row.
   *
   * The adapter never falls back between modes. A silent fallback from `lines`
   * to `quantity` changes who owns the price without telling the ledger, and
   * the discrepancy surfaces a month later as drift nobody can source.
   */
  settle(request: SettlementRequest<SettlementModeOf<Caps>>): Promise<SettlementResult>;

  /** Recovery counterpart to `settle`. Null means it never landed. */
  findSettlement(lookup: SettlementLookup): Promise<SettlementResult | null>;

  // --- money out -----------------------------------------------------------

  /**
   * Request a refund.
   *
   * Where `refundsAreAsynchronous`, a resolved promise means the request was
   * accepted, not that money moved. The ledger posts on the webhook in both
   * cases.
   */
  refund(input: RefundInput): Promise<RefundAcknowledgement>;

  // --- inbound -------------------------------------------------------------

  /**
   * Verify and normalise an inbound webhook.
   *
   * Async even where the verification is a pure HMAC, because one provider
   * verifies an RS256 JWT against a key it must fetch. Shaping the signature to
   * the strictest member is not a concession to that provider; it is what stops
   * a fourth one forcing a breaking change on everybody.
   *
   * Throws `ProviderError` with kind `signature_invalid` or `signature_stale`.
   * It never returns a partially trusted result — there is no "unverified"
   * variant of the return type to accidentally use.
   */
  verifyWebhook(input: RawRequest): Promise<VerifiedEvent>;
}
