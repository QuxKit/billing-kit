// providers/paddle/index.ts
//
// The Paddle adapter, which is why the interface looks the way it does.
//
// Paddle is the merchant of record. It is the legal seller, it computes and
// remits the tax, and it issues the document. There is no call that says "put
// this line on this invoice for this amount", so the Stripe-shaped interface —
// createInvoice, addLineItem, finalizeInvoice — is not merely awkward here, it
// is unimplementable. Every one of the following is a real difference the
// abstraction had to absorb rather than paper over:
//
//   settle          quantity only. We send a quantity against a price Paddle
//                   holds and Paddle decides the amount. Our computed number is
//                   an estimate from that point on, and the ledger records both
//                   ours and theirs rather than pretending they agree.
//   providerTotal   null on the way out, and arrives later on
//                   `settlement.finalized`. It is not zero and must never be
//                   defaulted to zero.
//   refund          a request an approver may decline. `pending` is a success.
//   subscriptions   cannot be created by an API call at all; they come into
//                   existence when a customer completes a checkout. The type
//                   says so — `ensureSubscription` is absent — rather than the
//                   adapter throwing at the point of sale.
//   findCustomer    email only. Paddle does not index `custom_data`, so a ref
//                   without an email cannot be recovered and the adapter says
//                   so instead of returning null, which would read as "the
//                   create never landed" and produce a duplicate customer.
//   findSettlement  needs the customer and the period, not just our key, for
//                   the same reason. That is why `SettlementLookup` is a record
//                   rather than a string.
//
// Provenance note: the endpoint shapes here are written from Paddle's published
// API behaviour as understood at the time of writing, not from a live account.
// The fixtures pin the adapter's own logic; they do not prove Paddle's contract.
// Validate against a sandbox before release.

import { asWholeQuantity, optionalMoneyFromMinorString } from '../amounts';
import { isProviderError, ProviderError } from '../errors';
import { createHttpClient, type FetchLike, type HttpClient } from '../http';
import { singleHeader, verifyTimestampedHmac } from '../signature';
import type {
  BillingProvider,
  CancelAt,
  CustomerRef,
  ProviderCapabilities,
  ProviderCustomer,
  ProviderCustomerId,
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
  SettlementLookup,
  SettlementRequest,
  SettlementResult,
  SettlementStatus,
  SubscriptionStatus,
  VerifiedEvent,
} from '../types';
import { normalisePaddleEvent, object, PADDLE, str } from './events';

/**
 * Paddle's capabilities.
 *
 * Written as an interface with literal members rather than an `as const`
 * object, because `idempotency` is configurable (see below) and the rest must
 * still be literal for `settle` to narrow to `'quantity'`.
 */
export interface PaddleCapabilities extends ProviderCapabilities {
  readonly settlement: readonly ['quantity'];
  readonly merchantOfRecord: true;
  readonly capturesPayment: true;
  readonly refundsAreAsynchronous: true;
  readonly createsSubscriptions: false;
  readonly customerLookup: readonly ['email'];
}

export interface PaddleConfig {
  /** API key, `pdl_live_…` or `pdl_sdbx_…`. */
  apiKey: string;
  /** Notification-setting secret, `pdl_ntfset_…`. A different secret from the
   *  API key; verifying with the API key rejects every webhook. */
  webhookSecret: string;
  /** Defaults to production. Point at the sandbox host, or at a fixture. */
  baseUrl?: string;
  /** `custom_data` key holding our subject id on a customer. */
  subjectKey?: string;
  /** `custom_data` key holding our settlement idempotency key on a transaction. */
  settlementKey?: string;
  /** `custom_data` key on a Price naming the metric it bills. */
  metricKey?: string;
  /**
   * Opt in to a provider-side request idempotency header.
   *
   * Defaults to null, and the default is the load-bearing part. The
   * architecture document records Paddle as having a request idempotency key;
   * that could not be confirmed against a live account here, and declaring one
   * that does not exist is not a documentation error — `http.ts` treats the
   * presence of a key as permission to retry a POST, so a wrong `yes` here is
   * how a customer gets charged twice. A wrong `no` costs one extra lookup on
   * the recovery path. The asymmetry decides the default.
   */
  idempotency?: ProviderIdempotency | null;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  webhookToleranceSeconds?: number;
  timeoutMs?: number;
  maxAttempts?: number;
}

const DEFAULT_BASE_URL = 'https://api.paddle.com';

const settlementStatus = (status: unknown): SettlementStatus => {
  switch (status) {
    case 'draft':
      return 'draft';
    case 'ready':
    case 'billed':
      return 'open';
    case 'paid':
    case 'completed':
      return 'settled';
    case 'canceled':
      return 'void';
    case 'past_due':
      return 'failed';
    default:
      return 'open';
  }
};

