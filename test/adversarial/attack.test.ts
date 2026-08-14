// Adversarial probes of the core money paths.
//
// These were red on purpose, and four of them stayed red for a while: a test
// that names a defect is worth more than a green suite that hides one. What
// they found — A2 and A4, a replay carrying a different amount reported as a
// boring duplicate with the correction silently discarded; A5, a real payment
// that could not be recorded at all; A8, an allocation that gave a penny to
// whoever sorted first — is written up case by case below.
//
// They are green now, all eight, and `prepublishOnly` gates on the whole suite
// again — the split existed only because these were red, and that reason is
// gone. They stay in their own directory because they are a different kind of
// test: the unit suite checks that a decision was implemented, and these ask
// what an adversary can get the system to do. Keeping them apart means a future
// red one is legible as "something can be attacked" rather than as a failure
// somewhere in the pile. `pnpm run test:adversarial` runs only these.
//
// A case name here describes what the probe FOUND, in the past tense where the
// defect is fixed. Renaming them to describe the fix would lose the record of
// what was once true, which is the more useful half.
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

import { BillingError } from '../../src/errors';
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

test('A2: replay with a DIFFERENT quantity is refused, not called a duplicate', async () => {
  // Was: the second call hit the dedupe key, took the duplicate branch and
  // returned `deduplicated: true` — success, for a request never performed,
  // leaving 10 billed where 1,000,000 was sent.
  //
  // Now: refused. Keeping the stored value discards a correction and
  // overwriting it lets a stale retry clobber one; the two cannot be told apart
  // from inside record(), so neither is chosen and the caller is told.
  const base = {
    tenantId: 't', subjectId: 's2', source: 'gateway', externalId: 'req-A2',
    metric: 'tokens.input', occurredAt: now,
  };
  await record(db, { ...base, quantity: Quantity.fromBigInt(10n) }, now);

  await assert.rejects(
    () => record(db, { ...base, quantity: Quantity.fromBigInt(1_000_000n) }, now),
    (e: unknown) => BillingError.hasCode(e, 'idempotency_conflict'),
    'a payload change must not be reported as a boring retry',
  );

  // And the refusal changed nothing: the first quantity is still the only one.
  const stored = await queryUsage(db, {
    tenantId: 't', subjectId: 's2',
    window: { start: new Date(now.getTime() - 86400e3), end: new Date(now.getTime() + 86400e3) },
  });
  assert.equal(stored.length, 1);
  assert.equal(Number(stored[0]!.quantity.toDecimalString()), 10);

  // An identical retry is still boring, which is the contract the refusal must
  // not have broken.
  const same = await record(db, { ...base, quantity: Quantity.fromBigInt(10n) }, now);
  assert.equal(same.deduplicated, true);
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

test('A4: ledger replay with different legs is refused, not silently discarded', async () => {
  // Was: the $500.00 posting hit the idempotency key, returned the $5.00
  // transaction with `deduplicated: true`, and wrote nothing. The caller was
  // told it succeeded and the $500.00 was gone — no failed row, no error, and a
  // transaction that looks perfectly well formed. It surfaces later as a
  // balance that disagrees with the provider's, with nothing to follow back.
  //
  // Now: refused. Note what the fix is NOT — the correction is not applied
  // either. A ledger is append-only; correcting a posted transaction is a
  // reversing entry and a new posting, both of which stay visible. Overwriting
  // in place would destroy the audit trail that is the reason to keep a
  // double-entry ledger at all.
  const p1 = accrualPosting({
    tenantId: 't', subjectId: 's4', chargeId: 'charge-A4',
    amount: Money.fromDecimalString('5.00', 'USD'),
  });
  await post(db, p1, now);

  const p2 = accrualPosting({
    tenantId: 't', subjectId: 's4', chargeId: 'charge-A4',
    amount: Money.fromDecimalString('500.00', 'USD'),
  });

  await assert.rejects(
    () => post(db, p2, now),
    (e: unknown) => BillingError.hasCode(e, 'idempotency_conflict'),
    'a different posting under a used key must not be answered with the old transaction',
  );

  const bal = await balance(db, { tenantId: 't', subjectId: 's4', account: 'customer_balance', currency: 'USD' });
  assert.equal(bal.toDecimalString(), '5.00', 'the refusal must not have written anything');

  // The identical replay stays boring — the retry contract is intact.
  const again = await post(db, accrualPosting({
    tenantId: 't', subjectId: 's4', chargeId: 'charge-A4',
    amount: Money.fromDecimalString('5.00', 'USD'),
  }), now);
  assert.equal(again.deduplicated, true);
  assert.equal(again.entries.length, p1.legs.length);
});

test('A5: a late payment webhook posts into the default partition', async () => {
  // What used to happen: billing.ledger_entries is PARTITION BY RANGE
  // (posted_at), ensure_core_partitions only built a window around now, and
  // there was no DEFAULT partition. A payment webhook carrying a four-month-old
  // occurredAt had nowhere to land and Postgres refused the insert outright —
  // "no partition of relation ... found for row". Late webhooks are normal: a
  // provider retries for days, a reconciliation job backfills a quarter, a
  // dead-letter queue gets replayed. Money was being rejected for want of a
  // partition, which is the worst thing a billing system can do.
  //
  // 001_core now creates a DEFAULT partition on every range-partitioned table,
  // so a row outside every declared month is stored rather than refused. This
  // asserts the payment posts and can be read back — not merely that nothing
  // threw, because a posting that vanished would also not throw.
  const old = new Date(now.getTime() - 120 * 24 * 3600e3); // 4 months ago
  const p = paymentPosting({
    tenantId: 't', subjectId: 's5', paymentId: 'pay-A5',
    amount: Money.fromDecimalString('100.00', 'USD'), occurredAt: old,
  });
  const posted = await post(db, p, now);
  console.log('  posted ->', posted.entries.map((e) => `${e.account}:${e.amount.toDecimalString()}`));

  assert.equal(posted.deduplicated, false);
  assert.equal(posted.entries.length, 2);

  // Readable back through the normal query path, in the right account, for the
  // right subject, at the timestamp the provider gave us.
  const read = await entries(db, { tenantId: 't', subjectId: 's5' });
  assert.deepEqual(
    read.map((e) => `${e.account}:${e.amount.toDecimalString()}`).sort(),
    ['cash:100.00', 'customer_balance:-100.00'],
  );
  assert.equal(read[0]!.postedAt.getTime(), old.getTime(), 'posted at the provider timestamp, not at arrival');

  const cash = await balance(db, { tenantId: 't', subjectId: 's5', account: 'cash', currency: 'USD' });
  assert.equal(cash.toDecimalString(), '100.00');

  // And it really did go to the default partition, which is what makes this a
  // test of the backstop rather than of a lucky month boundary.
  const { rows } = await pool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM billing.ledger_entries_default WHERE source_id = 'pay-A5'");
  assert.equal(rows[0]!.n, '2', 'the late payment belongs in the DEFAULT partition');
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

test('A8: allocate() gives the leftover to the largest remainder', async () => {
  const out = allocate(Money.fromMinor(10n, 'USD'), [1n, 1n, 97n]);
  console.log('  allocate 10 over weights [1,1,97] ->', out.map((m) => m.minor.toString()));
  // largest remainder: floors are 0,0,9; remainders .1,.1,9.7 -> the leftover
  // penny belongs to the largest remainder (the 97 share).
  assert.deepEqual(out.map((m) => m.minor), [0n, 0n, 10n]);
});
