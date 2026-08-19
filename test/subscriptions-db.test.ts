// The persistence half of subscriptions: creation idempotency, charging a
// period through to a real ledger posting, the idempotency of that charge, and
// the trial and cancel-at-period-end paths — all against Postgres, because the
// properties that matter (one charge per period, an advance that happens once)
// live in unique constraints and a guarded UPDATE, not in the TypeScript.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { balance } from '../src/ledger';
import { Money, Quantity, Rate } from '../src/money';
import { definePlan } from '../src/subscriptions/plan.ts';
import { chargeSubscriptionPeriod } from '../src/subscriptions/settle.ts';
import { cancelSubscription, createSubscription } from '../src/subscriptions/store.ts';
import { chargeDueSubscriptions, dueSubscriptions } from '../src/subscriptions/sweep.ts';
import type { SqlExecutor } from '../src/types';
import { fromPool, SKIP_REASON, TEST_DATABASE_URL, unreachable } from './pg-executor';

const usd = (v: string) => Money.fromDecimalString(v, 'USD');
const q = (n: bigint) => Quantity.fromBigInt(n);
const NOW = new Date();

// Its own setup, because the shared harness rebuilds only 001_core.sql and the
// subscription tables live in 020_subscriptions.sql (+ 031's charge_lines column).
async function setup(): Promise<{ db: SqlExecutor; close(): Promise<void> } | null> {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    await pool.end().catch(() => {});
    unreachable(SKIP_REASON, error);
    return null;
  }
  const ddl = (f: string) => readFile(fileURLToPath(new URL(`../sql/${f}`, import.meta.url)), 'utf8');
  await pool.query('DROP SCHEMA IF EXISTS billing CASCADE');
  await pool.query(await ddl('001_core.sql'));
  await pool.query('SELECT billing.ensure_core_partitions(2, $1)', [NOW]);
  await pool.query(await ddl('020_subscriptions.sql'));
  // 031 adds subscription_periods.charge_lines, which chargeSubscriptionPeriod writes.
  await pool.query(await ddl('031_invoices.sql'));
  await pool.query(await ddl('032_plan_changes.sql'));
  await pool.query(await ddl('033_tax_lines.sql'));
  return { db: fromPool(pool), close: () => pool.end() };
}

const paid = definePlan({
  id: 'team',
  currency: 'USD',
  interval: 'month',
  flat: usd('49.00'),
  seats: { unit: usd('10.00'), min: 1 },
  usage: [
    {
      metric: 'tokens.input',
      included: q(1_000_000n),
      price: { kind: 'flat', rate: Rate.fromDecimalString('0.00012') },
    },
  ],
});

const trialPlan = definePlan({ ...paid, id: 'pro', trialDays: 14 });

const harness = await setup();

after(async () => {
  await harness?.close();
});

