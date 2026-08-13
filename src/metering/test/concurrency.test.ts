// The property that matters most: a minute of elapsed time is charged exactly
// once, under concurrent workers.
//
//   node --test src/metering/test/
//
// Requires a reachable Postgres and `psql` on PATH. See harness.ts.
//
// "Exactly once" is asserted positively rather than as the absence of
// duplicates, because absence is what a test that is not actually concurrent
// also reports. For every item, the charge windows must TILE the interval from
// where it started to where its grid now sits: contiguous, no gap, no overlap,
// and the sum of billed minutes equal to the elapsed span. A double bill makes
// the sum exceed the span. A lost bill makes it fall short. One equality
// catches both, and neither can hide behind the other.
//
// The negative control at the bottom is the reason to believe any of it. It
// runs the same load through a deliberately unsafe engine — no row lock, no
// compare-and-set — and asserts that this harness DOES observe double billing
// there. Without it, a green result is equally consistent with a correct engine
// and with a harness that never produced two overlapping transactions.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createHarness } from './harness.ts';
import { createPsqlExecutor, type PsqlExecutor } from './psql-executor.ts';
import { meterBatch } from '../driver.ts';

const h = createHarness('concurrency');
const { createDatabase, psql, reset, scalar, seed } = h;
const TEST_DB = h.database;

const WORKERS = 8;
/**
 * Fewer items than WORKERS * BATCH, deliberately.
 *
 * With enough items to go round, SKIP LOCKED hands every worker a disjoint set
 * and they barely interact. Starving them is what forces workers onto the same
 * rows at the same time, which is where the EvalPlanQual race the compare-and-
 * set exists to close actually lives.
 */
const ITEMS = 24;
/** Fewer subjects than items, so workers' ACCOUNT sets overlap. See seed(). */
const SUBJECTS = 4;
const MINUTES_STALE = 61;
/** Below MINUTES_STALE, so every item needs several batches and the race window opens repeatedly. */
const MAX_MINUTES = 6;
const BATCH = 6;

const num = async (sql: string): Promise<number> => Number(await scalar(sql));

/**
 * Run batches until this worker sees an empty one.
 *
 * `drain` is deliberately NOT used here. Its lease is an operational guard that
 * stops overlapping drains stacking during an incident, and it would serialise
 * these workers — testing the engine's concurrency through the thing whose job
 * is to prevent concurrency. The lease gets its own test below.
 */
const workUntilDrained = async (db: PsqlExecutor): Promise<{ batches: number; items: number }> => {
  let batches = 0;
  let items = 0;
  for (let i = 0; i < 400; i += 1) {
    const result = await meterBatch(db, { batch: BATCH, maxMinutes: MAX_MINUTES });
    batches += 1;
    items += result.itemsBilled;
    if (result.itemsBilled === 0) break;
  }
  return { batches, items };
};

