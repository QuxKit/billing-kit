// changePlan against Postgres. What is under test is the arithmetic of a split
// period — the old plan's days plus the new plan's days equal the period, and
// each side is billed for exactly its share — and the mechanics around it: one
// balanced posting for the closed head, a period row that can be invoiced, a
// pending change applied by the next advance, and idempotency of the change.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { BillingError } from '../src/errors';
import { invoiceForPeriod } from '../src/invoices/index.ts';
import { balance, entries } from '../src/ledger';
import { Money, Quantity, Rate } from '../src/money';
import { changePlan } from '../src/subscriptions/change.ts';
import { chargeForPeriod, definePlan } from '../src/subscriptions/plan.ts';
import { chargeSubscriptionPeriod, prorationFor } from '../src/subscriptions/settle.ts';
import { cancelSubscription, createSubscription, getSubscription } from '../src/subscriptions/store.ts';
import { chargeDueSubscriptions } from '../src/subscriptions/sweep.ts';
import type { SqlExecutor } from '../src/types';
import { fromPool, SKIP_REASON, TEST_DATABASE_URL, unreachable } from './pg-executor';

const usd = (v: string) => Money.fromDecimalString(v, 'USD');
const q = (n: bigint) => Quantity.fromBigInt(n);
const NOW = new Date('2026-08-17T12:00:00Z');
const AUG1 = new Date('2026-08-01T00:00:00Z');
const SEP1 = new Date('2026-09-01T00:00:00Z');

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
  await pool.query(await ddl('031_invoices.sql'));
  await pool.query(await ddl('032_plan_changes.sql'));
  await pool.query(await ddl('032_plan_changes.sql')); // idempotent
  return { db: fromPool(pool), close: () => pool.end() };
}

const basic = definePlan({
  id: 'basic',
  currency: 'USD',
  interval: 'month',
  flat: usd('31.00'),
  seats: { unit: usd('3.10') },
  usage: [{ metric: 'requests', price: { kind: 'flat', rate: Rate.fromDecimalString('1') } }],
});
const pro = definePlan({ ...basic, id: 'pro', flat: usd('62.00'), seats: { unit: usd('6.20') } });
const yearly = definePlan({ ...basic, id: 'yearly', interval: 'year' });
const eur = definePlan({
  ...basic,
  id: 'eur',
  currency: 'EUR',
  flat: Money.fromDecimalString('31.00', 'EUR'),
  seats: undefined,
});
const catalogue = { basic, pro };
const plan = (id: string) => catalogue[id as keyof typeof catalogue];

const harness = await setup();
after(async () => {
  await harness?.close();
});

const owed = (db: SqlExecutor, subjectId: string) =>
  balance(db, { tenantId: 'acme', subjectId, account: 'customer_balance', currency: 'USD' });

describe('prorationFor', () => {
  it('is undefined for a whole period and activeDays/periodDays for a tail', () => {
    assert.equal(prorationFor(AUG1, SEP1, 'month'), undefined);
    assert.deepEqual(prorationFor(new Date('2026-08-16T00:00:00Z'), SEP1, 'month'), { activeDays: 16, periodDays: 31 });
    // Floored from the front: a tail starting mid-day counts from the whole day.
    assert.deepEqual(prorationFor(new Date('2026-08-16T12:00:00Z'), SEP1, 'month'), { activeDays: 16, periodDays: 31 });
    assert.deepEqual(prorationFor(new Date('2026-08-31T23:00:00Z'), SEP1, 'month'), { activeDays: 1, periodDays: 31 });
  });
});

