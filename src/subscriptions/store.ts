// Persistence for subscription instances. Creation and cancellation live here;
// charging a period and advancing the clock live in settle.ts, because that one
// operation also writes the ledger and is where idempotency has to be reasoned
// about as a whole.

import { randomUUID } from 'node:crypto';
import { BillingError } from '../errors.ts';
import type { SqlExecutor, SubjectId, TenantId } from '../types.ts';
import { addInterval } from './plan.ts';
import type { CancelWhen, Plan, Subscription, SubscriptionState } from './types.ts';

export interface SubscriptionRow {
  id: string;
  tenant_id: string;
  subject_id: string;
  key: string;
  plan_id: string;
  pending_plan_id: string | null;
  currency: string;
  state: SubscriptionState;
  seats: number;
  current_period_start: Date;
  current_period_end: Date;
  trial_end: Date | null;
  started_at: Date;
  canceled_at: Date | null;
  cancel_at_period_end: boolean;
}

export function toSubscription(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    subjectId: row.subject_id,
    key: row.key,
    planId: row.plan_id,
    pendingPlanId: row.pending_plan_id ?? null,
    currency: row.currency.trim(),
    state: row.state,
    seats: Number(row.seats),
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    trialEnd: row.trial_end,
    startedAt: row.started_at,
    canceledAt: row.canceled_at,
    cancelAtPeriodEnd: row.cancel_at_period_end,
  };
}

/** Every column `toSubscription` reads. One list, imported by settle/sweep. */
export const SUBSCRIPTION_COLUMNS = `id, tenant_id, subject_id, key, plan_id, pending_plan_id, currency, state, seats,
       current_period_start, current_period_end, trial_end, started_at,
       canceled_at, cancel_at_period_end`;

const SELECT = `SELECT ${SUBSCRIPTION_COLUMNS} FROM billing.subscriptions`;

export interface CreateSubscriptionInput {
  tenantId: TenantId;
  subjectId: SubjectId;
  /** The caller's idempotency key. Creating twice under one key is a no-op. */
  key: string;
  plan: Plan;
  /** Assigned seats. Clamped up to the plan minimum when a period is charged. */
  seats?: number;
  /** When the subscription begins. Defaults to `now`. */
  startAt?: Date;
  metadata?: Record<string, unknown>;
}

const DAY_MS = 86_400_000;

/**
 * Create a subscription, or return the one this key already made.
 *
 * The first period and the trial end are computed from the plan here, so the
 * state a period is charged against is fixed at creation and does not drift if
 * the plan object is later edited in code. `ON CONFLICT (tenant_id, key)`
 * returns the existing row untouched — a retried signup must not reset a
 * subscription that has already been billing for a month.
 */
export async function createSubscription(
  db: SqlExecutor,
  input: CreateSubscriptionInput,
  now: Date,
): Promise<Subscription> {
  const { plan } = input;
  if (input.seats !== undefined && (!Number.isInteger(input.seats) || input.seats < 0)) {
    throw new BillingError({ code: 'invalid_subscription', reason: 'seats must be a non-negative integer' });
  }

  const startAt = input.startAt ?? now;
  const trialEnd = plan.trialDays && plan.trialDays > 0 ? new Date(startAt.getTime() + plan.trialDays * DAY_MS) : null;
  const periodEnd = addInterval(startAt, plan.interval);
  const state: SubscriptionState = trialEnd && trialEnd > startAt ? 'trialing' : 'active';

  const rows = await db.query<SubscriptionRow>(
    `INSERT INTO billing.subscriptions
       (id, tenant_id, subject_id, key, plan_id, currency, state, seats,
        current_period_start, current_period_end, trial_end, started_at, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
     ON CONFLICT (tenant_id, key)
     DO UPDATE SET key = billing.subscriptions.key
     RETURNING ${SUBSCRIPTION_COLUMNS}`,
    [
      randomUUID(),
      input.tenantId,
      input.subjectId,
      input.key,
      plan.id,
      plan.currency,
      state,
      input.seats ?? 0,
      startAt,
      periodEnd,
      trialEnd,
      startAt,
      input.metadata === undefined ? null : JSON.stringify(input.metadata),
    ],
  );

  const row = rows[0];
  if (row === undefined) {
    throw new BillingError({ code: 'invalid_subscription', reason: 'insert returned no row' });
  }
  return toSubscription(row);
}

export interface SubscriptionRef {
  tenantId: TenantId;
  id?: string;
  key?: string;
}

/** Read one subscription back by id or by the caller's key. */
export async function getSubscription(db: SqlExecutor, ref: SubscriptionRef): Promise<Subscription | null> {
  if (!ref.id && !ref.key) {
    throw new BillingError({ code: 'invalid_subscription', reason: 'getSubscription needs an id or a key' });
  }
  const rows = ref.id
    ? await db.query<SubscriptionRow>(`${SELECT} WHERE tenant_id = $1 AND id = $2`, [ref.tenantId, ref.id])
    : await db.query<SubscriptionRow>(`${SELECT} WHERE tenant_id = $1 AND key = $2`, [ref.tenantId, ref.key]);
  const row = rows[0];
  return row === undefined ? null : toSubscription(row);
}

/**
 * Cancel a subscription.
 *
 * `immediately` ends it now; `period_end` marks it to cancel when the current
 * period is next charged, so the customer keeps what they have paid for. The
 * latter is a flag, not a state change — the subscription is still active and
 * still bills this period; `chargeSubscriptionPeriod` reads the flag when it
 * advances and moves the row to `canceled` then.
 */
export async function cancelSubscription(
  db: SqlExecutor,
  ref: { tenantId: TenantId; id: string },
  when: CancelWhen,
  now: Date,
): Promise<Subscription> {
  const rows =
    when === 'immediately'
      ? await db.query<SubscriptionRow>(
          `UPDATE billing.subscriptions
              SET state = 'canceled', canceled_at = $3, cancel_at_period_end = false
            WHERE tenant_id = $1 AND id = $2
        RETURNING ${SUBSCRIPTION_COLUMNS}`,
          [ref.tenantId, ref.id, now],
        )
      : await db.query<SubscriptionRow>(
          `UPDATE billing.subscriptions
              SET cancel_at_period_end = true
            WHERE tenant_id = $1 AND id = $2 AND state <> 'canceled'
        RETURNING ${SUBSCRIPTION_COLUMNS}`,
          [ref.tenantId, ref.id],
        );

  const row = rows[0];
  if (row === undefined) {
    throw new BillingError({ code: 'not_found', what: 'subscription', id: ref.id });
  }
  return toSubscription(row);
}
