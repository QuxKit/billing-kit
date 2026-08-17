// The driver: bounds, the lease, and the run record.
//
//   node --test src/metering/test/
//
// The engine's correctness is in concurrency.test.ts. What is tested here is
// everything around it — that a run is bounded, that two drains do not overlap,
// and above all that a FAILED run leaves a record. That last one is the fix for
// the defect in the reference implementation, and it is only testable by making
// a batch actually fail.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { drain, ensurePartitions, health, partitionReport } from '../driver.ts';
import { createHarness } from './harness.ts';
import { createPsqlExecutor, type PsqlExecutor } from './psql-executor.ts';

const h = createHarness('driver');
const { createDatabase, psql, reset, scalar, seed } = h;
const TEST_DB = h.database;

const withDb = async <T>(fn: (db: PsqlExecutor) => Promise<T>): Promise<T> => {
  const db = createPsqlExecutor(TEST_DB);
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
};

describe('metering driver', () => {
  before(async () => {
    await createDatabase();
  });

  it('drains the queue and records the run', async () => {
    await reset();
    await seed({ items: 10, subjects: 3, minutesStale: 12, ratePerMinute: '2.5', fundMinor: '1000000' });

    const report = await withDb((db) => drain({ db, batch: 4, maxMinutes: 1440, runner: 'test-a' }));

    assert.equal(report.status, 'drained');
    assert.equal(report.itemsBilled, 10);
    // One pass per item: 12 whole minutes settled in a single charge, which is
    // the elapsed-minute fix. The reference implementation would have needed
    // twelve runs per item to reach the same place.
    assert.equal(report.minutesBilled, 120n);
    // 12 min * 2.5 = 30 minor units each, exactly, so no rounding is involved
    // and the total is checkable by hand.
    assert.deepEqual(report.amountByCurrency, { USD: 300n });
    assert.equal(report.itemsSuspended, 0);
    assert.ok(report.runId !== null);

    const charges = await scalar('SELECT count(*)::text FROM billing.charges');
    assert.equal(charges, '10', 'one charge per item, not one per minute');

    const run = await scalar(
      `SELECT status || ' ' || items_billed || ' ' || minutes_billed || ' ' || (amount_by_currency->>'USD')
         FROM billing.meter_runs WHERE runner = 'test-a'`,
    );
    assert.equal(run, 'drained 10 120 300');
  });

  it('records a FAILED run outside the transaction that failed', async () => {
    // This is the §5.2(e) regression test.
    //
    // The reference implementation inserted its failure row inside a PL/pgSQL
    // EXCEPTION handler and then RAISEd; the RAISE aborted the transaction and
    // rolled the insert back with it, so a failed run left no trace at all. If
    // the run record were written from inside meter_batch, this test would find
    // no row.
    await reset();
    await seed({ items: 1, subjects: 1, minutesStale: 5, ratePerMinute: '1.0' });

    // Break an invariant the engine asserts on.
    //
    // This used to delete the item's `revenue_accrued` row from
    // billing.ledger_accounts, so meter_batch's inner join dropped a leg and it
    // raised "a ledger account is missing". That table is gone: 001_core's
    // ledger names accounts inline on the entry, so there is no row to delete
    // and no join to break — the failure mode itself no longer exists, which is
    // why the expectation changed rather than the assertion being relaxed.
    //
    // What is used instead is the invariant the file is loudest about: plant a
    // charge on exactly the (item_id, window_start) the next batch will compute,
    // so `charges_item_window` rejects it. 012_meter_batch.sql refuses to pair
    // that index with ON CONFLICT DO NOTHING precisely so this aborts.
    //
    // Matched on `item_id_window_start` rather than on `charges_item_window`:
    // the violation is reported against the LEAF index, which Postgres names
    // after the partition (charges_2026m08_item_id_window_start_idx), so the
    // partition name is in the string and the parent's is not.
    await psql(
      `INSERT INTO billing.charges
         (tenant_id, subject_id, item_id, metric, window_start, window_end,
          quantity, rate, amount_minor, amount_exact, currency)
       SELECT tenant_id, subject_id, id, metric, last_billed_at,
              last_billed_at + interval '1 minute', 1, rate_per_minute, 1, 1, currency
         FROM billing.billable_items`,
    );

    await assert.rejects(
      () => withDb((db) => drain({ db, batch: 10, runner: 'test-fail' })),
      /item_id_window_start/,
      'a broken invariant must reach the caller, not be swallowed',
    );

    const row = await scalar(
      `SELECT status || '|' || coalesce(error, '') FROM billing.meter_runs WHERE runner = 'test-fail'`,
    );
    assert.match(row, /^failed\|/, 'the failed run must have left a record');
    assert.match(row, /item_id_window_start/, 'and the record must say why');

    // The transaction that failed rolled back completely: the planted charge is
    // all that is there, no grid movement, no half-written ledger.
    assert.equal(await scalar('SELECT count(*)::text FROM billing.charges'), '1');
    assert.equal(await scalar('SELECT count(*)::text FROM billing.ledger_entries'), '0');
    assert.equal(
      await scalar(
        `SELECT (last_billed_at = (SELECT window_start FROM billing.charges))::text
           FROM billing.billable_items`,
      ),
      'true',
      'the grid must not have advanced',
    );
  });

  it('holds a lease, so a second drain skips instead of overlapping', async () => {
    await reset();
    await seed({ items: 4, subjects: 2, minutesStale: 3, ratePerMinute: '1.0', fundMinor: '1000000' });

    const first = createPsqlExecutor(TEST_DB);
    const second = createPsqlExecutor(TEST_DB);
    try {
      // Claim the lease and hold it by leaving the run unsettled, which is
      // exactly the state a still-running drain is in.
      const runId = await scalar(`SELECT billing.claim_meter_run('holder', interval '5 minutes')::text`);
      assert.notEqual(runId, '', 'the first claim must succeed');

      const report = await drain({ db: second, batch: 4, runner: 'test-second' });
      assert.equal(report.status, 'skipped');
      assert.equal(report.runId, null);
      assert.equal(report.itemsBilled, 0);

      // Nothing was billed by the skipped run.
      assert.equal(await scalar('SELECT count(*)::text FROM billing.charges'), '0');
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('reclaims a lease whose holder stopped heartbeating', async () => {
    await reset();
    await seed({ items: 2, subjects: 1, minutesStale: 3, ratePerMinute: '1.0', fundMinor: '1000000' });

    await psql(
      `INSERT INTO billing.meter_runs (runner, status, started_at, heartbeat_at)
       VALUES ('dead-worker', 'running', now() - interval '1 hour', now() - interval '1 hour')`,
    );

    const report = await withDb((db) => drain({ db, batch: 4, runner: 'test-reclaim' }));
    assert.equal(report.status, 'drained', 'a dead holder must not block the queue forever');
    assert.equal(report.itemsBilled, 2);

    // The dead row is left as 'running' rather than rewritten as failed: this
    // path observed a silence, not a failure, and health() is what reports it.
    const stuck = await scalar(`SELECT status FROM billing.meter_runs WHERE runner = 'dead-worker'`);
    assert.equal(stuck, 'running');

    const report2 = await withDb((db) => health(db));
    assert.equal(report2.ok, false);
    assert.ok(
      report2.faults.some((f) => f.fault === 'runs_stuck'),
      `health should report the stuck run, got ${JSON.stringify(report2.faults)}`,
    );
  });

  it('reports `bounded` when it hits a bound with work outstanding', async () => {
    await reset();
    await seed({ items: 12, subjects: 3, minutesStale: 5, ratePerMinute: '1.0', fundMinor: '1000000' });

    const report = await withDb((db) => drain({ db, batch: 3, maxIterations: 2, runner: 'test-bounded' }));

    assert.equal(report.status, 'bounded');
    assert.equal(report.iterations, 2);
    assert.equal(report.itemsBilled, 6, 'exactly two batches of three, and no more');

    // Progress is durable per batch, so the next run resumes rather than
    // restarts. That is what makes hitting a bound a pause and not a rollback.
    const rest = await withDb((db) => drain({ db, batch: 3, runner: 'test-bounded-2' }));
    assert.equal(rest.status, 'drained');
    assert.equal(rest.itemsBilled, 6);
    assert.equal(await scalar('SELECT count(*)::text FROM billing.charges'), '12');
  });

  it('refuses a lease that cannot outlive its own drain', async () => {
    await assert.rejects(
      () => withDb((db) => drain({ db, deadlineMs: 60_000, leaseMs: 30_000 })),
      /must exceed deadlineMs/,
    );
  });

  it('suspends an item whose balance goes negative, after billing the time it owed', async () => {
    await reset();
    await seed({ items: 1, subjects: 1, minutesStale: 10, ratePerMinute: '100.0', fundMinor: '250' });

    const report = await withDb((db) => drain({ db, batch: 10, runner: 'test-guard' }));

    assert.equal(report.itemsBilled, 1);
    assert.equal(report.itemsSuspended, 1);

    // The trade, asserted rather than described: the customer consumed ten
    // minutes and is charged for ten minutes, so 250 funded against 1,000
    // charged leaves 750 owed. The overdraft is bounded by one interval and
    // then the item stops.
    //
    // `750` and not `-750`, from the entries and not from a cached column. The
    // old expectation read billing.ledger_accounts.balance_minor, which treated
    // customer_balance as a prepaid wallet seen from the subject. Under
    // sql/001_core.sql — the shape src/types.ts publishes — customer_balance is
    // a receivable seen from us: a charge adds to it and a payment subtracts.
    // Same money, opposite sign, and the old expectation was reading a number
    // maintained by meter_batch alone that any payment through src/ledger.ts
    // would have left stale.
    assert.equal(await scalar('SELECT sum(amount_minor)::text FROM billing.charges'), '1000');
    assert.equal(
      await scalar(
        `SELECT coalesce(sum(amount_minor), 0)::text FROM billing.ledger_entries
          WHERE account = 'customer_balance'`,
      ),
      '750',
    );
    assert.equal(await scalar(`SELECT status FROM billing.billable_items`), 'suspended');

    const again = await withDb((db) => drain({ db, batch: 10, runner: 'test-guard-2' }));
    assert.equal(again.itemsBilled, 0, 'a suspended item must not keep billing');
  });

  it('creates partitions idempotently and reports them', async () => {
    const created = await withDb((db) => ensurePartitions(db, { monthsAhead: 3, monthsBehind: 1 }));
    assert.equal(created, 0, 'createDatabase already made these; a second call must be a no-op');

    const rows = await withDb((db) => partitionReport(db));
    const charges = rows.filter((r) => r.parent === 'charges');
    assert.ok(charges.length >= 5, `expected several charge partitions, got ${charges.length}`);
    assert.ok(
      charges.some((r) => r.isDefault),
      'a DEFAULT partition must exist as the catch-up backstop',
    );

    // The §6.2 check: the table must actually be partitioned, not the plain
    // table `prisma db push` leaves behind.
    const relkind = await scalar(
      `SELECT c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'billing' AND c.relname = 'charges'`,
    );
    assert.equal(relkind, 'p', 'billing.charges must be a partitioned table');
  });

  it('reports a non-empty default partition as a fault', async () => {
    await reset();
    // A charge far outside every declared range lands in the default. That is
    // the backstop working; it is also a fault, because the next partition
    // creation now has to scan it under an exclusive lock.
    await seed({ items: 1, subjects: 1, minutesStale: 5, ratePerMinute: '1.0', fundMinor: '100000' });
    await psql(`UPDATE billing.billable_items SET last_billed_at = now() - interval '5 years'`);
    // One iteration only. A 5-year-old item has ~2.6 million minutes to settle
    // and would otherwise chunk its way forward for the whole deadline; one
    // batch is all this test needs and it keeps the assertion exact.
    await withDb((db) => drain({ db, batch: 4, maxIterations: 1, runner: 'test-default-partition' }));

    const inDefault = await scalar('SELECT count(*)::text FROM billing.charges_default');
    assert.equal(inDefault, '1', 'the out-of-range charge must be stored, not rejected');
    assert.equal(
      await scalar('SELECT count(*)::text FROM billing.charges'),
      '1',
      'and it must be reachable through the parent, not orphaned in the partition',
    );

    const status = await withDb((db) => health(db));
    assert.equal(status.ok, false);
    assert.ok(
      status.faults.some((f) => f.fault === 'default_partition_not_empty'),
      `expected a default-partition fault, got ${JSON.stringify(status.faults)}`,
    );
  });
});
