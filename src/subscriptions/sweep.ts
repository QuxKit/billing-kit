// Finding what is due, and charging it — the time-bound half of subscriptions.
//
// `chargeSubscriptionPeriod` charges one subscription you already hold. This is
// the other end: which subscriptions have reached the end of a period and need
// charging now. A cron fires, the host calls `chargeDueSubscriptions`, and the
// library does the rest.
//
// What is NOT here, on purpose and for the same reason metering's `drain` is a
// function and not an endpoint: no schedule, no HTTP. The trigger — every
// minute, every night — and the authentication of that trigger belong to the
// host. In this stack that host is `ezy_cron` calling an endpoint that calls
// this function.
//
// Correctness under overlap rests on idempotency, and on two locks that make the
// overlap cheap rather than merely survivable:
//
//   - a per-run lease: a transaction-scoped advisory lock held for the whole
//     sweep. A second sweep that fires while one is running returns at once
//     with `leased: false` and does no work. It is a xact lock on a pinned
//     connection, so unlike a session lock it cannot leak past the sweep.
//   - a per-item lock: each due subscription is charged inside its own
//     transaction, after `SELECT ... FOR UPDATE SKIP LOCKED` on its row. If the
//     lease is disabled (single-connection executors) or two sweeps run under
//     different lease keys, a row one of them holds is skipped by the other
//     rather than charged twice or read stale.
//
// Even with both, `chargeSubscriptionPeriod` remains idempotent on the charge
// id, the period row and the guarded advance, so a crash mid-item converges.
//
// Failures are retried with backoff before they land in `errors`: a transient
// database hiccup on one row should not need a whole extra cron tick to heal.

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

const COLUMNS = `id, tenant_id, subject_id, key, plan_id, currency, state, seats,
       current_period_start, current_period_end, trial_end, started_at,
       canceled_at, cancel_at_period_end`;

const SELECT = `SELECT ${COLUMNS} FROM billing.subscriptions`;

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

export interface SweepRetry {
  /** Extra attempts after the first failure. Default 2 (three tries in all). */
  retries?: number;
  /** Delay before the first retry; doubles each time. Default 100ms. */
  backoffMs?: number;
  /** Injectable for tests. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
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
  /**
   * The per-run lease. Default: on, keyed by tenant (or a global key when
   * sweeping all tenants). Pass `false` to disable — required when the executor
   * cannot hold a second connection open (a single-connection pool), since the
   * lease is a transaction that stays open while items are charged on others.
   */
  lease?: { key?: string } | false;
  /** Per-item retry policy. */
  retry?: SweepRetry;
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

export interface SweepError {
  subscriptionId: string;
  message: string;
  /** The typed code, when the final failure was a BillingError. */
  code?: string;
  /** How many times this item was tried before being reported. */
  attempts: number;
}

export interface SweepReport {
  /** False when another sweep held the lease; nothing was looked at. */
  leased: boolean;
  /** How many due subscriptions were looked at. */
  swept: number;
  /** How many produced a fresh charge (not a replay). */
  charged: number;
  items: SweepItem[];
  /** Subscriptions whose plan did not resolve; left untouched. */
  skipped: string[];
  /**
   * Due rows another worker held at the moment this sweep reached them
   * (`FOR UPDATE SKIP LOCKED`), or that were no longer due by then. Not
   * errors: they are being handled, or already were.
   */
  locked: string[];
  /** Per-subscription failures after retries; one bad row never halts the sweep. */
  errors: SweepError[];
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A stable int8 for pg_try_advisory_xact_lock, from the lease key. */
const LEASE_SQL = `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS got`;

/**
 * Charge every subscription whose period has ended.
 *
 * One period per subscription per call: a subscription many periods overdue is
 * advanced one period here and picked up again by the next sweep, so a cron that
 * was down for a week catches up over the next few fires rather than doing an
 * unbounded amount of work in one. Each charge is idempotent, so re-running a
 * sweep — or running two at once — is safe; with the lease on, the second one
 * simply reports `leased: false`.
 */
export async function chargeDueSubscriptions(db: SqlExecutor, opts: SweepOptions): Promise<SweepReport> {
  if (opts.lease === false) return sweep(db, opts);

  const key = opts.lease?.key ?? `billing-kit:sweep:${opts.tenantId ?? '*'}`;
  return db.transaction(async (lease) => {
    const [row] = await lease.query<{ got: boolean }>(LEASE_SQL, [key]);
    if (row === undefined || !row.got) {
      return { leased: false, swept: 0, charged: 0, items: [], skipped: [], locked: [], errors: [] };
    }
    // The items are charged on `db` — other pool connections — while this
    // transaction holds the lock. The lease connection does nothing else.
    return sweep(db, opts);
  });
}

async function sweep(db: SqlExecutor, opts: SweepOptions): Promise<SweepReport> {
  const now = opts.now ?? new Date();
  const due = await dueSubscriptions(db, { now, tenantId: opts.tenantId, limit: opts.limit });

  const report: SweepReport = {
    leased: true,
    swept: due.length,
    charged: 0,
    items: [],
    skipped: [],
    locked: [],
    errors: [],
  };

  const retries = Math.max(0, opts.retry?.retries ?? 2);
  const backoffMs = Math.max(0, opts.retry?.backoffMs ?? 100);
  const sleep = opts.retry?.sleep ?? defaultSleep;

  for (const candidate of due) {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        const outcome = await chargeOne(db, opts, candidate, now);
        if (outcome.kind === 'skipped') report.skipped.push(candidate.id);
        else if (outcome.kind === 'locked') report.locked.push(candidate.id);
        else {
          report.items.push(outcome.item);
          if (outcome.item.charged) report.charged += 1;
        }
        break;
      } catch (error) {
        if (attempt <= retries) {
          await sleep(backoffMs * 2 ** (attempt - 1));
          continue;
        }
        report.errors.push({
          subscriptionId: candidate.id,
          message: BillingError.is(error) ? error.message : String(error),
          code: BillingError.is(error) ? error.code : undefined,
          attempts: attempt,
        });
        break;
      }
    }
  }

  return report;
}

type Outcome = { kind: 'skipped' } | { kind: 'locked' } | { kind: 'charged'; item: SweepItem };

/**
 * One item, in one transaction: lock the row (skipping it if another worker
 * has it), re-check it is still due, and charge it on the pinned connection so
 * the ledger post, the period row and the advance commit or roll back together.
 */
async function chargeOne(db: SqlExecutor, opts: SweepOptions, candidate: Subscription, now: Date): Promise<Outcome> {
  return db.transaction(async (tx) => {
    const rows = await tx.query<SubscriptionRow>(
      `${SELECT} WHERE tenant_id = $1 AND id = $2 AND state <> 'canceled' AND current_period_end <= $3
       FOR UPDATE SKIP LOCKED`,
      [candidate.tenantId, candidate.id, now],
    );
    const row = rows[0];
    if (row === undefined) return { kind: 'locked' };
    const subscription = toSubscription(row);

    const plan = await opts.plan(subscription.planId);
    if (plan === undefined) return { kind: 'skipped' };

    const usage = opts.usageFor
      ? await opts.usageFor(subscription, {
          start: subscription.currentPeriodStart,
          end: subscription.currentPeriodEnd,
        })
      : undefined;

    const result = await chargeSubscriptionPeriod(tx, { plan, subscription, usage, now });
    return {
      kind: 'charged',
      item: {
        subscriptionId: subscription.id,
        chargeId: result.chargeId,
        total: result.charge.total,
        charged: !result.deduplicated,
        posted: result.transaction !== null,
      },
    };
  });
}
