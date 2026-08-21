// Multi-product subjects and bundles (issue #38).
//
// The regression that matters most: a subject holding two subscriptions —
// one per product, which UNIQUE (tenant_id, key) has always permitted — used
// to have every entitlement of the older one silently eclipsed by the newer
// (`activeSubscription` was LIMIT 1). check() and list() now consult all of
// them. The bundle half proves one composed Plan charges with per-product
// lines and refuses the compositions that would misprice.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { activeSubscription, activeSubscriptions, check, list } from '../src/entitlements/index.ts';
import { BillingError } from '../src/errors';
import { record } from '../src/events';
import { Money, Quantity, Rate } from '../src/money';
import { defineBundle } from '../src/subscriptions/bundle.ts';
import { chargeForPeriod, definePlan } from '../src/subscriptions/plan.ts';
import { createSubscription } from '../src/subscriptions/store.ts';
import type { PlanResolver } from '../src/entitlements/index.ts';
import type { Plan } from '../src/subscriptions/types.ts';
import type { SqlExecutor } from '../src/types';
import { fromPool, SKIP_REASON, TEST_DATABASE_URL, unreachable } from './pg-executor';

const usd = (v: string) => Money.fromDecimalString(v, 'USD');
const q = (n: bigint) => Quantity.fromBigInt(n);
const NOW = new Date('2026-08-17T12:00:00Z');
const START = new Date('2026-08-01T00:00:00Z');
const T = 'tenant_multi';

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
  await pool.query(await ddl('033_tax_lines.sql'));
  return { db: fromPool(pool), close: () => pool.end() };
}

// Two products, deliberately overlapping on one feature key ('api') with
// different limits, so the most-permissive rule is observable.
const CLOUD: Plan = definePlan({
  id: 'cloud-monthly',
  productId: 'billing-kit-cloud',
  currency: 'USD',
  interval: 'month',
  flat: usd('49.00'),
  usage: [{ metric: 'billing.events', price: { kind: 'flat', rate: Rate.fromDecimalString('0.007') } }],
  features: {
    'billing.dashboard': true,
    api: { limit: q(1000n), meter: 'api.calls', overage: 'deny' },
  },
});

const MAILPRO: Plan = definePlan({
  id: 'mail-pro-monthly',
  productId: 'mail-kit-cloud',
  currency: 'USD',
  interval: 'month',
  flat: usd('19.00'),
  usage: [{ metric: 'mail.sends', price: { kind: 'flat', rate: Rate.fromDecimalString('0.10') } }],
  features: {
    'mail.domains': true,
    api: { limit: q(5000n), meter: 'api.calls', overage: 'deny' },
  },
});

const resolve: PlanResolver = async (id) =>
  ({ 'cloud-monthly': CLOUD, 'mail-pro-monthly': MAILPRO } as Record<string, Plan>)[id];

const harness = await setup();
after(() => harness?.close());

describe('entitlements across products', { skip: harness === null ? SKIP_REASON : false }, () => {
  const db = (harness as NonNullable<typeof harness>).db;

  it('a second product no longer eclipses the first (the LIMIT 1 regression)', async () => {
    await createSubscription(db, { tenantId: T, subjectId: 'acme', key: 'acme-cloud', plan: CLOUD, startAt: START }, START);
    const later = new Date('2026-08-02T00:00:00Z');
    await createSubscription(db, { tenantId: T, subjectId: 'acme', key: 'acme-mail', plan: MAILPRO, startAt: later }, later);

    const subs = await activeSubscriptions(db, { tenantId: T, subjectId: 'acme', at: NOW });
    assert.equal(subs.length, 2, 'both subscriptions are active');
    assert.equal((await activeSubscription(db, { tenantId: T, subjectId: 'acme', at: NOW }))?.planId, 'mail-pro-monthly', 'the singular still answers newest, for compatibility');

    // The regression: 'billing.dashboard' lives only on the OLDER subscription.
    const dashboard = await check(db, { tenantId: T, subjectId: 'acme', feature: 'billing.dashboard', plan: resolve, at: NOW });
    assert.equal(dashboard.allowed, true, 'the older product\'s entitlement survives the newer purchase');
    assert.equal(dashboard.planId, 'cloud-monthly');

    const mail = await check(db, { tenantId: T, subjectId: 'acme', feature: 'mail.domains', plan: resolve, at: NOW });
    assert.equal(mail.allowed, true);

    const nowhere = await check(db, { tenantId: T, subjectId: 'acme', feature: 'sso', plan: resolve, at: NOW });
    assert.equal(nowhere.allowed, false);
    assert.equal(nowhere.reason, 'not_in_plan');
  });

  it('a feature both plans define resolves to the most permissive verdict', async () => {
    const api = await check(db, { tenantId: T, subjectId: 'acme', feature: 'api', plan: resolve, at: NOW });
    assert.equal(api.allowed, true);
    assert.equal(api.limit?.units, q(5000n).units, 'the larger allowance wins');
    assert.equal(api.planId, 'mail-pro-monthly');
  });

  it('list() returns the union, one row per feature', async () => {
    const all = await list(db, { tenantId: T, subjectId: 'acme', plan: resolve, at: NOW });
    const byKey = new Map(all.map((e) => [e.feature, e]));
    assert.deepEqual([...byKey.keys()].sort(), ['api', 'billing.dashboard', 'mail.domains']);
    assert.equal(byKey.get('api')?.limit?.units, q(5000n).units, 'the duplicate key keeps the permissive row');
  });

  it('usage on a metered feature still counts within the winning period', async () => {
    await record(
      db,
      {
        tenantId: T,
        subjectId: 'acme',
        source: 'test',
        externalId: 'burn-1',
        metric: 'api.calls',
        quantity: q(4999n),
        occurredAt: NOW,
      },
      NOW,
    );
    const api = await check(db, { tenantId: T, subjectId: 'acme', feature: 'api', plan: resolve, at: NOW });
    assert.equal(api.allowed, true);
    assert.equal(api.remaining?.units, q(1n).units);
  });
});