describe('metering under concurrency', () => {
  before(async () => {
    await createDatabase();
  });

  it('charges every elapsed minute exactly once across concurrent workers', async () => {
    await reset();
    await seed({
      items: ITEMS,
      subjects: SUBJECTS,
      minutesStale: MINUTES_STALE,
      ratePerMinute: '1.0',
      // Generously funded: this test is about double billing, and a balance
      // guard suspending items midway would stop billing for a legitimate
      // reason and muddy the contiguity assertion with a second cause.
      fundMinor: '100000000',
    });

    const startGrid = await scalar(
      `SELECT count(DISTINCT last_billed_at)::text FROM billing.billable_items`,
    );
    assert.equal(startGrid, '1', 'seed should put every item on the same grid point');

    const executors: PsqlExecutor[] = Array.from({ length: WORKERS }, () => createPsqlExecutor(TEST_DB));
    let reports: Array<{ batches: number; items: number }>;
    try {
      reports = await Promise.all(executors.map((db) => workUntilDrained(db)));
    } finally {
      await Promise.all(executors.map((db) => db.close()));
    }

    // Concurrency actually happened. Without this the assertions below could
    // all pass on a run where one worker did everything and the other seven
    // found an empty queue.
    const busy = reports.filter((r) => r.items > 0).length;
    assert.ok(busy >= 2, `expected at least 2 workers to bill something, got ${busy}`);

    // --- the property -------------------------------------------------------

    const gapsOrOverlaps = await num(`
      WITH w AS (
        SELECT item_id, window_start, window_end,
               lag(window_end) OVER (PARTITION BY item_id ORDER BY window_start) AS prev_end
          FROM billing.charges)
      SELECT count(*)::text FROM w WHERE prev_end IS NOT NULL AND prev_end <> window_start`);
    assert.equal(gapsOrOverlaps, 0, 'charge windows must tile each item with no gap and no overlap');

    const duplicates = await num(`
      SELECT count(*)::text FROM (
        SELECT item_id, window_start FROM billing.charges
         GROUP BY 1, 2 HAVING count(*) > 1) d`);
    assert.equal(duplicates, 0, 'no (item, window) may be charged twice');

    // Minutes billed equals minutes elapsed, per item. This is the whole claim:
    // too many means a minute was billed twice, too few means one was lost.
    const mismatched = await num(`
      SELECT count(*)::text
        FROM billing.billable_items r
        JOIN (SELECT item_id, min(window_start) AS lo, max(window_end) AS hi, sum(quantity) AS mins
                FROM billing.charges GROUP BY item_id) c ON c.item_id = r.id
       WHERE c.hi <> r.last_billed_at
          OR c.mins <> (extract(epoch FROM (c.hi - c.lo)) / 60)`);
    assert.equal(mismatched, 0, 'billed minutes must equal elapsed minutes, and the grid must sit at the last window end');

    const itemsCharged = await num(`SELECT count(DISTINCT item_id)::text FROM billing.charges`);
    assert.equal(itemsCharged, ITEMS, 'every seeded item must have been billed');

    // Each item was 61 minutes stale and the cap is 6, so no item can have
    // settled it all in one charge. If it did, the cap is not being applied and
    // the concurrency window this test depends on never opened.
    const maxChargeMinutes = await num(`SELECT max(quantity)::text FROM billing.charges`);
    assert.ok(
      maxChargeMinutes <= MAX_MINUTES,
      `no charge may exceed the cap of ${MAX_MINUTES} minutes, saw ${maxChargeMinutes}`,
    );
    const minCharges = await num(`
      SELECT min(n)::text FROM (SELECT count(*) AS n FROM billing.charges GROUP BY item_id) c`);
    assert.ok(minCharges >= 2, 'every item should have needed several capped batches');

    // --- the ledger ---------------------------------------------------------

    const ledgerResidual = await scalar(`SELECT coalesce(sum(amount_minor), 0)::text FROM billing.ledger_entries`);
    assert.equal(ledgerResidual, '0', 'every posting must sum to zero');

    const legsPerCharge = await num(`
      SELECT count(*)::text FROM (
        SELECT source_id FROM billing.ledger_entries WHERE source_kind = 'charge'
         GROUP BY source_id HAVING count(*) <> 2) x`);
    assert.equal(legsPerCharge, 0, 'each charge posts exactly two legs');

    // The cached balance must equal the entries that moved it. This is the
    // check that would catch a lost update from the concurrent balance UPDATE.
    const balanceDrift = await num(`
      SELECT count(*)::text
        FROM billing.ledger_accounts a
        LEFT JOIN (SELECT account_id, sum(amount_minor) AS total
                     FROM billing.ledger_entries GROUP BY account_id) e ON e.account_id = a.id
       WHERE a.kind = 'revenue_accrued'
         AND a.balance_minor <> coalesce(e.total, 0)`);
    assert.equal(balanceDrift, 0, 'cached account balance must equal the sum of its entries');

    // Revenue accrued must equal minutes billed, since the rate is exactly 1.0
    // minor units per minute and the rounding of a whole number is itself.
    const revenue = await scalar(
      `SELECT coalesce(sum(balance_minor), 0)::text FROM billing.ledger_accounts WHERE kind = 'revenue_accrued'`,
    );
    const minutes = await scalar(`SELECT coalesce(sum(quantity), 0)::bigint::text FROM billing.charges`);
    assert.equal(revenue, minutes, 'accrued revenue must equal billed minutes at a rate of 1');

    const suspended = await num(`SELECT count(*)::text FROM billing.billable_items WHERE status <> 'active'`);
    assert.equal(suspended, 0, 'nothing should have suspended; every subject was funded');
  });

  // -------------------------------------------------------------------------

  it('negative control: the same harness DOES catch a double bill', async () => {
    await reset();

    // A deliberately unsafe engine, shaped like the reference implementation
    // with the two protections removed: no FOR UPDATE SKIP LOCKED on the due
    // scan, and no compare-and-set on the grid advance. The pg_sleep widens the
    // read-modify-write window so the race is reached reliably rather than
    // occasionally — the point is to prove the assertions fire, not to measure
    // how likely the bug is.
    //
    // It writes to its own table, which has no unique index, because the whole
    // purpose is to OBSERVE the duplicates. Against billing.charges the unique
    // index would abort the transaction, which is the shipped behaviour and is
    // correct, but it would prove the index works rather than that this test
    // can see a double bill.
    await psql(
      `CREATE SCHEMA IF NOT EXISTS billing_test;
       CREATE TABLE IF NOT EXISTS billing_test.charges_unsafe (
         item_id uuid NOT NULL, window_start timestamptz NOT NULL,
         window_end timestamptz NOT NULL, minutes bigint NOT NULL);
       TRUNCATE billing_test.charges_unsafe;

       CREATE OR REPLACE FUNCTION billing_test.meter_batch_unsafe(p_batch integer, p_max_minutes integer)
       RETURNS integer LANGUAGE plpgsql AS $fn$
       DECLARE r record; v_n integer := 0; v_end timestamptz;
       BEGIN
         FOR r IN
           SELECT id, last_billed_at,
                  least(floor((extract(epoch FROM now()) - extract(epoch FROM last_billed_at)) / 60),
                        p_max_minutes)::integer AS minutes
             FROM billing.billable_items
            WHERE status = 'active' AND last_billed_at <= now() - interval '1 minute'
            ORDER BY last_billed_at
            LIMIT p_batch
         LOOP
           PERFORM pg_sleep(0.005);
           v_end := r.last_billed_at + make_interval(mins => r.minutes);
           INSERT INTO billing_test.charges_unsafe VALUES (r.id, r.last_billed_at, v_end, r.minutes);
           UPDATE billing.billable_items SET last_billed_at = v_end WHERE id = r.id;
           v_n := v_n + 1;
         END LOOP;
         RETURN v_n;
       END;
       $fn$;`,
    );

    await seed({ items: 12, subjects: 3, minutesStale: 25, ratePerMinute: '1.0', fundMinor: '100000000' });

    const executors: PsqlExecutor[] = Array.from({ length: 4 }, () => createPsqlExecutor(TEST_DB));
    try {
      await Promise.all(
        executors.map(async (db) => {
          for (let i = 0; i < 200; i += 1) {
            // One item per call, and that is not a detail.
            //
            // With a multi-row batch this control deadlocks instead of double
            // billing: two workers update overlapping item sets in orders that
            // diverge as the grid moves, and Postgres kills one of them. That
            // is a real observation about the unsafe shape and it is why the
            // shipped engine locks accounts in id order — but a deadlock is not
            // the failure this control is here to demonstrate. One row per
            // transaction means at most one lock is held, so the deadlock is
            // impossible and the read-modify-write race is all that is left.
            const rows = await db.query<{ n: unknown }>(
              'SELECT billing_test.meter_batch_unsafe($1, $2) AS n',
              [1, 5],
            );
            if (Number(rows[0]?.n ?? 0) === 0) break;
          }
        }),
      );
    } finally {
      await Promise.all(executors.map((db) => db.close()));
    }

    const overlaps = await num(`
      SELECT count(*)::text
        FROM billing_test.charges_unsafe a
        JOIN billing_test.charges_unsafe b
          ON a.item_id = b.item_id AND a.ctid < b.ctid
         AND a.window_start < b.window_end AND b.window_start < a.window_end`);

    assert.ok(
      overlaps > 0,
      'the unsafe engine must double-bill under this harness; if it does not, the harness is not ' +
        'producing real contention and the passing test above proves nothing',
    );
  });

  after(async () => {
    // Left in place on purpose. A failed run is worth inspecting, and the next
    // run drops and recreates the database anyway.
  });
});
