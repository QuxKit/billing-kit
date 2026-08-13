// providers/stripe/events.ts
//
// Stripe's event catalogue, narrowed to the seven things the ledger acts on.
//
// Nothing here is exported past the adapter. A `VerifiedEvent` is only ever
// produced by `verifyWebhook`, so there is no function anywhere in billing-kit
// that turns an untrusted request body into something the ledger will act on.
// That is the structural answer to the reference application's balance credit
// from a request body: not a check that could be removed, but the absence of a
// callable path.
//
// Anything unmapped becomes `unknown`, is stored raw and is acknowledged 200.
// The alternatives — dropping it, or returning 500 — both end with the provider
// disabling the endpoint, and a disabled endpoint loses the payment events too.

import { moneyFromNumber, normaliseCurrency, optionalMoneyFromNumber } from '../amounts';
import { ProviderError } from '../errors';
import type { SubscriptionStatus, VerifiedEvent } from '../types';

export const STRIPE = 'stripe';

export const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProviderError({
      kind: 'malformed_response',
      provider: STRIPE,
      message: 'stripe: expected an object where the event envelope requires one',
      raw: value,
    });
  }
  return value as Record<string, unknown>;
};

export const str = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value === '') {
    throw new ProviderError({
      kind: 'malformed_response',
      provider: STRIPE,
      message: `stripe: '${field}' is missing or not a string`,
      raw: value,
    });
  }
  return value;
};

/** Stripe writes a reference either as an id string or, when expanded, as the
 *  whole object. Both are the same reference and the adapter must not care
 *  which the account's API version happened to send. */
const ref = (value: unknown): string | null => {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'object' && value !== null) {
    const id = (value as Record<string, unknown>)['id'];
    if (typeof id === 'string') return id;
  }
  return null;
};

/**
 * Tax on an invoice, across two API generations.
 *
 * Older accounts send a single `tax` integer; newer ones send `total_taxes`, a
 * list. Reading only one of them silently reports zero tax on the other, which
 * on a provider where tax is ours to remit is an understated liability rather
 * than a display bug.
 */
export const invoiceTax = (invoice: Record<string, unknown>, currency: string) => {
  if (typeof invoice['tax'] === 'number') {
    return optionalMoneyFromNumber(invoice['tax'], currency, STRIPE, 'invoice.tax');
  }
  const list = invoice['total_taxes'];
  if (!Array.isArray(list) || list.length === 0) return null;
  let total = 0;
  for (const entry of list) {
    const amount = (entry as Record<string, unknown>)?.['amount'];
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount)) {
      throw new ProviderError({
        kind: 'malformed_response',
        provider: STRIPE,
        message: 'stripe: total_taxes[].amount is not an exact minor-unit amount',
        raw: list,
      });
    }
    total += amount;
  }
  return moneyFromNumber(total, currency, STRIPE, 'invoice.total_taxes');
};

const subscriptionStatus = (value: unknown): SubscriptionStatus => {
  switch (value) {
    case 'trialing':
      return 'trialing';
    case 'active':
      return 'active';
    case 'past_due':
      return 'past_due';
    case 'paused':
      return 'paused';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    case 'incomplete':
    case 'unpaid':
      return 'incomplete';
    default:
      return 'unknown';
  }
};

/**
 * Map a verified Stripe event onto the normalised union.
 *
 * The caller has already checked the signature. Nothing in here re-checks it,
 * and nothing in here may be reached without it.
 */
export const normaliseStripeEvent = (payload: unknown): VerifiedEvent => {
  const event = object(payload);
  const providerEventId = str(event['id'], 'id');
  const kind = str(event['type'], 'type');
  const created = event['created'];
  if (typeof created !== 'number' || !Number.isSafeInteger(created)) {
    throw new ProviderError({
      kind: 'malformed_response',
      provider: STRIPE,
      message: "stripe: 'created' is missing or not a unix timestamp",
      raw: created,
    });
  }
  // Stripe's `created` is seconds. Ordering is taken from it and never from
  // arrival time, because webhooks are delivered out of order as a matter of
  // course and a void that overtakes its finalize must not resurrect anything.
  const base = { providerEventId, occurredAt: new Date(created * 1000), raw: payload };
  const data = object(object(event['data'])['object']);

  switch (kind) {
    case 'invoice.payment_succeeded':
    case 'invoice.paid': {
      const currency = normaliseCurrency(data['currency'], STRIPE, 'invoice.currency');
      return {
        ...base,
        kind: 'payment.succeeded',
        settlementRef: str(data['id'], 'invoice.id'),
        amount: moneyFromNumber(data['amount_paid'], currency, STRIPE, 'invoice.amount_paid'),
      };
    }

    case 'invoice.payment_failed':
      return {
        ...base,
        kind: 'payment.failed',
        settlementRef: str(data['id'], 'invoice.id'),
        reason:
          typeof data['last_finalization_error'] === 'object' && data['last_finalization_error'] !== null
            ? String((data['last_finalization_error'] as Record<string, unknown>)['message'] ?? 'payment_failed')
            : 'payment_failed',
      };

    case 'invoice.finalized': {
      const currency = normaliseCurrency(data['currency'], STRIPE, 'invoice.currency');
      return {
        ...base,
        kind: 'settlement.finalized',
        settlementRef: str(data['id'], 'invoice.id'),
        total: moneyFromNumber(data['total'], currency, STRIPE, 'invoice.total'),
        tax: invoiceTax(data, currency),
      };
    }

    case 'invoice.voided':
      return { ...base, kind: 'settlement.voided', settlementRef: str(data['id'], 'invoice.id') };

    case 'refund.created':
    case 'refund.updated':
    case 'charge.refund.updated': {
      const currency = normaliseCurrency(data['currency'], STRIPE, 'refund.currency');
      const status = data['status'];
      const refundRef = str(data['id'], 'refund.id');
      if (status === 'failed' || status === 'canceled') {
        return {
          ...base,
          kind: 'refund.declined',
          refundRef,
          reason: typeof data['failure_reason'] === 'string' ? data['failure_reason'] : String(status),
        };
      }
      if (status !== 'succeeded') {
        // A refund still in flight is not a ledger event. Reporting it as
        // settled would post cash out that has not left.
        return { ...base, kind: 'unknown', providerKind: `${kind}:${String(status)}` };
      }
      return {
        ...base,
        kind: 'refund.settled',
        refundRef,
        settlementRef: ref(data['invoice']),
        amount: moneyFromNumber(data['amount'], currency, STRIPE, 'refund.amount'),
      };
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed':
      return {
        ...base,
        kind: 'subscription.changed',
        subscriptionRef: str(data['id'], 'subscription.id'),
        status:
          kind === 'customer.subscription.deleted'
            ? 'canceled'
            : subscriptionStatus(data['status']),
      };

    default:
      return { ...base, kind: 'unknown', providerKind: kind };
  }
};
