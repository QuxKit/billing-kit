// Entitlements against Postgres: the answer is derived from the subscription,
// the plan, this period's usage and the wallet, so the test drives all four
// through their real write paths and asserts the read.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { activeSubscription, check, createEntitlements, list, periodContaining } from '../src/entitlements/index.ts';
import { BillingError } from '../src/errors';
import { record } from '../src/events';
import { post, walletTopupPosting } from '../src/ledger';
import { Money, Quantity, Rate } from '../src/money';
import { definePlan } from '../src/subscriptions/plan.ts';
import { chargeSubscriptionPeriod } from '../src/subscriptions/settle.ts';
import { cancelSubscription, createSubscription } from '../src/subscriptions/store.ts';
import type { Plan } from '../src/subscriptions/types.ts';
import type { SqlExecutor } from '../src/types';
import { fromPool, SKIP_REASON, TEST_DATABASE_URL, unreachable } from './pg-executor';

const usd = (v: string) => Money.fromDecimalString(v, 'USD');
const q = (n: bigint) => Quantity.fromBigInt(n);
const NOW = new Date('2026-08-17T12:00:00Z');
const START = new Date('2026-08-01T00:00:00Z');

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
  return { db: fromPool(pool), close: () => pool.end() };
}

const team = definePlan({
  id: 'team',
  currency: 'USD',
  interval: 'month',
  flat: usd('49.00'),
  usage: [{ metric: 'requests', price: { kind: 'flat', rate: Rate.fromDecimalString('0.1') } }],
  features: {
    sso: true,
    // priced by the plan → postpaid overage by default
    api: { limit: q(100n), meter: 'requests' },
    // not priced → deny by default
    exports: { limit: q(2n), meter: 'exports' },
    // explicit wallet overage
    renders: { limit: q(1n), meter: 'renders', overage: 'wallet' },
    peak: { limit: q(50n), meter: 'concurrency', method: 'max' },
  },
});
const free = definePlan({
  id: 'free',
  currency: 'USD',
  interval: 'month',
  flat: usd('0.00'),
  usage: [],
  features: { exports: { limit: q(1n), meter: 'exports' } },
});
const catalogue: Record<string, Plan> = { team, free };
const plan = (id: string) => catalogue[id];

const harness = await setup();
after(async () => {
  await harness?.close();
});

describe('definePlan features', () => {
  it('validates feature definitions', () => {
    const base = { id: 'p', currency: 'USD', interval: 'month' as const, flat: usd('1.00'), usage: [] };
    const bad = (features: Plan['features']) =>
      assert.throws(
        () => definePlan({ ...base, features }),
        (e) => BillingError.hasCode(e, 'invalid_plan'),
      );
    bad({ x: { limit: q(-1n), meter: 'm' } });
    bad({ x: { limit: q(1n), meter: '' } });
    bad({ x: { limit: q(1n), meter: 'm', overage: 'postpaid' } }); // not priced
    bad({ x: { limit: q(1n), meter: 'm', method: 'median' as 'sum' } });
    bad({ x: { limit: q(1n), meter: 'm', overage: 'maybe' as 'deny' } });
    bad({ '': true });
    const ok = definePlan({ ...base, features: { sso: true } });
    assert.ok(Object.isFrozen(ok.features));
  });
});

