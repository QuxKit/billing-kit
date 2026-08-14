// Adversarial probes of the core money paths.
//
// These are red on purpose. Each failure names a real defect in the shipped
// code — A2 and A4 in particular, where a replay carrying a *different* amount
// is reported as a boring duplicate and the correction is silently discarded.
// A red test that names a defect is worth more than a green suite that hides
// one, so they stay, and they stay failing until the semantics are settled.
//
// They live in their own directory so `prepublishOnly` can gate on the shipped
// suite without that decision being a vote on A2/A4. `pnpm test` still runs
// them and is still red: a developer should see this, a release should not be
// blocked by it forever. `pnpm run test:adversarial` runs only these.
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

import { record, recordMany, queryUsage } from '../../src/events';
import { post, balance, accrualPosting, paymentPosting, entries } from '../../src/ledger';
import { Money, Quantity, price, Rate, allocate } from '../../src/money';
import { fromPool } from '../pg-executor';

// Not `URL`: that name shadows the global URL constructor used below.
const DB_URL = process.env.BILLING_KIT_TEST_DATABASE_URL ?? 'postgres://localhost:5432/bk_core_attack';
const pool = new pg.Pool({ connectionString: DB_URL, max: 8 });
const db = fromPool(pool);
const now = new Date();

test.before(async () => {
  const { readFile } = await import('node:fs/promises');
  const ddl = await readFile(new URL('../../sql/001_core.sql', import.meta.url), 'utf8');
  await pool.query('DROP SCHEMA IF EXISTS billing CASCADE');
  await pool.query(ddl);
  await pool.query('SELECT billing.ensure_core_partitions(2, $1)', [now]);
});
test.after(() => pool.end());

test('A1: two metrics from one request id — the second is silently discarded', async () => {
  const base = {
    tenantId: 't', subjectId: 's1', source: 'gateway', externalId: 'req-A1',
    occurredAt: now,
  };
  const inTok = await record(db, { ...base, metric: 'tokens.input', quantity: Quantity.fromBigInt(1000n) }, now);
  const outTok = await record(db, { ...base, metric: 'tokens.output', quantity: Quantity.fromBigInt(4000n) }, now);

  console.log('  input  ->', inTok);
  console.log('  output ->', outTok);

  const stored = await queryUsage(db, {
    tenantId: 't', subjectId: 's1',
    window: { start: new Date(now.getTime() - 86400e3), end: new Date(now.getTime() + 86400e3) },
  });
  console.log('  stored rows:', stored.map((s) => `${s.metric}=${s.quantity.toDecimalString()}`));
  assert.equal(stored.length, 2, '5000 tokens of billable usage; only 1000 was stored');
});

test('A2: replay with a DIFFERENT quantity is reported as a duplicate', async () => {
  const base = {
    tenantId: 't', subjectId: 's2', source: 'gateway', externalId: 'req-A2',
    metric: 'tokens.input', occurredAt: now,
  };
  await record(db, { ...base, quantity: Quantity.fromBigInt(10n) }, now);
  const second = await record(db, { ...base, quantity: Quantity.fromBigInt(1_000_000n) }, now);
  console.log('  second call ->', second);

  const stored = await queryUsage(db, {
    tenantId: 't', subjectId: 's2',
    window: { start: new Date(now.getTime() - 86400e3), end: new Date(now.getTime() + 86400e3) },
  });
  console.log('  stored quantity:', stored[0]?.quantity.toDecimalString());
  assert.equal(second.deduplicated, false, 'a payload change should not be reported as a boring retry');
});

test('A3: same external id, DIFFERENT subject — charged to the wrong customer / dropped', async () => {
  const base = { tenantId: 't', source: 'gateway', externalId: 'req-A3', metric: 'm', occurredAt: now };
  await record(db, { ...base, subjectId: 'alice', quantity: Quantity.fromBigInt(1n) }, now);
  const bob = await record(db, { ...base, subjectId: 'bob', quantity: Quantity.fromBigInt(999n) }, now);
  console.log('  bob ->', bob);
  const bobRows = await queryUsage(db, {
    tenantId: 't', subjectId: 'bob',
    window: { start: new Date(now.getTime() - 86400e3), end: new Date(now.getTime() + 86400e3) },
  });
  assert.equal(bobRows.length, 1, "bob's usage vanished into alice's dedupe key");
});

