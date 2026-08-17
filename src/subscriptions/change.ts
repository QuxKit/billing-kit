// Moving a subscription between plans.
//
// billing-kit charges in arrears: the sweep charges a period when it ends. So a
// mid-period change never finds an already-charged period to credit; what it
// finds is a period half lived on the old plan. The correct bill for that
// period is the old plan's fees for the days it was active plus the new plan's
// fees for the days that remain — `activeDays / periodDays` of each — plus the
// usage, priced by whichever plan was current when it was charged.
//
// `immediate` therefore does two things in one transaction: it closes the
// current period at `at` on the old plan — one balanced accrual posting for
// the old plan's elapsed fees and the usage so far, one `subscription_periods`
// row that can be invoiced like any other — and it starts the remainder
// `[at, periodEnd)` on the new plan, which the sweep charges at period end,
// prorated to its days (see `prorationFor` in settle.ts). Head and tail are
// floored from the front, so they sum to exactly `periodDays`: no day billed
// twice, none dropped.
//
// `period_end` sets `pending_plan_id`; the advance at the next charge applies
// it. The customer keeps the plan they are in until the period they are in
// ends, which is what "downgrade at the end of the month" means.

import { randomUUID } from 'node:crypto';
import { BillingError } from '../errors.ts';
import type { Quantity } from '../money.ts';
import type { SqlExecutor, TenantId } from '../types.ts';
import type { DiscountRule } from './discount.ts';
import { type ChargePeriodResult, chargeSubscriptionPeriod, prorationFor } from './settle.ts';
import { SUBSCRIPTION_COLUMNS, type SubscriptionRow, toSubscription } from './store.ts';
import type { Plan, Subscription } from './types.ts';

export type ChangeBehaviour = 'immediate' | 'period_end';

export interface ChangePlanInput {
  tenantId: TenantId;
  subscriptionId: string;
  /** The plan the subscription is on. Must match its `planId`. */
  from: Plan;
  /** The plan to move to. Same currency and interval as `from`. */
  to: Plan;
  behaviour: ChangeBehaviour;
  /** When. `immediate`: must fall inside the current period. Defaults to now. */
  at?: Date;
  /** New seat count, applied with the change. Unchanged when omitted. */
  seats?: number;
  /**
   * For `immediate`: metered usage since the period began, by metric — charged
   * now at the old plan's rates as part of closing the period. Omit for none;
   * usage recorded after `at` is charged with the remainder at the new rates.
   */
  usage?: Readonly<Record<string, Quantity>>;
  discount?: DiscountRule;
  now?: Date;
}

export interface ChangePlanResult {
  subscription: Subscription;
  behaviour: ChangeBehaviour;
  effectiveAt: Date;
  /** `immediate` only: the closed head of the period on the old plan, or null
   *  when there was nothing to close (the change fell on the period start). */
  closed: ChargePeriodResult | null;
  /** The days the old and new plans are billed for, out of the period. */
  proration: { periodDays: number; oldDays: number; newDays: number };
  /** True when this change had already been recorded and nothing was written. */
  deduplicated: boolean;
}

interface ChangeRow {
  inserted: boolean;
  charge_id: string | null;
  effective_at: Date;
  behaviour: ChangeBehaviour;
}

/**
 * Change plan. Idempotent on (subscription, effectiveAt): the retry of a change
 * finds its `plan_changes` row and returns the subscription as it stands.
 */
