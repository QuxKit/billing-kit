// Charge one period of a subscription and advance its clock.
//
// This is the one place the module writes both the ledger and its own tables,
// so idempotency is reasoned about here as a whole. Three things happen, and
// all three are safe to repeat:
//
//   1. the charge posts to the ledger, idempotent on its charge_id;
//   2. the period is recorded, idempotent on (subscription, period_start);
//   3. the subscription advances, guarded so it moves exactly once.
//
// A crash between any two of them, or a webhook that fires the whole thing
// twice, converges to the same state: one posting, one period row, one advance.

import { randomUUID } from 'node:crypto';
import { BillingError } from '../errors.ts';
import { accrualPosting, post } from '../ledger.ts';
import type { Quantity } from '../money.ts';
import type { PostedTransaction, SqlExecutor } from '../types.ts';
import type { DiscountRule } from './discount.ts';
import { addInterval, chargeForPeriod, daysInPeriod } from './plan.ts';
import { SUBSCRIPTION_COLUMNS, type SubscriptionRow, toSubscription } from './store.ts';
import type { ChargeLine, PeriodCharge, Plan, Subscription, SubscriptionState } from './types.ts';

export interface ChargePeriodInput {
  /** The plan the subscription references. Its currency and id must match. */
  plan: Plan;
  /** The subscription to charge, as last read. */
  subscription: Subscription;
  /** Metered usage for the period, by metric. Missing metrics count as zero. */
  usage?: Readonly<Record<string, Quantity>>;
  /** A discount for this period — `discountForPeriod(coupon, index)`. */
  discount?: DiscountRule;
  /** Charge timestamp; defaults to the injected clock / now. */
  now?: Date;
  /**
   * Close the period at this instant instead of at `currentPeriodEnd`: the
   * period charged is `[start, closeAt)`, fees prorated by its days, and the
   * subscription advances to `[closeAt, currentPeriodEnd)` rather than to the
   * next period. What `changePlan` uses to bill the old plan for the days it
   * was active. Must fall inside the current period.
   */
  closeAt?: Date;
  /** With `closeAt`: the plan the remainder of the period continues on. */
  nextPlanId?: string;
}

const DAY_MS = 86_400_000;

/**
 * The fee proration for a period `[start, end)` of a plan on `interval`.
 *
 * A full period — `start` is one interval before `end` — has none. A shorter
 * one is the tail of a period that was closed early (a plan change), and its
 * fees are `activeDays / periodDays` of the full period. Whole days, floored
 * from the front: the head `[fullStart, start)` and the tail `[start, end)`
 * then sum to exactly `periodDays`, so the two halves of a split period never
 * bill a day twice or drop one.
 */
export function prorationFor(
  start: Date,
  end: Date,
  interval: Plan['interval'],
): { activeDays: number; periodDays: number } | undefined {
  const fullStart = addInterval(end, interval, -1);
  if (start.getTime() <= fullStart.getTime()) return undefined;
  const periodDays = daysInPeriod(fullStart, end);
  const elapsed = Math.floor((start.getTime() - fullStart.getTime()) / DAY_MS);
  const activeDays = Math.max(0, periodDays - elapsed);
  return activeDays >= periodDays ? undefined : { activeDays, periodDays };
}

/**
 * The persisted form of a charge's lines — `subscription_periods.charge_lines`
 * (sql/031). Money as its wire form, quantities as decimal strings, so the
 * invoice built later says exactly what was billed. Exported for the invoices
 * module and for tests.
 */
export function chargeLinesJSON(lines: readonly ChargeLine[]): string {
  return JSON.stringify(
    lines.map((l) => ({
      kind: l.kind,
      description: l.description,
      amount: l.amount.toJSON(),
      ...(l.metric === undefined ? {} : { metric: l.metric }),
      ...(l.quantity === undefined ? {} : { quantity: l.quantity.toDecimalString() }),
      ...(l.residueMinor === undefined ? {} : { residueMinor: l.residueMinor }),
      ...(l.productId === undefined ? {} : { productId: l.productId }),
    })),
  );
}

export interface ChargePeriodResult {
  charge: PeriodCharge;
  /** The ledger transaction's source_id. Ties the period to its posting. */
  chargeId: string;
  /** The posting, or null when the period cost nothing (a covered trial, say). */
  transaction: PostedTransaction | null;
  period: { start: Date; end: Date };
  /** The subscription after advancing. */
  subscription: Subscription;
  /** True when this period had already been charged and advanced. */
  deduplicated: boolean;
}

/**
 * Charge the subscription's current period, post it, and advance to the next.
 *
 * The trial rule: if the period begins before the trial ends, the base and seat
 * fees are waived for it and only usage is priced — a customer on a 14-day trial
 * of a monthly plan pays for the tokens they burned, not the seat. When the
 * subscription is marked to cancel at period end, this advance is where it
 * finally moves to `canceled`.
 */