// Feature-disjoint variants for composition: CLOUD and MAILPRO deliberately
// share the 'api' key for the entitlement tests above, and defineBundle
// refuses exactly that collision — which its own test below proves.
const CLOUD_B = definePlan({ ...CLOUD, id: 'cloud-b', features: { 'billing.dashboard': true } });
const MAIL_B = definePlan({ ...MAILPRO, id: 'mail-b', features: { 'mail.domains': true } });

describe('bundles', () => {
  it('composes two products into one plan that charges per-product lines', () => {
    const bundle = defineBundle({
      id: 'growth-bundle',
      items: [
        { productId: 'billing-kit-cloud', plan: CLOUD_B },
        { productId: 'mail-kit-cloud', plan: MAIL_B },
      ],
    });
    assert.deepEqual(Object.keys(bundle.features ?? {}).sort(), ['billing.dashboard', 'mail.domains'],
      'the bundle carries the union of member features');
    assert.equal(bundle.flat.toDecimalString(), '68.00', 'flats sum');
    assert.equal(bundle.usage.length, 2);

    const charge = chargeForPeriod(bundle, {
      usage: {
        'billing.events': q(10_000n),
        'mail.sends': q(100n),
      },
      discount: { kind: 'percent', bps: 2000 },
    });
    const products = charge.lines.map((l) => [l.kind, l.productId ?? '—']);
    assert.deepEqual(products, [
      ['flat', '—'], // the merged base fee is the bundle's own — phase 1 limitation, documented
      ['usage', 'billing-kit-cloud'],
      ['usage', 'mail-kit-cloud'],
      ['discount', '—'],
    ]);
    // Rates are minor units per unit: 10,000 × 0.007¢ = $0.70 of events,
    // 100 × 0.10¢ = $0.10 of sends. 68.00 + 0.70 + 0.10 = 68.80, −20% = 55.04.
    assert.equal(charge.total.toDecimalString(), '55.04');
  });

  it('refuses the compositions that would misprice', () => {
    const clash = definePlan({ ...MAILPRO, id: 'clash', usage: CLOUD.usage });
    assert.throws(
      () => defineBundle({ id: 'x', items: [{ productId: 'a', plan: CLOUD }, { productId: 'b', plan: clash }] }),
      (e: unknown) => e instanceof BillingError && /metric 'billing.events' is sold by both/.test(e.message),
    );

    const annual = definePlan({ ...MAILPRO, id: 'mail-annual', interval: 'year', features: undefined });
    assert.throws(
      () => defineBundle({ id: 'x', items: [{ productId: 'a', plan: CLOUD }, { productId: 'b', plan: annual }] }),
      (e: unknown) => e instanceof BillingError && /mixed intervals/.test(e.message),
    );

    const featureClash = definePlan({ ...MAILPRO, id: 'fc', usage: [], features: CLOUD.features });
    assert.throws(
      () => defineBundle({ id: 'x', items: [{ productId: 'a', plan: CLOUD }, { productId: 'b', plan: featureClash }] }),
      (e: unknown) => e instanceof BillingError && /feature '(billing\.dashboard|api)' is defined by both/.test(e.message),
    );

    assert.throws(
      () => defineBundle({ id: 'solo', items: [{ productId: 'a', plan: CLOUD }] }),
      (e: unknown) => e instanceof BillingError && /at least two items/.test(e.message),
    );

    const seatsA = definePlan({ ...CLOUD, id: 'sa', features: undefined, seats: { unit: usd('10.00') } });
    const seatsB = definePlan({ ...MAILPRO, id: 'sb', features: undefined, seats: { unit: usd('5.00') } });
    assert.throws(
      () => defineBundle({ id: 'x', items: [{ productId: 'a', plan: seatsA }, { productId: 'b', plan: seatsB }] }),
      (e: unknown) => e instanceof BillingError && /two seat definitions/.test(e.message),
    );
  });
});