describe('changePlan', { skip: harness === null ? SKIP_REASON : false }, () => {
  const db = (harness as { db: SqlExecutor }).db;

  it('upgrades mid-period: old plan for its days, new plan for the rest, in two prorated periods', async () => {
    const sub = await createSubscription(
      db,
      { tenantId: 'acme', subjectId: 'up', key: 'up', plan: basic, seats: 2, startAt: AUG1 },
      NOW,
    );
    const at = new Date('2026-08-16T00:00:00Z'); // 15 days on basic, 16 on pro

    const r = await changePlan(db, {
      tenantId: 'acme',
      subscriptionId: sub.id,
      from: basic,
      to: pro,
      behaviour: 'immediate',
      at,
      usage: { requests: q(500n) },
      now: at,
    });
    assert.deepEqual(r.proration, { periodDays: 31, oldDays: 15, newDays: 16 });
    assert.equal(r.subscription.planId, 'pro');
    assert.equal(r.subscription.pendingPlanId, null);
    assert.equal(r.subscription.currentPeriodStart.toISOString(), at.toISOString());
    assert.equal(r.subscription.currentPeriodEnd.toISOString(), SEP1.toISOString());
    assert.ok(r.closed);
    // basic: 31.00 * 15/31 = 15.00 base, 6.20 * 15/31 = 3.00 seats, 500 requests * 1 minor = 5.00
    assert.deepEqual(
      r.closed.charge.lines.map((l) => [l.kind, l.amount.toDecimalString()]),
      [
        ['flat', '15.00'],
        ['seats', '3.00'],
        ['usage', '5.00'],
      ],
    );
    assert.equal(r.closed.charge.total.toDecimalString(), '23.00');
    assert.ok(r.closed.transaction);
    assert.equal(r.closed.period.end.toISOString(), at.toISOString());
    assert.equal((await owed(db, 'up')).toDecimalString(), '23.00', 'one balanced posting');
    const legs = await entries(db, { tenantId: 'acme', subjectId: 'up' });
    assert.equal(legs.length, 2);

    // The closed head is a period like any other: it can be invoiced.
    const [{ id: headId }] = await db.query<{ id: string }>(
      `SELECT id FROM billing.subscription_periods WHERE subscription_id = $1 AND period_start = $2`,
      [sub.id, AUG1],
    );
    const inv = await invoiceForPeriod(db, { tenantId: 'acme', subscriptionPeriodId: headId }, NOW);
    assert.equal(inv.total.toDecimalString(), '23.00');
    assert.equal(inv.period?.end.toISOString(), at.toISOString());

    // The sweep at period end charges pro for the tail: 62 * 16/31 = 32.00, 12.40 * 16/31 = 6.40
    const report = await chargeDueSubscriptions(db, { now: SEP1, tenantId: 'acme', plan, lease: false });
    assert.equal(report.charged, 1);
    const after = await getSubscription(db, { tenantId: 'acme', id: sub.id });
    assert.equal(after?.currentPeriodStart.toISOString(), SEP1.toISOString());
    assert.equal(after?.currentPeriodEnd.toISOString(), '2026-10-01T00:00:00.000Z', 'back on whole periods');
    assert.equal((await owed(db, 'up')).toDecimalString(), '61.40', '23.00 + 32.00 + 6.40');

    // A retry of the change is a no-op.
    const again = await changePlan(db, {
      tenantId: 'acme',
      subscriptionId: sub.id,
      from: pro,
      to: basic,
      behaviour: 'immediate',
      at,
      now: at,
    });
    assert.equal(again.deduplicated, true);
    assert.equal((await owed(db, 'up')).toDecimalString(), '61.40');
  });

  it('downgrades mid-period the same way, and floors a mid-day change from the front', async () => {
    const sub = await createSubscription(
      db,
      { tenantId: 'acme', subjectId: 'down', key: 'down', plan: pro, startAt: AUG1 },
      NOW,
    );
    const at = new Date('2026-08-21T15:00:00Z'); // 20 whole days on pro, 11 on basic
    const r = await changePlan(db, {
      tenantId: 'acme',
      subscriptionId: sub.id,
      from: pro,
      to: basic,
      behaviour: 'immediate',
      at,
      now: at,
    });
    assert.deepEqual(r.proration, { periodDays: 31, oldDays: 20, newDays: 11 });
    assert.equal(r.closed?.charge.total.toDecimalString(), '40.00', '62 * 20/31');
    await chargeDueSubscriptions(db, { now: SEP1, tenantId: 'acme', plan, lease: false });
    assert.equal((await owed(db, 'down')).toDecimalString(), '51.00', '40.00 + 31 * 11/31');
  });

  it('same-day: switches the plan with nothing to close, and the whole period bills at the new plan', async () => {
    const sub = await createSubscription(
      db,
      { tenantId: 'acme', subjectId: 'same', key: 'same', plan: basic, startAt: AUG1 },
      NOW,
    );
    const r = await changePlan(db, {
      tenantId: 'acme',
      subscriptionId: sub.id,
      from: basic,
      to: pro,
      behaviour: 'immediate',
      at: AUG1,
      now: AUG1,
      seats: 1,
    });
    assert.equal(r.closed, null);
    assert.deepEqual(r.proration, { periodDays: 31, oldDays: 0, newDays: 31 });
    assert.equal(r.subscription.planId, 'pro');
    assert.equal(r.subscription.seats, 1);
    assert.equal(r.subscription.currentPeriodStart.toISOString(), AUG1.toISOString());
    assert.equal((await owed(db, 'same')).toDecimalString(), '0.00');
    assert.equal(
      (await db.query(`SELECT 1 FROM billing.subscription_periods WHERE subscription_id = $1`, [sub.id])).length,
      0,
    );
    await chargeDueSubscriptions(db, { now: SEP1, tenantId: 'acme', plan, lease: false });
    assert.equal((await owed(db, 'same')).toDecimalString(), '68.20', 'pro in full: 62.00 + 6.20');
  });

  it('a change hours into the first day closes a zero-fee head and bills the new plan in full', async () => {
    const sub = await createSubscription(
      db,
      { tenantId: 'acme', subjectId: 'hours', key: 'hours', plan: basic, startAt: AUG1 },
      NOW,
    );
    const at = new Date('2026-08-01T06:00:00Z');
    const r = await changePlan(db, {
      tenantId: 'acme',
      subscriptionId: sub.id,
      from: basic,
      to: pro,
      behaviour: 'immediate',
      at,
      now: at,
    });
    assert.deepEqual(r.proration, { periodDays: 31, oldDays: 0, newDays: 31 });
    assert.equal(r.closed?.transaction, null, 'nothing to post for zero days and no usage');
    assert.deepEqual(r.closed?.charge.lines, []);
    await chargeDueSubscriptions(db, { now: SEP1, tenantId: 'acme', plan, lease: false });
    assert.equal((await owed(db, 'hours')).toDecimalString(), '62.00');
  });

  it('period_end: pending until the next advance applies it', async () => {
    const sub = await createSubscription(
      db,
      { tenantId: 'acme', subjectId: 'later', key: 'later', plan: pro, seats: 3, startAt: AUG1 },
      NOW,
    );
    const r = await changePlan(db, {
      tenantId: 'acme',
      subscriptionId: sub.id,
      from: pro,
      to: basic,
      behaviour: 'period_end',
      at: NOW,
      now: NOW,
    });
    assert.equal(r.subscription.planId, 'pro', 'still on pro');
    assert.equal(r.subscription.pendingPlanId, 'basic');
    assert.equal(r.effectiveAt.toISOString(), SEP1.toISOString());
    assert.equal(r.closed, null);

    const charged = await chargeSubscriptionPeriod(db, { plan: pro, subscription: r.subscription, now: SEP1 });
    assert.equal(charged.charge.total.toDecimalString(), '80.60', 'August in full at pro: 62.00 + 3 * 6.20');
    assert.equal(charged.subscription.planId, 'basic', 'the advance applied the pending plan');
    assert.equal(charged.subscription.pendingPlanId, null);
    assert.equal(charged.subscription.currentPeriodStart.toISOString(), SEP1.toISOString());

    // Retried: found, not re-applied.
    const again = await changePlan(db, {
      tenantId: 'acme',
      subscriptionId: sub.id,
      from: basic,
      to: pro,
      behaviour: 'period_end',
      at: NOW,
      now: NOW,
    });
    assert.equal(again.deduplicated, false, 'a different effective_at (October) is a new change');
    assert.equal(again.subscription.pendingPlanId, 'pro');
  });

  it('refuses what it cannot do, with typed errors', async () => {
    const sub = await createSubscription(
      db,
      { tenantId: 'acme', subjectId: 'bad', key: 'bad', plan: basic, startAt: AUG1 },
      NOW,
    );
    const base = { tenantId: 'acme', subscriptionId: sub.id, behaviour: 'immediate' as const, now: NOW };
    const code = (e: unknown) => (BillingError.is(e) ? e.code : String(e));
    await assert.rejects(
      changePlan(db, { ...base, from: basic, to: basic }),
      (e) => code(e) === 'invalid_subscription',
    );
    await assert.rejects(changePlan(db, { ...base, from: basic, to: eur }), (e) => code(e) === 'currency_mismatch');
    await assert.rejects(
      changePlan(db, { ...base, from: basic, to: yearly }),
      (e) => code(e) === 'invalid_subscription',
    );
    await assert.rejects(
      changePlan(db, { ...base, from: pro, to: basic }),
      (e) => code(e) === 'invalid_subscription',
      'wrong from',
    );
    await assert.rejects(
      changePlan(db, { ...base, from: basic, to: pro, at: SEP1 }),
      (e) => code(e) === 'invalid_subscription',
      'outside period',
    );
    await assert.rejects(
      changePlan(db, { ...base, from: basic, to: pro, seats: -1 }),
      (e) => code(e) === 'invalid_subscription',
    );
    await assert.rejects(
      changePlan(db, { ...base, subscriptionId: '00000000-0000-0000-0000-000000000000', from: basic, to: pro }),
      (e) => code(e) === 'not_found',
    );
    await cancelSubscription(db, { tenantId: 'acme', id: sub.id }, 'immediately', NOW);
    await assert.rejects(changePlan(db, { ...base, from: basic, to: pro }), (e) => code(e) === 'invalid_subscription');
    // closeAt outside the period is refused at the settle layer too.
    const s2 = await createSubscription(
      db,
      { tenantId: 'acme', subjectId: 'bad2', key: 'bad2', plan: basic, startAt: AUG1 },
      NOW,
    );
    await assert.rejects(
      chargeSubscriptionPeriod(db, {
        plan: basic,
        subscription: s2,
        now: NOW,
        closeAt: new Date('2026-07-01T00:00:00Z'),
      }),
      (e) => code(e) === 'invalid_subscription',
    );
  });

  it('chargeForPeriod drops zero-day fee lines rather than printing 0.00', () => {
    const c = chargeForPeriod(basic, { seats: 2, proration: { activeDays: 0, periodDays: 31 } });
    assert.deepEqual(c.lines, []);
    assert.equal(c.total.toDecimalString(), '0.00');
  });
});