export async function chargeSubscriptionPeriod(db: SqlExecutor, input: ChargePeriodInput): Promise<ChargePeriodResult> {
  const { plan, subscription: sub } = input;
  const now = input.now ?? new Date();

  if (plan.id !== sub.planId) {
    throw new BillingError({
      code: 'invalid_subscription',
      reason: `plan ${plan.id} is not this subscription's plan ${sub.planId}`,
    });
  }
  if (plan.currency !== sub.currency) {
    throw new BillingError({ code: 'currency_mismatch', left: sub.currency, right: plan.currency });
  }
  if (sub.state === 'canceled') {
    throw new BillingError({ code: 'invalid_subscription', reason: 'subscription is canceled' });
  }

  const start = sub.currentPeriodStart;
  const fullEnd = sub.currentPeriodEnd;
  const closeAt = input.closeAt;
  if (closeAt !== undefined && (closeAt.getTime() < start.getTime() || closeAt.getTime() > fullEnd.getTime())) {
    throw new BillingError({ code: 'invalid_subscription', reason: 'closeAt must fall inside the current period' });
  }
  const end = closeAt ?? fullEnd;
  const trial = sub.trialEnd !== null && start < sub.trialEnd;

  // Fees prorate when the period is not a whole interval: the tail of a period
  // closed early by a plan change, or the head being closed now. Whole days,
  // floored from the front, so head + tail = the full period exactly.
  const proration =
    closeAt === undefined
      ? prorationFor(start, end, plan.interval)
      : (() => {
          const fullStart = addInterval(fullEnd, plan.interval, -1);
          const periodDays = daysInPeriod(fullStart, fullEnd);
          const head = Math.floor((start.getTime() - fullStart.getTime()) / DAY_MS);
          const activeDays = Math.max(0, Math.floor((end.getTime() - fullStart.getTime()) / DAY_MS) - head);
          return activeDays >= periodDays ? undefined : { activeDays, periodDays };
        })();

  const charge = chargeForPeriod(plan, {
    seats: sub.seats,
    usage: input.usage,
    trial,
    discount: input.discount,
    proration,
  });
  const chargeId = `sub:${sub.id}:${start.toISOString()}`;

  // 1. Post to the ledger — but only if there is something to post. A zero
  //    charge (a fully covered trial period) has no legs worth writing.
  let transaction: PostedTransaction | null = null;
  if (!charge.total.isZero()) {
    transaction = await post(
      db,
      accrualPosting({
        tenantId: sub.tenantId,
        subjectId: sub.subjectId,
        chargeId,
        amount: charge.total,
        memo: `${plan.id} ${start.toISOString()}..${end.toISOString()}`,
      }),
      now,
    );
  }

  // 2. + 3. Record the period and advance, in one transaction. The advance is
  //    guarded on the period it is moving off, so a replay after the advance has
  //    already happened updates nothing and we read the current row instead.
  // Closing early: the remainder of this period, on the next plan. Otherwise
  // the next whole period, applying a pending plan change if one waited.
  const nextStart = end;
  const nextEnd = closeAt === undefined ? addInterval(end, plan.interval) : fullEnd;
  const nextPlanId = closeAt === undefined ? (sub.pendingPlanId ?? sub.planId) : (input.nextPlanId ?? sub.planId);
  const nextState: SubscriptionState =
    closeAt === undefined && sub.cancelAtPeriodEnd
      ? 'canceled'
      : sub.trialEnd !== null && sub.trialEnd <= nextStart
        ? 'active'
        : sub.state;

  const advanced = await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO billing.subscription_periods
         (id, subscription_id, tenant_id, subject_id, period_start, period_end,
          charge_id, amount_minor, currency, charged_at, charge_lines)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
       ON CONFLICT (subscription_id, period_start) DO NOTHING`,
      [
        randomUUID(),
        sub.id,
        sub.tenantId,
        sub.subjectId,
        start,
        end,
        chargeId,
        charge.total.minor.toString(),
        charge.currency,
        now,
        chargeLinesJSON(charge.lines),
      ],
    );

    const updated = await tx.query<SubscriptionRow>(
      `UPDATE billing.subscriptions
          SET current_period_start = $3,
              current_period_end   = $4,
              state                = $5,
              canceled_at          = CASE WHEN $5 = 'canceled' THEN $6 ELSE canceled_at END,
              plan_id              = $8,
              pending_plan_id      = CASE WHEN $9 THEN NULL ELSE pending_plan_id END
        WHERE tenant_id = $1 AND id = $2 AND current_period_start = $7
    RETURNING ${SUBSCRIPTION_COLUMNS}`,
      [sub.tenantId, sub.id, nextStart, nextEnd, nextState, now, start, nextPlanId, closeAt === undefined],
    );

    if (updated.length > 0) return { row: updated[0], deduplicated: false };

    // Already advanced by an earlier run — return the row as it now stands.
    const current = await tx.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM billing.subscriptions WHERE tenant_id = $1 AND id = $2`,
      [sub.tenantId, sub.id],
    );
    return { row: current[0], deduplicated: true };
  });

  if (advanced.row === undefined) {
    throw new BillingError({ code: 'not_found', what: 'subscription', id: sub.id });
  }

  return {
    charge,
    chargeId,
    transaction,
    period: { start, end },
    subscription: toSubscription(advanced.row),
    deduplicated: advanced.deduplicated,
  };
}
