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
import { Quantity } from '../money.ts';
import type { PostedTransaction, SqlExecutor } from '../types.ts';
import { addInterval, chargeForPeriod } from './plan.ts';
import { toSubscription, type SubscriptionRow } from './store.ts';
import type { PeriodCharge, Plan, Subscription, SubscriptionState } from './types.ts';

export interface ChargePeriodInput {
  /** The plan the subscription references. Its currency and id must match. */
  plan: Plan;
  /** The subscription to charge, as last read. */
  subscription: Subscription;
  /** Metered usage for the period, by metric. Missing metrics count as zero. */
  usage?: Readonly<Record<string, Quantity>>;
  /** Charge timestamp; defaults to the injected clock / now. */
  now?: Date;
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
export async function chargeSubscriptionPeriod(
  db: SqlExecutor,
  input: ChargePeriodInput,
): Promise<ChargePeriodResult> {
  const { plan, subscription: sub } = input;
  const now = input.now ?? new Date();

  if (plan.id !== sub.planId) {
    throw new BillingError({ code: 'invalid_subscription', reason: `plan ${plan.id} is not this subscription's plan ${sub.planId}` });
  }
  if (plan.currency !== sub.currency) {
    throw new BillingError({ code: 'currency_mismatch', left: sub.currency, right: plan.currency });
  }
  if (sub.state === 'canceled') {
    throw new BillingError({ code: 'invalid_subscription', reason: 'subscription is canceled' });
  }

  const start = sub.currentPeriodStart;
  const end = sub.currentPeriodEnd;
  const trial = sub.trialEnd !== null && start < sub.trialEnd;

  const charge = chargeForPeriod(plan, { seats: sub.seats, usage: input.usage, trial });
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
  const nextStart = end;
  const nextEnd = addInterval(end, plan.interval);
  const nextState: SubscriptionState = sub.cancelAtPeriodEnd
    ? 'canceled'
    : sub.trialEnd !== null && sub.trialEnd <= nextStart
      ? 'active'
      : sub.state;

  const advanced = await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO billing.subscription_periods
         (id, subscription_id, tenant_id, subject_id, period_start, period_end,
          charge_id, amount_minor, currency, charged_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
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
      ],
    );

    const updated = await tx.query<SubscriptionRow>(
      `UPDATE billing.subscriptions
          SET current_period_start = $3,
              current_period_end   = $4,
              state                = $5,
              canceled_at          = CASE WHEN $5 = 'canceled' THEN $6 ELSE canceled_at END
        WHERE tenant_id = $1 AND id = $2 AND current_period_start = $7
    RETURNING id, tenant_id, subject_id, key, plan_id, currency, state, seats,
      current_period_start, current_period_end, trial_end, started_at,
      canceled_at, cancel_at_period_end`,
      [sub.tenantId, sub.id, nextStart, nextEnd, nextState, now, start],
    );

    if (updated.length > 0) return { row: updated[0], deduplicated: false };

    // Already advanced by an earlier run — return the row as it now stands.
    const current = await tx.query<SubscriptionRow>(
      `SELECT id, tenant_id, subject_id, key, plan_id, currency, state, seats,
              current_period_start, current_period_end, trial_end, started_at,
              canceled_at, cancel_at_period_end
         FROM billing.subscriptions WHERE tenant_id = $1 AND id = $2`,
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