const subscriptionStatus = (value: unknown): SubscriptionStatus => {
  switch (value) {
    case 'trialing':
    case 'active':
    case 'past_due':
    case 'paused':
    case 'canceled':
      return value;
    default:
      return 'unknown';
  }
};

/** Paddle wraps every response in `{ data, meta }`. */
const dataOf = (payload: unknown): unknown => object(payload).data;

const listOf = (payload: unknown): unknown[] => {
  const data = object(payload).data;
  return Array.isArray(data) ? data : [];
};

const customData = (record: Record<string, unknown>): Record<string, unknown> => {
  const custom = record.custom_data;
  return typeof custom === 'object' && custom !== null ? (custom as Record<string, unknown>) : {};
};

export const createPaddleProvider = (config: PaddleConfig): BillingProvider<PaddleCapabilities> => {
  const subjectKey = config.subjectKey ?? 'billing_kit_subject';
  const settlementKey = config.settlementKey ?? 'billing_kit_settlement';
  const metricKey = config.metricKey ?? 'billing_kit_metric';
  const idempotency = config.idempotency ?? null;

  const capabilities: PaddleCapabilities = {
    settlement: ['quantity'],
    merchantOfRecord: true,
    capturesPayment: true,
    refundsAreAsynchronous: true,
    createsSubscriptions: false,
    customerLookup: ['email'],
    idempotency,
  };

  const http: HttpClient = createHttpClient({
    provider: PADDLE,
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      accept: 'application/json',
    },
    fetch: config.fetch,
    sleep: config.sleep,
    random: config.random,
    timeoutMs: config.timeoutMs,
    maxAttempts: config.maxAttempts,
  });

  /**
   * Attach an idempotency key only if the provider was configured as having
   * one. When it has none the request carries no key, `http.ts` refuses to
   * retry the POST, and a mid-flight failure surfaces as `ambiguous` — which
   * routes the caller to `findCustomer` / `findSettlement` instead of to a
   * second charge.
   */
  const withKey = (key: string) =>
    idempotency === null ? {} : { idempotencyKey: key, headers: { [idempotency.header]: key } };

  const toCustomer = (raw: unknown): ProviderCustomer => {
    const record = object(raw);
    const custom = customData(record);
    return {
      id: str(record.id, 'customer.id') as ProviderCustomerId,
      key: typeof custom[subjectKey] === 'string' ? (custom[subjectKey] as string) : null,
      email: typeof record.email === 'string' ? record.email : null,
      raw,
    };
  };

  const toSubscription = (raw: unknown): ProviderSubscription => {
    const record = object(raw);
    const period = record.current_billing_period;
    const bounds = typeof period === 'object' && period !== null ? (period as Record<string, unknown>) : null;
    return {
      id: str(record.id, 'subscription.id') as ProviderSubscriptionId,
      status: subscriptionStatus(record.status),
      currentPeriod:
        bounds && typeof bounds.starts_at === 'string' && typeof bounds.ends_at === 'string'
          ? { start: new Date(bounds.starts_at), end: new Date(bounds.ends_at) }
          : null,
      raw,
    };
  };

  const toSettlement = (raw: unknown): SettlementResult => {
    const transaction = object(raw);
    const currency = String(transaction.currency_code ?? '').toUpperCase();
    const details = transaction.details;
    const totals =
      typeof details === 'object' && details !== null
        ? ((details as Record<string, unknown>).totals as Record<string, unknown> | undefined)
        : undefined;

    return {
      ref: str(transaction.id, 'transaction.id') as ProviderSettlementId,
      status: settlementStatus(transaction.status),
      // Null here is the normal answer, not a failure. Paddle has not priced
      // the transaction yet; the real number arrives on `settlement.finalized`.
      // Defaulting it to zero would post a zero-revenue period that reconciles
      // against nothing.
      providerTotal:
        totals === undefined
          ? null
          : optionalMoneyFromMinorString(totals.total, currency, PADDLE, 'details.totals.total'),
      providerTax:
        totals === undefined ? null : optionalMoneyFromMinorString(totals.tax, currency, PADDLE, 'details.totals.tax'),
      raw,
    };
  };

  // --- identity ------------------------------------------------------------

  const findByEmail = async (email: string, key: string): Promise<ProviderCustomer | null> => {
    const page = await http.request<unknown>({
      method: 'GET',
      path: '/customers',
      query: { email, per_page: 50 },
    });
    const candidates = listOf(page).map(toCustomer);
    // Prefer the one carrying our subject id. Falling back to a lone email
    // match is what makes the first-ever recovery work, before any customer has
    // our custom_data on it.
    return (
      candidates.find((candidate) => candidate.key === key) ??
      (candidates.length === 1 ? (candidates[0] ?? null) : null)
    );
  };

  const findCustomer = async (ref: CustomerRef): Promise<ProviderCustomer | null> => {
    if (ref.email === undefined) {
      // Not `null`. Null means "it did not land", and the caller's response to
      // that is to create one — which on a provider that deduplicates by email
      // is either a duplicate or a permanent conflict.
      throw new ProviderError({
        kind: 'unsupported',
        provider: PADDLE,
        message:
          `paddle: findCustomer needs an email. Paddle does not index custom_data, so our ` +
          `subject id is not searchable; capabilities.customerLookup declares ['email'].`,
      });
    }
    return findByEmail(ref.email, ref.key);
  };

  const ensureCustomer = async (ref: CustomerRef): Promise<ProviderCustomer> => {
    if (ref.email === undefined) {
      throw new ProviderError({
        kind: 'invalid_request',
        provider: PADDLE,
        message: 'paddle: a customer requires an email; Paddle identifies customers by it.',
      });
    }
    try {
      const created = await http.request<unknown>({
        method: 'POST',
        path: '/customers',
        json: { email: ref.email, name: ref.name, custom_data: { [subjectKey]: ref.key } },
        ...withKey(`customer:${ref.key}`),
      });
      return toCustomer(dataOf(created));
    } catch (error) {
      // "A customer with this email already exists" is success. Paddle
      // deduplicates on email server-side and answers a create with a conflict;
      // an adapter that propagates it makes every retry after a timeout
      // permanently fatal, which is the state a subject gets stuck in forever.
      if (isProviderError(error) && error.kind === 'conflict') {
        const existing = await findByEmail(ref.email, ref.key);
        if (existing) return existing;
      }
      // No key means a mid-flight failure is ambiguous rather than retryable,
      // and the recovery is a lookup. Doing it here rather than leaving it to
      // the caller keeps the "did it land?" question next to the call that
      // raised it.
      if (isProviderError(error) && error.kind === 'ambiguous') {
        const existing = await findByEmail(ref.email, ref.key);
        if (existing) return existing;
      }
      throw error;
    }
  };

  // --- subscriptions -------------------------------------------------------
  //
  // No `ensureSubscription`. Paddle subscriptions are created by a customer
  // completing a checkout, not by us calling an endpoint, and the capability
  // says so: `createsSubscriptions: false` removes the method from the type.

  const cancelSubscription = async (id: ProviderSubscriptionId, at: CancelAt): Promise<ProviderSubscription> => {
    const raw = await http.request<unknown>({
      method: 'POST',
      path: `/subscriptions/${id}/cancel`,
      json: { effective_from: at === 'immediately' ? 'immediately' : 'next_billing_period' },
      ...withKey(`cancel:${id}:${at}`),
    });
    return toSubscription(dataOf(raw));
  };

  const resolveItem = async (subscriptionId: ProviderSubscriptionId, metric: string): Promise<ProviderItem | null> => {
    const raw = await http.request<unknown>({
      method: 'GET',
      path: `/subscriptions/${subscriptionId}`,
    });
    const items = object(dataOf(raw)).items;
    if (!Array.isArray(items)) return null;
    for (const entry of items) {
      const price = object(object(entry).price ?? {});
      if (customData(price)[metricKey] !== metric) continue;
      return { id: str(price.id, 'price.id') as ProviderItemId, metric, raw: price };
    }
    return null;
  };

  // --- settlement ----------------------------------------------------------

  const settle = async (request: SettlementRequest<'quantity'>): Promise<SettlementResult> => {
    const items = request.quantities.map((item) => {
      const whole = asWholeQuantity(item.quantity);
      if (whole === null) {
        // Named, not truncated. Paddle multiplies an integer quantity by a
        // price it holds; there is no way to express 1.5 of something, and
        // rounding it here would be a billing error with no error.
        throw new ProviderError({
          kind: 'invalid_request',
          provider: PADDLE,
          message:
            `paddle: quantity '${item.quantity}' for price ${item.itemId} is not a whole ` +
            `number. Paddle prices by integer quantity and there is no line-amount mode to ` +
            `fall back to — aggregate to a whole unit, or bill a smaller unit.`,
        });
      }
      return { price_id: item.itemId, quantity: Number(whole) };
    });

    const created = await http.request<unknown>({
      method: 'POST',
      path: '/transactions',
      json: {
        customer_id: request.customerId,
        collection_mode: 'automatic',
        items,
        billing_period: {
          starts_at: request.period.start.toISOString(),
          ends_at: request.period.end.toISOString(),
        },
        // Our key travels on the object, because it is the only handle
        // `findSettlement` has after an ambiguous failure.
        custom_data: { ...request.metadata, [settlementKey]: request.idempotencyKey },
      },
      ...withKey(request.idempotencyKey),
    });

    return toSettlement(dataOf(created));
  };

  const findSettlement = async (lookup: SettlementLookup): Promise<SettlementResult | null> => {
    // Paddle cannot filter on `custom_data`, so this is a bounded list plus a
    // local match. That constraint is the reason the interface takes a lookup
    // record rather than a bare key: with only the key there is nothing to
    // bound the list by, and an unbounded scan of a customer's whole history is
    // not a recovery path.
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const response = await http.request<unknown>({
        method: 'GET',
        path: '/transactions',
        query: {
          customer_id: lookup.customerId,
          'created_at[GTE]': lookup.period.start.toISOString(),
          per_page: 50,
          after,
        },
      });
      const rows = listOf(response);
      for (const row of rows) {
        if (customData(object(row))[settlementKey] === lookup.key) return toSettlement(row);
      }
      if (rows.length < 50) return null;
      const last = rows[rows.length - 1];
      after = last === undefined ? undefined : str(object(last).id, 'transaction.id');
    }
    return null;
  };

  // --- money out -----------------------------------------------------------

  const refund = async (input: RefundInput): Promise<RefundAcknowledgement> => {
    // A Paddle refund is an adjustment allocated across the transaction's
    // lines. A full refund needs no allocation; a partial one does, and we hold
    // no allocation policy — so a partial refund is only expressible when there
    // is exactly one line to allocate it to. Anything else is refused with the
    // reason, rather than guessed at.
    let items: unknown;
    if (input.amount !== null) {
      const transaction = object(
        dataOf(await http.request<unknown>({ method: 'GET', path: `/transactions/${input.settlementRef}` })),
      );
      const lines = transaction.items;
      if (!Array.isArray(lines) || lines.length !== 1) {
        throw new ProviderError({
          kind: 'invalid_request',
          provider: PADDLE,
          message:
            `paddle: a partial refund must be allocated across the transaction's lines, and ` +
            `${input.settlementRef} has ${Array.isArray(lines) ? lines.length : 0}. Refund the ` +
            `whole settlement, or allocate the amount in the caller where the policy lives.`,
          raw: transaction,
        });
      }
      const detail = object(object(lines[0]).price ?? {});
      items = [
        {
          item_id: str(object(lines[0]).id ?? detail.id, 'transaction.items[0].id'),
          type: 'partial',
          amount: input.amount.minor.toString(),
        },
      ];
    }

    const raw = object(
      dataOf(
        await http.request<unknown>({
          method: 'POST',
          path: '/adjustments',
          json: {
            action: 'refund',
            transaction_id: input.settlementRef,
            reason: input.reason ?? 'billing-kit refund',
            ...(items === undefined ? { type: 'full' } : { type: 'partial', items }),
          },
          ...withKey(input.idempotencyKey),
        }),
      ),
    );

    const status = raw.status;
    return {
      ref: str(raw.id, 'adjustment.id') as ProviderRefundId,
      // `pending` is the normal, successful answer here: an approver has not
      // looked at it yet. Treating it as a failure and retrying files a second
      // refund request for the same money.
      status: status === 'approved' ? 'settled' : status === 'rejected' ? 'declined' : 'pending',
      raw,
    };
  };

  // --- inbound -------------------------------------------------------------

  const verifyWebhook = async (input: RawRequest): Promise<VerifiedEvent> => {
    const header = singleHeader(input.headers, 'paddle-signature');
    if (header === null) {
      throw new ProviderError({
        kind: 'signature_invalid',
        provider: PADDLE,
        message: 'paddle: missing or repeated Paddle-Signature header',
      });
    }

    // Same construction as Stripe's, different punctuation: pairs separated by
    // `;`, payload joined by `:`. Two configuration values rather than a second
    // implementation, so a bug fixed in one is fixed in both.
    const verdict = verifyTimestampedHmac({
      body: input.body,
      header,
      secret: config.webhookSecret,
      pairSeparator: ';',
      payloadSeparator: ':',
      timestampKey: 'ts',
      signatureKey: 'h1',
      toleranceSeconds: config.webhookToleranceSeconds,
      now: config.now,
    });

    if (!verdict.ok) {
      throw new ProviderError({
        kind: verdict.reason === 'stale' ? 'signature_stale' : 'signature_invalid',
        provider: PADDLE,
        message: `paddle: webhook signature ${verdict.reason}`,
      });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(input.body).toString('utf8'));
    } catch (cause) {
      throw new ProviderError({
        kind: 'malformed_response',
        provider: PADDLE,
        message: 'paddle: webhook body carried a valid signature but is not JSON',
        cause,
      });
    }
    return normalisePaddleEvent(payload);
  };

  return {
    name: PADDLE,
    capabilities,
    ensureCustomer,
    findCustomer,
    cancelSubscription,
    resolveItem,
    settle,
    findSettlement,
    refund,
    verifyWebhook,
  };
};
