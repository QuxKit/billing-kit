// Finding what is due, and charging it — the time-bound half of subscriptions.
//
// `chargeSubscriptionPeriod` charges one subscription you already hold. This is
// the other end: which subscriptions have reached the end of a period and need
// charging now. A cron fires, the host calls `chargeDueSubscriptions`, and the
// library does the rest.
//
// What is NOT here, on purpose and for the same reason metering's `drain` is a
// function and not an endpoint: no schedule, no HTTP, no lease held across the
// work. The trigger — every minute, every night — and the authentication of
// that trigger belong to the host. In this stack that host is `ezy_cron` calling
// an endpoint that calls this function.
//
// Concurrency safety comes from idempotency, not a lock. `chargeSubscriptionPeriod`
// dedupes on the ledger charge_id, the period row and a guarded advance, so two
// workers (or an overlapping cron) that both pick up the same due subscription
// charge it exactly once. A row lock spanning the charge could not be held
// anyway — the ledger post runs on a different pool connection — so, exactly as
// sql/013_runs.sql argues for the drain lease, a guard that cannot actually
// exclude anything is not shipped as though it does.

import { BillingError } from '../errors.ts';
import type { Money, Quantity } from '../money.ts';
import type { SqlExecutor, TenantId } from '../types.ts';
import { chargeSubscriptionPeriod } from './settle.ts';
import { type SubscriptionRow, toSubscription } from './store.ts';
import type { Plan, Subscription } from './types.ts';

export interface DueQuery {
  /** Charge everything whose period ended at or before this. Defaults to now. */
  now?: Date;
  /** Restrict to one tenant. Omit to sweep all. */
  tenantId?: TenantId;
  /** Cap the batch. Defaults to 200; a larger backlog drains over later sweeps. */
  limit?: number;
}

const SELECT = `SELECT id, tenant_id, subject_id, key, plan_id, currency, state, seats,
       current_period_start, current_period_end, trial_end, started_at,
       canceled_at, cancel_at_period_end
  FROM billing.subscriptions`;

/**
 * The subscriptions whose current period has ended and are not canceled,
 * oldest period-end first so the longest overdue is charged before a laggard
 * pushes it past the batch limit.
 */
export async function dueSubscriptions(db: SqlExecutor, q: DueQuery = {}): Promise<Subscription[]> {
  const now = q.now ?? new Date();
  const limit = q.limit ?? 200;
  const rows = q.tenantId
    ? await db.query<SubscriptionRow>(
        `${SELECT} WHERE state <> 'canceled' AND current_period_end <= $1 AND tenant_id = $2
         ORDER BY current_period_end LIMIT $3`,
        [now, q.tenantId, limit],
      )
    : await db.query<SubscriptionRow>(
        `${SELECT} WHERE state <> 'canceled' AND current_period_end <= $1
         ORDER BY current_period_end LIMIT $2`,
        [now, limit],
      );
  return rows.map(toSubscription);
}

export interface SweepOptions extends DueQuery {
  /**
   * Resolve the plan a subscription references. Async so it can read a catalogue
   * from anywhere. Return undefined to skip a subscription whose plan is gone —
   * skipped, reported, and left for a human, never charged against a guess.
   */
  plan: (planId: string) => Plan | undefined | Promise<Plan | undefined>;
  /**
   * The metered usage for a due period, by metric. Defaults to none, which is
   * correct for flat and per-seat plans. A usage plan wires this to its meter —
   * `queryUsage` over `[period.start, period.end)` — keeping this module free of
   * a hard dependency on metering.
   */
  usageFor?: (
    subscription: Subscription,
    period: { start: Date; end: Date },
  ) => Readonly<Record<string, Quantity>> | Promise<Readonly<Record<string, Quantity>>>;
}

export interface SweepItem {
  subscriptionId: string;
  chargeId: string;
  total: Money;
  /** False when the period was already charged by an earlier sweep. */
  charged: boolean;
  /** True when a ledger transaction was posted (a non-zero charge). */
  posted: boolean;
}

export interface SweepReport {
  /** How many due subscriptions were looked at. */
  swept: number;
  /** How many produced a fresh charge (not a replay). */
  charged: number;
  items: SweepItem[];
  /** Subscriptions whose plan did not resolve; left untouched. */
  skipped: string[];
  /** Per-subscription failures; one bad row never halts the sweep. */
  errors: { subscriptionId: string; message: string }[];
}

/**
 * Charge every subscription whose period has ended.
 *
 * One period per subscription per call: a subscription many periods overdue is
 * advanced one period here and picked up again by the next sweep, so a cron that
 * was down for a week catches up over the next few fires rather than doing an
 * unbounded amount of work in one. Each charge is idempotent, so re-running a
 * sweep — or running two at once — is safe.
 */
export async function chargeDueSubscriptions(db: SqlExecutor, opts: SweepOptions): Promise<SweepReport> {
  const now = opts.now ?? new Date();
  const due = await dueSubscriptions(db, { now, tenantId: opts.tenantId, limit: opts.limit });

  const report: SweepReport = { swept: due.length, charged: 0, items: [], skipped: [], errors: [] };

  for (const subscription of due) {
    try {
      const plan = await opts.plan(subscription.planId);
      if (plan === undefined) {
        report.skipped.push(subscription.id);
        continue;
      }

      const usage = opts.usageFor
        ? await opts.usageFor(subscription, {
            start: subscription.currentPeriodStart,
            end: subscription.currentPeriodEnd,
          })
        : undefined;

      const result = await chargeSubscriptionPeriod(db, { plan, subscription, usage, now });
      report.items.push({
        subscriptionId: subscription.id,
        chargeId: result.chargeId,
        total: result.charge.total,
        charged: !result.deduplicated,
        posted: result.transaction !== null,
      });
      if (!result.deduplicated) report.charged += 1;
    } catch (error) {
      report.errors.push({
        subscriptionId: subscription.id,
        message: BillingError.is(error) ? error.message : String(error),
      });
    }
  }

  return report;
}
