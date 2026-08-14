// The persistence half of subscriptions: creation idempotency, charging a
// period through to a real ledger posting, the idempotency of that charge, and
// the trial and cancel-at-period-end paths — all against Postgres, because the
// properties that matter (one charge per period, an advance that happens once)
// live in unique constraints and a guarded UPDATE, not in the TypeScript.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import pg from 'pg';

import { balance } from '../src/ledger';
import { Money, Quantity, Rate } from '../src/money';
import type { SqlExecutor } from '../src/types';
import { definePlan } from '../src/subscriptions/plan.ts';
import { cancelSubscription, createSubscription, getSubscription } from '../src/subscriptions/store.ts';
import { chargeSubscriptionPeriod } from '../src/subscriptions/settle.ts';
import { fromPool, SKIP_REASON, TEST_DATABASE_URL } from './pg-executor';

const usd = (v: string) => Money.fromDecimalString(v, 'USD');
const q = (n: bigint) => Quantity.fromBigInt(n);
const NOW = new Date();

// Its own setup, because the shared harness rebuilds only 001_core.sql and the
// subscription tables live in 020_subscriptions.sql.
async function setup(): Promise<{ db: SqlExecutor; close(): Promise<void> } | null> {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
  try {
    await pool.query('SELECT 1');
  } catch {
    await pool.end().catch(() => {});
    return null;
  }
  const ddl = (f: string) => readFile(fileURLToPath(new URL(`../sql/${f}`, import.meta.url)), 'utf8');
  await pool.query('DROP SCHEMA IF EXISTS billing CASCADE');
  await pool.query(await ddl('001_core.sql'));
  await pool.query('SELECT billing.ensure_core_partitions(2, $1)', [NOW]);
  await pool.query(await ddl('020_subscriptions.sql'));
  return { db: fromPool(pool), close: () => pool.end() };
}

const paid = definePlan({
  id: 'team',
  currency: 'USD',
  interval: 'month',
  flat: usd('49.00'),
  seats: { unit: usd('10.00'), min: 1 },
  usage: [
    { metric: 'tokens.input', included: q(1_000_000n), price: { kind: 'flat', rate: Rate.fromDecimalString('0.00012') } },
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
    const b = await createSubscription(db, { tenantId: 'acme', subjectId: 'u1', key: 'k1', plan: paid, seats: 99 }, NOW);
    assert.equal(a.id, b.id);
    assert.equal(b.seats, 3, 'a retried create must not overwrite the seats');
  });

  it('charges a period, posts it to the ledger, and advances', async () => {
    const sub = await createSubscription(db, { tenantId: 'acme', subjectId: 'u2', key: 'k2', plan: paid, seats: 3 }, NOW);
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
    const sub = await createSubscription(db, { tenantId: 'acme', subjectId: 'u3', key: 'k3', plan: paid, seats: 2 }, NOW);
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
    assert.equal(periods[0]!.n, '1', 'exactly one period row');
  });

  it('waives base and seats during the trial, then activates', async () => {
    const sub = await createSubscription(db, { tenantId: 'acme', subjectId: 'u4', key: 'k4', plan: trialPlan, seats: 2 }, NOW);
    assert.equal(sub.state, 'trialing');

    const r = await chargeSubscriptionPeriod(db, { plan: trialPlan, subscription: sub, now: NOW });
    assert.equal(r.charge.total.minor, 0n, 'no usage and a trial → nothing to charge');
    assert.equal(r.transaction, null, 'a zero charge posts no ledger transaction');
    assert.equal(r.subscription.state, 'active', 'the trial ends before the next period begins');
  });

  it('cancels at period end when the next period is charged', async () => {
    const sub = await createSubscription(db, { tenantId: 'acme', subjectId: 'u5', key: 'k5', plan: paid, seats: 1 }, NOW);
    const marked = await cancelSubscription(db, { tenantId: 'acme', id: sub.id }, 'period_end', NOW);
    assert.equal(marked.cancelAtPeriodEnd, true);
    assert.equal(marked.state, 'active', 'still active until the period is charged');

    const r = await chargeSubscriptionPeriod(db, { plan: paid, subscription: marked, now: NOW });
    assert.equal(r.subscription.state, 'canceled');
    assert.ok(r.subscription.canceledAt !== null);
  });
});