describe('entitlements', { skip: harness === null ? SKIP_REASON : false }, () => {
  const db = (harness as { db: SqlExecutor }).db;
  const ada = { tenantId: 'acme', subjectId: 'ada' };
  const use = async (metric: string, quantity: bigint, id: string, at = NOW, subjectId = 'ada') =>
    record(
      db,
      { tenantId: 'acme', subjectId, source: 'app', externalId: id, metric, quantity: q(quantity), occurredAt: at },
      NOW,
    );

  it('denies a subject with no subscription, and a feature the plan lacks', async () => {
    const none = await check(db, { ...ada, feature: 'sso', plan, at: NOW });
    assert.deepEqual(none, { feature: 'sso', allowed: false, kind: 'boolean', reason: 'no_subscription' });
    assert.deepEqual(await list(db, { ...ada, plan, at: NOW }), []);

    await createSubscription(db, { ...ada, key: 'ent-1', plan: team, startAt: START }, NOW);
    const missing = await check(db, { ...ada, feature: 'teleport', plan, at: NOW });
    assert.equal(missing.allowed, false);
    assert.equal(missing.reason, 'not_in_plan');
    assert.equal(missing.planId, 'team');
  });

  it('answers a boolean gate from the plan', async () => {
    const sso = await check(db, { ...ada, feature: 'sso', plan, at: NOW });
    assert.equal(sso.allowed, true);
    assert.equal(sso.kind, 'boolean');
    assert.ok(sso.subscriptionId);
  });

  it('meters an allowance over the current period and allows postpaid overage for a priced meter', async () => {
    await use('requests', 60n, 'r1');
    await use('requests', 30n, 'r2');
    await use('requests', 500n, 'r-old', new Date('2026-07-15T00:00:00Z')); // last period: not counted
    let api = await check(db, { ...ada, feature: 'api', plan, at: NOW });
    assert.equal(api.allowed, true);
    assert.equal(api.kind, 'metered');
    assert.equal(api.used?.toDecimalString(), '90.000000000000');
    assert.equal(api.remaining?.toDecimalString(), '10.000000000000');
    assert.equal(api.overage, undefined);
    assert.equal(api.period?.start.toISOString(), START.toISOString());

    await use('requests', 10n, 'r3');
    api = await check(db, { ...ada, feature: 'api', plan, at: NOW });
    assert.equal(api.allowed, true, 'at the limit, overage is postpaid because the plan prices requests');
    assert.equal(api.overage, true);
    assert.equal(api.remaining?.toDecimalString(), '0.000000000000');
  });

  it('denies past the limit when the meter is not priced', async () => {
    await use('exports', 1n, 'e1');
    let ex = await check(db, { ...ada, feature: 'exports', plan, at: NOW });
    assert.equal(ex.allowed, true);
    assert.equal(ex.remaining?.toDecimalString(), '1.000000000000');
    await use('exports', 1n, 'e2');
    ex = await check(db, { ...ada, feature: 'exports', plan, at: NOW });
    assert.equal(ex.allowed, false);
    assert.equal(ex.reason, 'limit_reached');
    assert.equal(ex.used?.toDecimalString(), '2.000000000000');
  });

  it('allows wallet overage while the wallet holds credit, and denies when it is empty', async () => {
    await use('renders', 1n, 'rd1');
    let r = await check(db, { ...ada, feature: 'renders', plan, at: NOW });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'wallet_empty');
    assert.equal(r.wallet?.toDecimalString(), '0.00');

    await post(db, walletTopupPosting({ ...ada, paymentId: 'topup-1', amount: usd('5.00'), occurredAt: START }), NOW);
    r = await check(db, { ...ada, feature: 'renders', plan, at: NOW });
    assert.equal(r.allowed, true);
    assert.equal(r.overage, true);
    assert.equal(r.wallet?.toDecimalString(), '5.00');
  });

  it('honours the aggregation method (max)', async () => {
    await use('concurrency', 40n, 'c1');
    await use('concurrency', 30n, 'c2');
    const p = await check(db, { ...ada, feature: 'peak', plan, at: NOW });
    assert.equal(p.used?.toDecimalString(), '40.000000000000', 'max, not sum');
    assert.equal(p.allowed, true);
  });

  it('lists every feature of the plan', async () => {
    const all = await list(db, { ...ada, plan, at: NOW });
    assert.deepEqual(
      all.map((e) => [e.feature, e.allowed, e.kind]),
      [
        ['sso', true, 'boolean'],
        ['api', true, 'metered'],
        ['exports', false, 'metered'],
        ['renders', true, 'metered'],
        ['peak', true, 'metered'],
      ],
    );
    await assert.rejects(list(db, { ...ada, plan: () => undefined, at: NOW }), (e) =>
      BillingError.hasCode(e, 'not_found'),
    );
    const unknown = await check(db, { ...ada, feature: 'sso', plan: () => undefined, at: NOW });
    assert.equal(unknown.reason, 'unknown_plan');
  });

  it('measures over the period that contains `at` when the sweep is late', async () => {
    const sub = await activeSubscription(db, { ...ada, at: NOW });
    assert.ok(sub);
    const late = new Date('2026-10-10T00:00:00Z'); // two periods on, row not advanced
    const p = periodContaining(sub, team, late);
    assert.equal(p.start.toISOString(), '2026-10-01T00:00:00.000Z');
    assert.equal(p.end.toISOString(), '2026-11-01T00:00:00.000Z');
    // Before the current period: answers for the current period, never steps back.
    assert.equal(
      periodContaining(sub, team, new Date('2026-07-01T00:00:00Z')).start.toISOString(),
      START.toISOString(),
    );

    const ex = await check(db, { ...ada, feature: 'exports', plan, at: late });
    assert.equal(ex.allowed, true, 'the exports this period do not count against October');
    assert.equal(ex.used?.toDecimalString(), '0.000000000000');
  });

  it('follows the advanced period after a charge, and stops at cancellation', async () => {
    const sub = await activeSubscription(db, { ...ada, at: NOW });
    assert.ok(sub);
    await chargeSubscriptionPeriod(db, { plan: team, subscription: sub, now: NOW });
    const next = new Date('2026-09-05T00:00:00Z');
    const ex = await check(db, { ...ada, feature: 'exports', plan, at: next });
    assert.equal(ex.period?.start.toISOString(), '2026-09-01T00:00:00.000Z');
    assert.equal(ex.allowed, true);

    await cancelSubscription(db, { tenantId: 'acme', id: sub.id }, 'immediately', next);
    const after = await check(db, { ...ada, feature: 'sso', plan, at: new Date('2026-09-06T00:00:00Z') });
    assert.equal(after.reason, 'no_subscription');
    const before = await check(db, { ...ada, feature: 'sso', plan, at: NOW });
    assert.equal(before.allowed, true, 'still entitled at an instant before the cancellation');
  });

  it('binds db, catalogue and clock with createEntitlements', async () => {
    await createSubscription(db, { tenantId: 'acme', subjectId: 'bob', key: 'ent-2', plan: free, startAt: START }, NOW);
    const ent = createEntitlements({ db, plan, clock: () => NOW });
    const ex = await ent.check({ tenantId: 'acme', subjectId: 'bob', feature: 'exports' });
    assert.equal(ex.allowed, true);
    assert.equal(ex.limit?.toDecimalString(), '1.000000000000');
    assert.equal((await ent.list({ tenantId: 'acme', subjectId: 'bob' })).length, 1);
    assert.equal((await ent.check({ tenantId: 'acme', subjectId: 'bob', feature: 'sso' })).reason, 'not_in_plan');
  });
});