export async function changePlan(db: SqlExecutor, input: ChangePlanInput): Promise<ChangePlanResult> {
  const { from, to } = input;
  const now = input.now ?? new Date();
  const at = input.at ?? now;

  if (from.id === to.id) {
    throw new BillingError({ code: 'invalid_subscription', reason: `already on plan ${to.id}` });
  }
  if (from.currency !== to.currency) {
    throw new BillingError({ code: 'currency_mismatch', left: from.currency, right: to.currency });
  }
  if (from.interval !== to.interval) {
    throw new BillingError({
      code: 'invalid_subscription',
      reason: `cannot change from a ${from.interval}ly plan to a ${to.interval}ly one mid-stream; cancel and resubscribe`,
    });
  }
  if (input.seats !== undefined && (!Number.isInteger(input.seats) || input.seats < 0)) {
    throw new BillingError({ code: 'invalid_subscription', reason: 'seats must be a non-negative integer' });
  }

  return db.transaction(async (tx) => {
    const rows = await tx.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM billing.subscriptions WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [input.tenantId, input.subscriptionId],
    );
    const row = rows[0];
    if (row === undefined)
      throw new BillingError({ code: 'not_found', what: 'subscription', id: input.subscriptionId });
    const sub = toSubscription(row);
    if (sub.state === 'canceled') {
      throw new BillingError({ code: 'invalid_subscription', reason: 'subscription is canceled' });
    }
    if (sub.planId !== from.id) {
      throw new BillingError({
        code: 'invalid_subscription',
        reason: `plan ${from.id} is not this subscription's plan ${sub.planId}`,
      });
    }

    const start = sub.currentPeriodStart;
    const end = sub.currentPeriodEnd;
    const effectiveAt = input.behaviour === 'immediate' ? at : end;

    // The retry check comes before the bounds check: a change already applied
    // has advanced the period, so its own `at` is no longer inside it — and a
    // retry of an applied change must be a no-op, not a refusal.
    const prior = await tx.query<ChangeRow>(
      `SELECT true AS inserted, charge_id, effective_at, behaviour
         FROM billing.plan_changes WHERE subscription_id = $1 AND effective_at = $2`,
      [sub.id, effectiveAt],
    );
    if (prior[0] !== undefined) {
      const p = prior[0];
      const periodDays = Math.round((end.getTime() - start.getTime()) / 86_400_000);
      return {
        subscription: sub,
        behaviour: p.behaviour,
        effectiveAt: p.effective_at,
        closed: null,
        proration: { periodDays, oldDays: periodDays, newDays: 0 },
        deduplicated: true,
      };
    }

    if (input.behaviour === 'immediate' && (at.getTime() < start.getTime() || at.getTime() >= end.getTime())) {
      throw new BillingError({
        code: 'invalid_subscription',
        reason: `at ${at.toISOString()} is outside the current period ${start.toISOString()}..${end.toISOString()}`,
      });
    }

    // The audit row is the idempotency claim.
    const [change] = await tx.query<ChangeRow>(
      `INSERT INTO billing.plan_changes
         (id, tenant_id, subscription_id, from_plan_id, to_plan_id, behaviour, requested_at, effective_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (subscription_id, effective_at)
       DO UPDATE SET effective_at = billing.plan_changes.effective_at
       RETURNING (xmax = 0) AS inserted, charge_id, effective_at, behaviour`,
      [randomUUID(), input.tenantId, sub.id, from.id, to.id, input.behaviour, now, effectiveAt],
    );

    const fullDays = () => {
      const tail = prorationFor(start, end, from.interval);
      return tail?.periodDays ?? Math.round((end.getTime() - start.getTime()) / 86_400_000);
    };

    if (change !== undefined && !change.inserted) {
      const proration = split(start, end, effectiveAt, fullDays());
      return {
        subscription: sub,
        behaviour: change.behaviour,
        effectiveAt: change.effective_at,
        closed: null,
        proration,
        deduplicated: true,
      };
    }

    if (input.behaviour === 'period_end') {
      const updated = await tx.query<SubscriptionRow>(
        `UPDATE billing.subscriptions SET pending_plan_id = $3, seats = COALESCE($4, seats)
          WHERE tenant_id = $1 AND id = $2 RETURNING ${SUBSCRIPTION_COLUMNS}`,
        [input.tenantId, sub.id, to.id, input.seats ?? null],
      );
      const periodDays = fullDays();
      return {
        subscription: toSubscription(updated[0]),
        behaviour: 'period_end',
        effectiveAt: end,
        closed: null,
        proration: { periodDays, oldDays: periodDays, newDays: 0 },
        deduplicated: false,
      };
    }

    // Immediate. Close the head on the old plan (unless the change falls on
    // the period start, when there is no head), then the tail runs on `to`.
    const periodDays = fullDays();
    const proration = split(start, end, at, periodDays);
    let closed: ChargePeriodResult | null = null;
    let subscription: Subscription;
    if (at.getTime() === start.getTime()) {
      const updated = await tx.query<SubscriptionRow>(
        `UPDATE billing.subscriptions SET plan_id = $3, seats = COALESCE($4, seats)
          WHERE tenant_id = $1 AND id = $2 RETURNING ${SUBSCRIPTION_COLUMNS}`,
        [input.tenantId, sub.id, to.id, input.seats ?? null],
      );
      subscription = toSubscription(updated[0]);
    } else {
      closed = await chargeSubscriptionPeriod(tx, {
        plan: from,
        subscription: sub,
        usage: input.usage,
        discount: input.discount,
        now,
        closeAt: at,
        nextPlanId: to.id,
      });
      subscription = closed.subscription;
      if (input.seats !== undefined) {
        const updated = await tx.query<SubscriptionRow>(
          `UPDATE billing.subscriptions SET seats = $3 WHERE tenant_id = $1 AND id = $2 RETURNING ${SUBSCRIPTION_COLUMNS}`,
          [input.tenantId, sub.id, input.seats],
        );
        subscription = toSubscription(updated[0]);
      }
      await tx.query(
        `UPDATE billing.plan_changes SET charge_id = $2 WHERE subscription_id = $1 AND effective_at = $3`,
        [sub.id, closed.transaction === null ? null : closed.chargeId, at],
      );
    }
    return { subscription, behaviour: 'immediate', effectiveAt: at, closed, proration, deduplicated: false };
  });
}

/** Whole days each plan is billed for, floored from the front; they sum to periodDays. */
function split(start: Date, end: Date, at: Date, periodDays: number) {
  const fullStart = new Date(end.getTime() - periodDays * 86_400_000);
  const head = Math.max(0, Math.floor((start.getTime() - fullStart.getTime()) / 86_400_000));
  const oldDays = Math.max(0, Math.floor((at.getTime() - fullStart.getTime()) / 86_400_000) - head);
  const newDays = Math.max(0, periodDays - head - oldDays);
  return { periodDays, oldDays, newDays };
}