test('A4: ledger replay with different legs silently returns the OLD transaction', async () => {
  const p1 = accrualPosting({
    tenantId: 't', subjectId: 's4', chargeId: 'charge-A4',
    amount: Money.fromDecimalString('5.00', 'USD'),
  });
  await post(db, p1, now);

  const p2 = accrualPosting({
    tenantId: 't', subjectId: 's4', chargeId: 'charge-A4',
    amount: Money.fromDecimalString('500.00', 'USD'),
  });
  const r2 = await post(db, p2, now);
  console.log('  replay deduplicated =', r2.deduplicated,
    'entries =', r2.entries.map((e) => `${e.account}:${e.amount.toDecimalString()}`));

  const bal = await balance(db, { tenantId: 't', subjectId: 's4', account: 'customer_balance', currency: 'USD' });
  console.log('  balance =', bal.toString());
  assert.equal(bal.toDecimalString(), '500.00', 'the corrected amount was silently discarded');
});

test('A5: a late payment webhook cannot be posted — no partition, no default', async () => {
  const old = new Date(now.getTime() - 120 * 24 * 3600e3); // 4 months ago
  const p = paymentPosting({
    tenantId: 't', subjectId: 's5', paymentId: 'pay-A5',
    amount: Money.fromDecimalString('100.00', 'USD'), occurredAt: old,
  });
  await post(db, p, now); // expect: throws 23514 "no partition of relation"
});

test('A6: entries() silently truncates at 500 — a re-derived balance is short', async () => {
  for (let i = 0; i < 600; i++) {
    await post(db, accrualPosting({
      tenantId: 't', subjectId: 's6', chargeId: `c-A6-${i}`,
      amount: Money.fromDecimalString('0.01', 'USD'),
    }), now);
  }
  const rows = await entries(db, { tenantId: 't', subjectId: 's6', account: 'customer_balance' });
  const derived = Money.sum(rows.map((r) => r.amount), 'USD');
  const authoritative = await balance(db, {
    tenantId: 't', subjectId: 's6', account: 'customer_balance', currency: 'USD',
  });
  console.log(`  entries() returned ${rows.length} rows -> ${derived.toString()}`);
  console.log(`  balance()                            -> ${authoritative.toString()}`);
  assert.equal(derived.toDecimalString(), authoritative.toDecimalString(),
    'entries() truncated with no signal, so the derived total is wrong');
});

test('A7: the two layers agree on what a rate literal means', async () => {
  // Both layers now read a rate as MINOR units per unit (the decided convention).
  // money.ts price() no longer applies a major->minor conversion, so 1 unit at
  // rate 0.0019 is 0.0019 minor units — the same value the SQL charge formula
  // (round(quantity * rate)) produces. Before the fix these disagreed by
  // 10^exponent: money.ts read the rate as dollars and priced it 100x high.
  const p = price(Quantity.fromBigInt(1n), Rate.fromDecimalString('0.0019'), 'USD');
  const { rows } = await pool.query<{ v: string }>(
    "SELECT (1 * 0.0019::numeric)::text AS v");
  console.log('  money.ts exactMinor =', p.exactMinor, '| sql =', rows[0]!.v);
  // Compared by value, not by string: exactMinor is zero-padded to full scale,
  // and the invariant under test is that the two layers price a rate the same,
  // not that they format a decimal the same.
  assert.equal(Number(p.exactMinor), Number(rows[0]!.v),
    'the same rate literal must mean the same price in both layers');
});

test('A8: allocate() is documented as largest-remainder but is not', async () => {
  const out = allocate(Money.fromMinor(10n, 'USD'), [1n, 1n, 97n]);
  console.log('  allocate 10 over weights [1,1,97] ->', out.map((m) => m.minor.toString()));
  // largest remainder: floors are 0,0,9; remainders .1,.1,9.7 -> the leftover
  // penny belongs to the largest remainder (the 97 share).
  assert.deepEqual(out.map((m) => m.minor), [0n, 0n, 10n]);
});