describe('subscriptions persistence', { skip: harness === null ? SKIP_REASON : false }, () => {
  const db = (harness as { db: SqlExecutor }).db;

  it('creates idempotently on the caller key', async () => {
    const a = await createSubscription(db, { tenantId: 'acme', subjectId: 'u1', key: 'k1', plan: paid, seats: 3 }, NOW);
    const b = await createSubscription(
      db,
      { tenantId: 'acme', subjectId: 'u1', key: 'k1', plan: paid, seats: 99 },
      NOW,
    );
    assert.equal(a.id, b.id);
    assert.equal(b.seats, 3, 'a retried create must not overwrite the seats');
  });

  it('charges a period, posts it to the ledger, and advances', async () => {
    const sub = await createSubscription(
      db,
      { tenantId: 'acme', subjectId: 'u2', key: 'k2', plan: paid, seats: 3 },
      NOW,
    );
    const r = await chargeSubscriptionPeriod(db, {
      plan: paid,
      subscription: sub,
      usage: { 'tokens.input': q(1_500_000n) },
      now: NOW,
    });

    // 4900 base + 3000 seats + 60 overage
    assert.equal(r.charge.total.minor, 7960n);
    assert.equal(r.deduplicated, false);
    assert.ok(r.transaction && !r.transaction.deduplicated);

    const bal = await balance(db, { tenantId: 'acme', subjectId: 'u2', account: 'customer_balance', currency: 'USD' });
    assert.equal(bal.minor, 7960n);

    assert.equal(r.subscription.currentPeriodStart.getTime(), sub.currentPeriodEnd.getTime(), 'advanced one period');
  });

  it('is idempotent: charging the same period again posts nothing new', async () => {
    const sub = await createSubscription(
      db,
      { tenantId: 'acme', subjectId: 'u3', key: 'k3', plan: paid, seats: 2 },
      NOW,
    );
    const usage = { 'tokens.input': q(1_000_000n) };

    const first = await chargeSubscriptionPeriod(db, { plan: paid, subscription: sub, usage, now: NOW });
    // re-charge with the ORIGINAL (pre-advance) subscription — a replayed webhook
    const again = await chargeSubscriptionPeriod(db, { plan: paid, subscription: sub, usage, now: NOW });

    assert.equal(first.deduplicated, false);
    assert.equal(again.deduplicated, true);
    assert.equal(first.chargeId, again.chargeId);

    const bal = await balance(db, { tenantId: 'acme', subjectId: 'u3', account: 'customer_balance', currency: 'USD' });
    assert.equal(bal.minor, first.charge.total.minor, 'the second charge must not double the balance');

    const periods = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM billing.subscription_periods WHERE subscription_id = $1',
      [sub.id],
    );
    assert.equal(periods[0].n, '1', 'exactly one period row');
  });

  it('waives base and seats during the trial, then activates', async () => {
    const sub = await createSubscription(
      db,
      { tenantId: 'acme', subjectId: 'u4', key: 'k4', plan: trialPlan, seats: 2 },
      NOW,
    );
    assert.equal(sub.state, 'trialing');

    const r = await chargeSubscriptionPeriod(db, { plan: trialPlan, subscription: sub, now: NOW });
    assert.equal(r.charge.total.minor, 0n, 'no usage and a trial → nothing to charge');
    assert.equal(r.transaction, null, 'a zero charge posts no ledger transaction');
    assert.equal(r.subscription.state, 'active', 'the trial ends before the next period begins');
  });

  it('cancels at period end when the next period is charged', async () => {
    const sub = await createSubscription(
      db,
      { tenantId: 'acme', subjectId: 'u5', key: 'k5', plan: paid, seats: 1 },
      NOW,
    );
    const marked = await cancelSubscription(db, { tenantId: 'acme', id: sub.id }, 'period_end', NOW);
    assert.equal(marked.cancelAtPeriodEnd, true);
    assert.equal(marked.state, 'active', 'still active until the period is charged');

    const r = await chargeSubscriptionPeriod(db, { plan: paid, subscription: marked, now: NOW });
    assert.equal(r.subscription.state, 'canceled');
    assert.ok(r.subscription.canceledAt !== null);
  });

  it('sweeps only what is due — the time-bound trigger seam', async () => {
    const startedAWeekAgo = new Date(NOW.getTime() - 7 * 86_400_000);
    // Due: its monthly period would end a month after a start well in the past…
    const back = new Date(NOW.getTime() - 40 * 86_400_000);
    const dueSub = await createSubscription(
      db,
      { tenantId: 'sweep', subjectId: 'd1', key: 'due', plan: paid, seats: 2, startAt: back },
      NOW,
    );
    // Not due: starts now, so its period ends a month out.
    await createSubscription(
      db,
      { tenantId: 'sweep', subjectId: 'd2', key: 'notdue', plan: paid, seats: 2, startAt: NOW },
      NOW,
    );
    void startedAWeekAgo;

    const due = await dueSubscriptions(db, { tenantId: 'sweep', now: NOW });
    assert.equal(due.length, 1);
    assert.equal(due[0].id, dueSub.id);

    const report = await chargeDueSubscriptions(db, {
      tenantId: 'sweep',
      now: NOW,
      plan: (id) => (id === paid.id ? paid : undefined),
    });
    assert.equal(report.swept, 1);
    assert.equal(report.charged, 1);
    assert.equal(report.items[0].subscriptionId, dueSub.id);

    // Idempotent: a second fire finds nothing due (the first advanced it a month).
    const second = await chargeDueSubscriptions(db, {
      tenantId: 'sweep',
      now: NOW,
      plan: (id) => (id === paid.id ? paid : undefined),
    });
    assert.equal(second.swept, 0);

    const bal = await balance(db, { tenantId: 'sweep', subjectId: 'd1', account: 'customer_balance', currency: 'USD' });
    assert.equal(bal.minor, 6900n, 'charged exactly once: 4900 base + 2000 seats');
  });

  it('skips a due subscription whose plan no longer resolves', async () => {
    const back = new Date(NOW.getTime() - 40 * 86_400_000);
    const orphan = await createSubscription(
      db,
      { tenantId: 'sweep2', subjectId: 'o1', key: 'orphan', plan: paid, seats: 1, startAt: back },
      NOW,
    );
    const report = await chargeDueSubscriptions(db, {
      tenantId: 'sweep2',
      now: NOW,
      plan: () => undefined, // catalogue lost this plan
    });
    assert.equal(report.swept, 1);
    assert.equal(report.charged, 0);
    assert.deepEqual(report.skipped, [orphan.id]);
  });

  it('retries a failing charge with backoff, then reports it with the attempt count', async () => {
    const back = new Date(NOW.getTime() - 40 * 86_400_000);
    const sub = await createSubscription(
      db,
      { tenantId: 'sweep3', subjectId: 'r1', key: 'retry', plan: paid, seats: 1, startAt: back },
      NOW,
    );
    const slept: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      slept.push(ms);
    };

    // Always fails: every attempt is used up, the item lands in errors, and
    // because each attempt ran in its own transaction nothing was posted.
    let calls = 0;
    const failing = await chargeDueSubscriptions(db, {
      tenantId: 'sweep3',
      now: NOW,
      plan: () => paid,
      usageFor: () => {
        calls += 1;
        throw new Error('meter unavailable');
      },
      retry: { retries: 2, backoffMs: 10, sleep },
    });
    assert.equal(calls, 3, 'first try plus two retries');
    assert.deepEqual(slept, [10, 20], 'exponential backoff between attempts');
    assert.equal(failing.charged, 0);
    assert.equal(failing.errors.length, 1);
    assert.equal(failing.errors[0].subscriptionId, sub.id);
    assert.equal(failing.errors[0].attempts, 3);
    assert.match(failing.errors[0].message, /meter unavailable/);
    const stillDue = await dueSubscriptions(db, { tenantId: 'sweep3', now: NOW });
    assert.deepEqual(
      stillDue.map((d) => d.id),
      [sub.id],
      'a failed item is left due for the next sweep, not advanced',
    );
    const bal = await balance(db, {
      tenantId: 'sweep3',
      subjectId: 'r1',
      account: 'customer_balance',
      currency: 'USD',
    });
    assert.equal(bal.minor, 0n, 'nothing posted for a charge that failed');

    // Fails twice, then succeeds: the retry heals it within one sweep.
    let flaky = 0;
    const healed = await chargeDueSubscriptions(db, {
      tenantId: 'sweep3',
      now: NOW,
      plan: () => paid,
      usageFor: () => {
        flaky += 1;
        if (flaky < 3) throw new Error('transient');
        return {};
      },
      retry: { retries: 2, backoffMs: 1, sleep },
    });
    assert.equal(healed.errors.length, 0);
    assert.equal(healed.charged, 1);
    assert.equal(healed.items[0].subscriptionId, sub.id);
  });

  it('holds a per-run lease: an overlapping sweep returns leased=false and does nothing', async () => {
    const back = new Date(NOW.getTime() - 40 * 86_400_000);
    await createSubscription(
      db,
      { tenantId: 'sweep4', subjectId: 'l1', key: 'lease', plan: paid, seats: 1, startAt: back },
      NOW,
    );
    // Another worker holding the lease, on its own connection.
    const other = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await other.connect();
    try {
      await other.query('BEGIN');
      const held = await other.query<{ got: boolean }>(
        'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS got',
        ['billing-kit:sweep:sweep4'],
      );
      assert.equal(held.rows[0]?.got, true);

      const blocked = await chargeDueSubscriptions(db, { tenantId: 'sweep4', now: NOW, plan: () => paid });
      assert.equal(blocked.leased, false);
      assert.equal(blocked.swept, 0);
      assert.equal(blocked.charged, 0);

      // A different lease key is a different lease.
      const otherKey = await chargeDueSubscriptions(db, {
        tenantId: 'sweep4',
        now: NOW,
        plan: () => paid,
        lease: { key: 'someone-else' },
      });
      assert.equal(otherKey.leased, true);
      assert.equal(otherKey.charged, 1);

      await other.query('ROLLBACK');
    } finally {
      await other.end();
    }

    // Lease released: nothing left due, but the sweep itself now runs.
    const after = await chargeDueSubscriptions(db, { tenantId: 'sweep4', now: NOW, plan: () => paid });
    assert.equal(after.leased, true);
    assert.equal(after.swept, 0);
  });

  it('skips a due row another worker holds FOR UPDATE, and reports it as locked', async () => {
    const back = new Date(NOW.getTime() - 40 * 86_400_000);
    const held = await createSubscription(
      db,
      { tenantId: 'sweep5', subjectId: 'h1', key: 'held', plan: paid, seats: 1, startAt: back },
      NOW,
    );
    const free = await createSubscription(
      db,
      { tenantId: 'sweep5', subjectId: 'h2', key: 'free', plan: paid, seats: 1, startAt: back },
      NOW,
    );
    const other = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await other.connect();
    try {
      await other.query('BEGIN');
      await other.query('SELECT id FROM billing.subscriptions WHERE id = $1 FOR UPDATE', [held.id]);

      const report = await chargeDueSubscriptions(db, { tenantId: 'sweep5', now: NOW, plan: () => paid, lease: false });
      assert.equal(report.swept, 2);
      assert.deepEqual(report.locked, [held.id]);
      assert.deepEqual(
        report.items.map((i) => i.subscriptionId),
        [free.id],
      );
      assert.equal(report.errors.length, 0, 'a held row is not an error');
      await other.query('ROLLBACK');
    } finally {
      await other.end();
    }
  });
});
