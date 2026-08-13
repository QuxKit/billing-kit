// providers/stripe/index.ts
//
// The Stripe adapter.
//
// Stripe is the easy member of the set: it is not the merchant of record, it
// captures payment, its refunds are synchronous, and it accepts both priced
// lines and quantities against a price it holds. Almost nothing in the
// interface is bent to fit it, which is the point — an interface derived from
// Stripe alone would fit Stripe perfectly and fit nothing else.
//
// Three details here are not obvious and are the reason this file is longer
// than a wrapper:
//
//   - Settling is three calls (items, invoice, finalize) and is therefore not
//     atomic. Every call carries an idempotency key derived from the caller's
//     settlement key, so a crash between any two is replayed rather than
//     duplicated. That only holds inside Stripe's 24-hour key window, which is
//     why `findSettlement` exists and is mandatory.
//   - `search` is eventually consistent by about a minute. Recovery cannot rely
//     on it alone, so every `find*` falls back to a list-and-filter that reads
//     the authoritative index.
//   - A refund needs the payment behind the invoice, not the invoice. The
//     adapter resolves that itself rather than making the caller pass a charge
//     id, because a charge id arriving from outside is exactly the shape of the
//     IDOR this library exists not to reproduce.

import { asWholeQuantity, normaliseCurrency, optionalMoneyFromNumber } from '../amounts';
import { ProviderError } from '../errors';
import { createHttpClient, type FetchLike, type HttpClient } from '../http';
import { singleHeader, verifyTimestampedHmac } from '../signature';
import type {
  BillingProvider,
  CancelAt,
  CustomerRef,
  ProviderCapabilities,
  ProviderCustomer,
  ProviderCustomerId,
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
  SubscriptionInput,
  SubscriptionStatus,
  VerifiedEvent,
} from '../types';
import { invoiceTax, normaliseStripeEvent, object, str, STRIPE } from './events';

export const STRIPE_CAPABILITIES = {
  settlement: ['lines', 'quantity'],
  merchantOfRecord: false,
  capturesPayment: true,
  refundsAreAsynchronous: false,
  idempotency: { header: 'Idempotency-Key', retentionHours: 24 },
  createsSubscriptions: true,
  // Stripe indexes customer metadata in its search API and email in its list
  // API, so recovery can go either way. That is a luxury, not the baseline.
  customerLookup: ['key', 'email'],
} as const satisfies ProviderCapabilities;

export type StripeCapabilities = typeof STRIPE_CAPABILITIES;

export interface StripeConfig {
  /** Secret key. Never logged, never returned in an error. */
  apiKey: string;
  /** Endpoint signing secret, `whsec_…`. Distinct from the API key: an adapter
   *  that verifies webhooks with the API key silently accepts nothing. */
  webhookSecret: string;
  /** Overridden by tests to point at a fixture. */
  baseUrl?: string;
  /** Pinned, so a Stripe-side version roll does not change our field shapes
   *  without a deploy. */
  apiVersion?: string;
  /** Metadata key holding our subject id on a Stripe customer. */
  subjectKey?: string;
  /** Metadata key holding our settlement idempotency key on an invoice. */
  settlementKey?: string;
  /** Metadata key on a Price naming the metric it bills. */
  metricKey?: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Injected only for signature freshness in tests. Never a billing boundary:
   *  those come from the database clock. */
  now?: () => number;
  webhookToleranceSeconds?: number;
  timeoutMs?: number;
  maxAttempts?: number;
}

const DEFAULT_BASE_URL = 'https://api.stripe.com';
const DEFAULT_API_VERSION = '2024-06-20';

/** Stripe's search grammar quotes values in single quotes; a key containing one
 *  would otherwise close the string and change the query. Subject ids are ours
 *  and unlikely to contain quotes, which is exactly why this is easy to forget
 *  until the one that does. */
const quote = (value: string): string => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const settlementStatus = (status: unknown): SettlementStatus => {
  switch (status) {
    case 'draft':
      return 'draft';
    case 'open':
      return 'open';
    case 'paid':
      return 'settled';
    case 'void':
      return 'void';
    case 'uncollectible':
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
    case 'incomplete':
      return value;
    case 'unpaid':
      return 'incomplete';
    case 'incomplete_expired':
      return 'canceled';
    default:
      return 'unknown';
  }
};

const unixSeconds = (date: Date): number => Math.floor(date.getTime() / 1000);

