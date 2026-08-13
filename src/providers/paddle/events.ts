// providers/paddle/events.ts
//
// Paddle's event catalogue, narrowed to the same seven kinds Stripe's is
// narrowed to. Where the two disagree is where the interface earns its keep.
//
// Two differences are structural rather than cosmetic:
//
//   - Paddle sends amounts as decimal strings of minor units. That is the
//     better representation and it is why `moneyFromMinorString` exists
//     alongside `moneyFromNumber`: a string crosses `JSON.parse` untouched,
//     where a number crosses it as a double and has to be re-asserted.
//   - A refund is an *adjustment* with an approval status, not a refund object
//     that succeeded. `pending_approval` is neither settled nor declined, and
//     mapping it to either posts a ledger entry for money that has not moved.
//     It becomes `unknown`, which is what `unknown` is for.
//
// As in the Stripe adapter, nothing here is exported past the adapter. A
// `VerifiedEvent` cannot be produced without a verified signature.

import { moneyFromMinorString, normaliseCurrency, optionalMoneyFromMinorString } from '../amounts';
import { ProviderError } from '../errors';
import type { SubscriptionStatus, VerifiedEvent } from '../types';

export const PADDLE = 'paddle';

export const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProviderError({
      kind: 'malformed_response',
      provider: PADDLE,
      message: 'paddle: expected an object where the envelope requires one',
      raw: value,
    });
  }
  return value as Record<string, unknown>;
};

export const str = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value === '') {
    throw new ProviderError({
      kind: 'malformed_response',
      provider: PADDLE,
      message: `paddle: '${field}' is missing or not a string`,
      raw: value,
    });
  }
  return value;
};

/**
 * Paddle timestamps carry microseconds — `2024-05-01T12:00:00.123456Z`.
 *
 * The ECMAScript date-time grammar defines exactly three fractional digits, so
 * anything beyond falls to each engine's lenient fallback parser. Truncating
 * here means ordering does not depend on which runtime the worker happens to be
 * on, and ordering is what decides whether a void can overtake its finalize.
 */
export const parseTimestamp = (value: unknown, field: string): Date => {
  const raw = str(value, field);
  const trimmed = raw.replace(/(\.\d{3})\d+/, '$1');
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    throw new ProviderError({
      kind: 'malformed_response',
      provider: PADDLE,
      message: `paddle: '${field}' is not a parseable timestamp (${raw})`,
      raw: value,
    });
  }
  return date;
};

/**
 * The amount that actually moved.
 *
 * `grand_total` is what the customer was charged after credits and discounts;
 * `total` is the gross before them. Cash must post at the former, or the ledger
 * records money arriving that a credit note already cancelled.
 */
const chargedAmount = (totals: Record<string, unknown>, currency: string) => {
  const value = totals['grand_total'] ?? totals['total'];
  return moneyFromMinorString(value, currency, PADDLE, 'details.totals.grand_total');
};

const totalsOf = (transaction: Record<string, unknown>): Record<string, unknown> => {
  const details = transaction['details'];
  if (typeof details !== 'object' || details === null) return {};
  const totals = (details as Record<string, unknown>)['totals'];
  return typeof totals === 'object' && totals !== null ? (totals as Record<string, unknown>) : {};
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
      return 'canceled';
    default:
      return 'unknown';
  }
};

export const normalisePaddleEvent = (payload: unknown): VerifiedEvent => {
  const event = object(payload);
  const kind = str(event['event_type'], 'event_type');
  const base = {
    providerEventId: str(event['event_id'], 'event_id'),
    occurredAt: parseTimestamp(event['occurred_at'], 'occurred_at'),
    raw: payload,
  };
  const data = object(event['data']);

  switch (kind) {
    case 'transaction.completed': {
      const currency = normaliseCurrency(data['currency_code'], PADDLE, 'transaction.currency_code');
      return {
        ...base,
        kind: 'payment.succeeded',
        settlementRef: str(data['id'], 'transaction.id'),
        amount: chargedAmount(totalsOf(data), currency),
      };
    }

    case 'transaction.payment_failed':
      return {
        ...base,
        kind: 'payment.failed',
        settlementRef: str(data['id'], 'transaction.id'),
        reason: typeof data['status'] === 'string' ? data['status'] : 'payment_failed',
      };

    case 'transaction.billed': {
      const currency = normaliseCurrency(data['currency_code'], PADDLE, 'transaction.currency_code');
      const totals = totalsOf(data);
      return {
        ...base,
        kind: 'settlement.finalized',
        settlementRef: str(data['id'], 'transaction.id'),
        // This is the first moment we learn the real number. Under quantity
        // settlement against a merchant of record, everything we computed
        // before now was an estimate, and the ledger records both.
        total: moneyFromMinorString(totals['total'], currency, PADDLE, 'details.totals.total'),
        // Their tax, their liability. Recorded, never added to our revenue.
        tax: optionalMoneyFromMinorString(totals['tax'], currency, PADDLE, 'details.totals.tax'),
      };
    }

    case 'transaction.canceled':
      return { ...base, kind: 'settlement.voided', settlementRef: str(data['id'], 'transaction.id') };

    case 'adjustment.created':
    case 'adjustment.updated': {
      if (data['action'] !== 'refund') {
        // Credits and chargebacks are adjustments too, and they are not
        // refunds. Collapsing them would post the wrong ledger legs.
        return { ...base, kind: 'unknown', providerKind: `${kind}:${String(data['action'])}` };
      }
      const currency = normaliseCurrency(data['currency_code'], PADDLE, 'adjustment.currency_code');
      const refundRef = str(data['id'], 'adjustment.id');
      const status = data['status'];

      if (status === 'rejected') {
        return { ...base, kind: 'refund.declined', refundRef, reason: 'rejected' };
      }
      if (status !== 'approved') {
        // `pending_approval`: a human has not decided yet. Neither ledger entry
        // is true, so neither is written.
        return { ...base, kind: 'unknown', providerKind: `${kind}:${String(status)}` };
      }
      const totals = object(data['totals'] ?? {});
      return {
        ...base,
        kind: 'refund.settled',
        refundRef,
        settlementRef: typeof data['transaction_id'] === 'string' ? data['transaction_id'] : null,
        amount: moneyFromMinorString(totals['total'], currency, PADDLE, 'adjustment.totals.total'),
      };
    }

    case 'subscription.created':
    case 'subscription.updated':
    case 'subscription.activated':
    case 'subscription.canceled':
    case 'subscription.paused':
    case 'subscription.resumed':
    case 'subscription.past_due':
      return {
        ...base,
        kind: 'subscription.changed',
        subscriptionRef: str(data['id'], 'subscription.id'),
        status: subscriptionStatus(data['status']),
      };

    default:
      return { ...base, kind: 'unknown', providerKind: kind };
  }
};