export const createStripeProvider = (
  config: StripeConfig,
): BillingProvider<StripeCapabilities> => {
  const subjectKey = config.subjectKey ?? 'billing_kit_subject';
  const settlementKey = config.settlementKey ?? 'billing_kit_settlement';
  const metricKey = config.metricKey ?? 'billing_kit_metric';

  const http: HttpClient = createHttpClient({
    provider: STRIPE,
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      'stripe-version': config.apiVersion ?? DEFAULT_API_VERSION,
      accept: 'application/json',
    },
    fetch: config.fetch,
    sleep: config.sleep,
    random: config.random,
    timeoutMs: config.timeoutMs,
    maxAttempts: config.maxAttempts,
  });

  /** Stripe takes its idempotency key in a header, so it never appears in the
   *  form body and never becomes part of the object. */
  const withKey = (key: string) => ({ idempotencyKey: key, headers: { 'idempotency-key': key } });

  const toCustomer = (raw: unknown): ProviderCustomer => {
    const record = object(raw);
    const metadata = (record['metadata'] ?? {}) as Record<string, unknown>;
    return {
      id: str(record['id'], 'customer.id') as ProviderCustomerId,
      key: typeof metadata[subjectKey] === 'string' ? (metadata[subjectKey] as string) : null,
      email: typeof record['email'] === 'string' ? record['email'] : null,
      raw,
    };
  };

  const toSubscription = (raw: unknown): ProviderSubscription => {
    const record = object(raw);
    const start = record['current_period_start'];
    const end = record['current_period_end'];
    return {
      id: str(record['id'], 'subscription.id') as ProviderSubscriptionId,
      status: subscriptionStatus(record['status']),
      currentPeriod:
        typeof start === 'number' && typeof end === 'number'
          ? { start: new Date(start * 1000), end: new Date(end * 1000) }
          : null,
      raw,
    };
  };

  const toSettlement = (raw: unknown): SettlementResult => {
    const invoice = object(raw);
    const currency = normaliseCurrency(invoice['currency'], STRIPE, 'invoice.currency');
    return {
      ref: str(invoice['id'], 'invoice.id') as ProviderSettlementId,
      status: settlementStatus(invoice['status']),
      providerTotal: optionalMoneyFromNumber(invoice['total'], currency, STRIPE, 'invoice.total'),
      providerTax: invoiceTax(invoice, currency),
      raw,
    };
  };

  const listData = (payload: unknown): unknown[] => {
    const data = object(payload)['data'];
    return Array.isArray(data) ? data : [];
  };

  // --- identity ------------------------------------------------------------

  const ensureCustomer = async (ref: CustomerRef): Promise<ProviderCustomer> => {
    // Stripe permits duplicate emails, so there is no server-side dedupe to
    // lean on: the idempotency key is the whole mechanism, and it is derived
    // from our subject id rather than generated, so a retry after a timeout is
    // the same request rather than a second customer.
    const created = await http.request<unknown>({
      method: 'POST',
      path: '/v1/customers',
      form: {
        email: ref.email,
        name: ref.name,
        metadata: { [subjectKey]: ref.key },
        ...(ref.country ? { address: { country: ref.country } } : {}),
      },
      ...withKey(`customer:${ref.key}`),
    });
    return toCustomer(created);
  };

  const findCustomer = async (ref: CustomerRef): Promise<ProviderCustomer | null> => {
    // Search is the right query and the wrong index: Stripe's search is
    // eventually consistent by roughly a minute, which is precisely the window
    // in which a recovery runs. So it is tried first for the general case and
    // then backed by an exact-index lookup on email, which is immediate.
    const found = await http.request<unknown>({
      method: 'GET',
      path: '/v1/customers/search',
      query: { query: `metadata[${quote(subjectKey)}]:${quote(ref.key)}`, limit: 1 },
    });
    const [hit] = listData(found);
    if (hit) return toCustomer(hit);

    if (!ref.email) return null;
    const byEmail = await http.request<unknown>({
      method: 'GET',
      path: '/v1/customers',
      query: { email: ref.email, limit: 100 },
    });
    for (const candidate of listData(byEmail)) {
      const customer = toCustomer(candidate);
      if (customer.key === ref.key) return customer;
    }
    return null;
  };

  // --- subscriptions -------------------------------------------------------

  const ensureSubscription = async (input: SubscriptionInput): Promise<ProviderSubscription> => {
    const raw = await http.request<unknown>({
      method: 'POST',
      path: '/v1/subscriptions',
      form: {
        customer: input.customerId,
        items: input.items.map((item) => ({ price: item.priceId, quantity: item.quantity })),
        metadata: { billing_kit_plan: input.planKey },
      },
      ...withKey(input.idempotencyKey),
    });
    return toSubscription(raw);
  };

  const cancelSubscription = async (
    id: ProviderSubscriptionId,
    at: CancelAt,
  ): Promise<ProviderSubscription> => {
    if (at === 'immediately') {
      return toSubscription(
        await http.request<unknown>({ method: 'DELETE', path: `/v1/subscriptions/${id}` }),
      );
    }
    return toSubscription(
      await http.request<unknown>({
        method: 'POST',
        path: `/v1/subscriptions/${id}`,
        form: { cancel_at_period_end: true },
        ...withKey(`cancel:${id}:period_end`),
      }),
    );
  };

  const resolveItem = async (
    subscriptionId: ProviderSubscriptionId,
    metric: string,
  ): Promise<ProviderItem | null> => {
    const raw = await http.request<unknown>({
      method: 'GET',
      path: `/v1/subscriptions/${subscriptionId}`,
      query: { 'expand[]': 'items.data.price' },
    });
    const items = object(object(raw)['items'] ?? {})['data'];
    if (!Array.isArray(items)) return null;
    for (const entry of items) {
      const price = object(object(entry)['price'] ?? {});
      const metadata = (price['metadata'] ?? {}) as Record<string, unknown>;
      if (metadata[metricKey] !== metric) continue;
      return {
        id: str(price['id'], 'price.id') as ProviderItemId,
        metric,
        raw: price,
      };
    }
    return null;
  };

  // --- settlement ----------------------------------------------------------

  const settle = async (
    request: SettlementRequest<'lines' | 'quantity'>,
  ): Promise<SettlementResult> => {
    const currency = request.currency.toLowerCase();

    if (request.mode === 'lines') {
      // One invoice item per line, each with its own derived key. Indexing the
      // key by position is what makes the sequence replayable: a crash after
      // three of five leaves three keys already used, and the retry writes only
      // the missing two.
      for (const [index, line] of request.lines.entries()) {
        if (line.amount.currency !== request.currency) {
          throw new ProviderError({
            kind: 'invalid_request',
            provider: STRIPE,
            message:
              `stripe: line '${line.description}' is in ${line.amount.currency} but the ` +
              `settlement is in ${request.currency}. Mixing currencies on one invoice ` +
              `produces a total in neither.`,
          });
        }
        await http.request<unknown>({
          method: 'POST',
          path: '/v1/invoiceitems',
          form: {
            customer: request.customerId,
            currency,
            amount: line.amount.minor,
            description: line.description,
            period: { start: unixSeconds(request.period.start), end: unixSeconds(request.period.end) },
            // The quantity travels as metadata rather than as `quantity`,
            // because Stripe's `quantity` multiplies a unit price and `amount`
            // is already the computed total. Sending both would double it.
            metadata: { ...line.metadata, billing_kit_quantity: line.quantity },
          },
          ...withKey(`${request.idempotencyKey}:line:${index}`),
        });
      }
    } else {
      for (const [index, item] of request.quantities.entries()) {
        const whole = asWholeQuantity(item.quantity);
        if (whole === null) {
          // Stated rather than truncated. Stripe multiplies an integer quantity
          // by a stored unit price; 1.5 GB-hours would silently become 1, and a
          // billing error that rounds toward the customer is still a billing
          // error. The alternative is real and named.
          throw new ProviderError({
            kind: 'invalid_request',
            provider: STRIPE,
            message:
              `stripe: quantity '${item.quantity}' for item ${item.itemId} is not a whole ` +
              `number, and quantity settlement multiplies a stored unit price by an integer. ` +
              `Settle fractional usage in 'lines' mode, where we compute the amount.`,
          });
        }
        await http.request<unknown>({
          method: 'POST',
          path: '/v1/invoiceitems',
          form: {
            customer: request.customerId,
            price: item.itemId,
            quantity: whole,
            period: { start: unixSeconds(request.period.start), end: unixSeconds(request.period.end) },
          },
          ...withKey(`${request.idempotencyKey}:qty:${index}`),
        });
      }
    }

    const invoice = await http.request<unknown>({
      method: 'POST',
      path: '/v1/invoices',
      form: {
        customer: request.customerId,
        currency,
        collection_method: 'charge_automatically',
        // Sweep in exactly the items written above. Without it the invoice is
        // created empty and the items sit pending until some later invoice
        // picks them up, which bills last month's usage next month.
        pending_invoice_items_behavior: 'include',
        auto_advance: true,
        subscription: request.subscriptionId ?? undefined,
        metadata: { ...request.metadata, [settlementKey]: request.idempotencyKey },
      },
      ...withKey(`${request.idempotencyKey}:invoice`),
    });

    const finalized = await http.request<unknown>({
      method: 'POST',
      path: `/v1/invoices/${str(object(invoice)['id'], 'invoice.id')}/finalize`,
      form: {},
      ...withKey(`${request.idempotencyKey}:finalize`),
    });

    return toSettlement(finalized);
  };

  const findSettlement = async (lookup: SettlementLookup): Promise<SettlementResult | null> => {
    const found = await http.request<unknown>({
      method: 'GET',
      path: '/v1/invoices/search',
      query: { query: `metadata[${quote(settlementKey)}]:${quote(lookup.key)}`, limit: 1 },
    });
    const [hit] = listData(found);
    if (hit) return toSettlement(hit);

    // The search index lags. Recovery runs inside that lag, so it falls back to
    // the authoritative list, bounded by the customer and a window around the
    // period — which is why `SettlementLookup` carries more than the key.
    const listed = await http.request<unknown>({
      method: 'GET',
      path: '/v1/invoices',
      query: {
        customer: lookup.customerId,
        'created[gte]': unixSeconds(lookup.period.start),
        limit: 100,
      },
    });
    for (const candidate of listData(listed)) {
      const metadata = (object(candidate)['metadata'] ?? {}) as Record<string, unknown>;
      if (metadata[settlementKey] === lookup.key) return toSettlement(candidate);
    }
    return null;
  };

  // --- money out -----------------------------------------------------------

  const refund = async (input: RefundInput): Promise<RefundAcknowledgement> => {
    // An invoice is not a payment. Refunding one means finding the payment
    // behind it, and the adapter does that lookup so no caller ever holds a
    // charge id it could be tricked into supplying from a request body.
    const invoice = object(
      await http.request<unknown>({ method: 'GET', path: `/v1/invoices/${input.settlementRef}` }),
    );
    const paymentIntent =
      typeof invoice['payment_intent'] === 'string'
        ? invoice['payment_intent']
        : typeof invoice['payment_intent'] === 'object' && invoice['payment_intent'] !== null
          ? (invoice['payment_intent'] as Record<string, unknown>)['id']
          : undefined;

    if (typeof paymentIntent !== 'string') {
      throw new ProviderError({
        kind: 'invalid_request',
        provider: STRIPE,
        message:
          `stripe: invoice ${input.settlementRef} has no payment to refund. An unpaid ` +
          `invoice is voided, not refunded — refunding it would post cash out that never ` +
          `came in.`,
        raw: invoice,
      });
    }

    const raw = object(
      await http.request<unknown>({
        method: 'POST',
        path: '/v1/refunds',
        form: {
          payment_intent: paymentIntent,
          amount: input.amount?.minor,
          metadata: { billing_kit_refund: input.idempotencyKey },
        },
        ...withKey(input.idempotencyKey),
      }),
    );

    const status = raw['status'];
    return {
      ref: str(raw['id'], 'refund.id') as ProviderRefundId,
      // Even though Stripe answers synchronously, the ledger still posts on the
      // webhook. Keeping one path means the asynchronous provider is not the
      // only one exercising it, and a path only one provider uses is a path
      // that is broken.
      status: status === 'succeeded' ? 'settled' : status === 'failed' || status === 'canceled' ? 'declined' : 'pending',
      raw,
    };
  };

  // --- inbound -------------------------------------------------------------

  const verifyWebhook = async (input: RawRequest): Promise<VerifiedEvent> => {
    const header = singleHeader(input.headers, 'stripe-signature');
    if (header === null) {
      throw new ProviderError({
        kind: 'signature_invalid',
        provider: STRIPE,
        message: 'stripe: missing or repeated Stripe-Signature header',
      });
    }

    const verdict = verifyTimestampedHmac({
      body: input.body,
      header,
      secret: config.webhookSecret,
      pairSeparator: ',',
      payloadSeparator: '.',
      timestampKey: 't',
      signatureKey: 'v1',
      toleranceSeconds: config.webhookToleranceSeconds,
      now: config.now,
    });

    if (!verdict.ok) {
      throw new ProviderError({
        kind: verdict.reason === 'stale' ? 'signature_stale' : 'signature_invalid',
        provider: STRIPE,
        message: `stripe: webhook signature ${verdict.reason}`,
      });
    }

    // Parsed only after the signature holds, and from the same bytes that were
    // verified. Parsing first and verifying the reserialised form is the
    // failure this whole shape exists to prevent.
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(input.body).toString('utf8'));
    } catch (cause) {
      throw new ProviderError({
        kind: 'malformed_response',
        provider: STRIPE,
        message: 'stripe: webhook body carried a valid signature but is not JSON',
        cause,
      });
    }
    return normaliseStripeEvent(payload);
  };

  return {
    name: STRIPE,
    capabilities: STRIPE_CAPABILITIES,
    ensureCustomer,
    findCustomer,
    ensureSubscription,
    cancelSubscription,
    resolveItem,
    settle,
    findSettlement,
    refund,
    verifyWebhook,
  };
};
