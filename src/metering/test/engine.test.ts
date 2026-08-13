// Exactness: rounding, sub-minor-unit rates, and the grid.
//
//   node --test src/metering/test/
//
// These are the properties that make the ledger re-derivable. They are cheap to
// test and expensive to discover in production, because every one of them fails
// silently — a float total is not flagged, a half-up rounding is not flagged,
// and a grid that drifts by 40 seconds a run looks fine until someone compares
// an invoice against their own logs.

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createHarness } from './harness.ts';
import { createPsqlExecutor, type PsqlExecutor } from './psql-executor.ts';
import { drain, meterBatch } from '../driver.ts';

const h = createHarness('engine');
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

describe('metering exactness', () => {
  before(async () => {
    await createDatabase();
  });

  it('rounds half to even at the charge, and stores the pre-rounding value', async () => {
    await reset();
    // 3 minutes at 1.5/minute is exactly 4.5 — a tie. Half-to-even gives 4.
    // Postgres round() gives 5, and so does every naive implementation.
    // A rate whose product lands on a tie does so on EVERY interval, so the
    // difference is a systematic drift in one direction, not noise.
    await psql(
      `INSERT INTO billing.billable_items (tenant_id, subject_id, rate_per_minute, currency, last_billed_at)
       VALUES ('t', 'tie-down', 1.5, 'USD', now() - interval '3 minutes'),
              ('t', 'tie-up',   2.5, 'USD', now() - interval '3 minutes');
       UPDATE billing.ledger_accounts SET balance_minor = 100000 WHERE kind = 'customer_balance';`,
    );

    await withDb((db) => meterBatch(db, { batch: 10, maxMinutes: 1440 }));

    // 3 * 1.5 = 4.5 -> 4 (down to even). 3 * 2.5 = 7.5 -> 8 (up to even).
    // Both are ties, and they round in opposite directions. That is the whole
    // point of half-to-even and it is why one example is not a test.
    const rounded = await scalar(
      `SELECT string_agg(subject_id || '=' || amount_exact || '->' || amount_minor, ' ' ORDER BY subject_id)
         FROM billing.charges`,
    );
    assert.equal(rounded, 'tie-down=4.500000000000->4 tie-up=7.500000000000->8');

    // The residue is recoverable, which is what makes the rounding auditable
    // rather than a claim in a comment.
    const residues = await scalar(
      `SELECT string_agg((amount_exact - amount_minor)::text, ' ' ORDER BY subject_id) FROM billing.charges`,
    );
    assert.equal(residues, '0.500000000000 -0.500000000000');
  });

  it('prices a rate far below one minor unit without losing it', async () => {
    await reset();
    // $0.0000012 per token, expressed per minute. Not expressible in integer
    // minor units at all — this is the case ARCHITECTURE.md §3.3 keeps rates
    // as NUMERIC(38,12) for, and the case an integer-rate engine cannot price
    // except by rounding the rate, which is a 100% error here.
    await psql(
      `INSERT INTO billing.billable_items (tenant_id, subject_id, rate_per_minute, currency, last_billed_at)
       VALUES ('t', 'micro', 0.000001200000, 'USD', now() - interval '1000 minutes');
       UPDATE billing.ledger_accounts SET balance_minor = 100000 WHERE kind = 'customer_balance';`,
    );

    await withDb((db) => drain({ db, batch: 10, maxMinutes: 1440, runner: 'micro' }));

    // 1000 * 0.0000012 = 0.0012 exactly. Rounds to zero minor units, and the
    // exact value is kept so the fraction is not lost — it is owed, just not
    // yet payable.
    const row = await scalar(`SELECT quantity || ' ' || amount_exact || ' ' || amount_minor FROM billing.charges`);
    assert.equal(row, '1000.000000000000 0.001200000000 0');

    // Nothing was silently dropped: the rate survived storage exactly.
    const rate = await scalar('SELECT rate::text FROM billing.charges');
    assert.equal(rate, '0.000001200000');
  });

  it('advances the grid on the minute, never to now(), so the remainder is not lost', async () => {
    await reset();
    // Deliberately not a whole number of minutes behind. 5 minutes 40 seconds
    // must settle 5 minutes and carry the 40 seconds, not discard it.
    await psql(
      `INSERT INTO billing.billable_items (tenant_id, subject_id, rate_per_minute, currency, last_billed_at)
       VALUES ('t', 'remainder', 1.0, 'USD', now() - interval '5 minutes 40 seconds');
       UPDATE billing.ledger_accounts SET balance_minor = 100000 WHERE kind = 'customer_balance';`,
    );

    await withDb((db) => meterBatch(db, { batch: 10, maxMinutes: 1440 }));

    assert.equal(await scalar('SELECT quantity::bigint::text FROM billing.charges'), '5');

    // The grid now sits 40 seconds in the past, not at now(). Setting it to
    // now() would throw those 40 seconds away on every single run; at one run a
    // minute that is a 40-second-per-minute loss, which is most of the revenue.
    const remainder = await scalar(
      `SELECT round(extract(epoch FROM (now() - last_billed_at)))::text FROM billing.billable_items`,
    );
    assert.ok(
      Number(remainder) >= 39 && Number(remainder) <= 42,
      `expected roughly 40 seconds of unbilled remainder to be carried, got ${remainder}`,
    );

    // And the charge window ends exactly on the grid, so the next window starts
    // where this one ended.
    const contiguous = await scalar(
      `SELECT (c.window_end = r.last_billed_at)::text
         FROM billing.charges c JOIN billing.billable_items r ON r.id = c.item_id`,
    );
    assert.equal(contiguous, 'true');
  });

  it('settles a long outage in bounded chunks that tile the whole gap', async () => {
    await reset();
    // Three days behind. The reference implementation advanced one minute per
    // run and would have needed 4,320 runs to catch up. This settles it in
    // ceil(4320 / cap) charges, and the charges must still tile the gap exactly.
    await seed({ items: 1, subjects: 1, minutesStale: 4320, ratePerMinute: '1.0', fundMinor: '10000000' });

    const report = await withDb((db) => drain({ db, batch: 10, maxMinutes: 1440, runner: 'catchup' }));

    assert.equal(report.status, 'drained');
    assert.equal(report.minutesBilled, 4320n);
    assert.equal(await scalar('SELECT count(*)::text FROM billing.charges'), '3', 'three capped chunks');

    const gaps = await scalar(`
      WITH w AS (SELECT window_start, window_end,
                        lag(window_end) OVER (ORDER BY window_start) AS prev
                   FROM billing.charges)
      SELECT count(*)::text FROM w WHERE prev IS NOT NULL AND prev <> window_start`);
    assert.equal(gaps, '0', 'the chunks must be contiguous, so no minute is billed twice or missed');

    // No chunk exceeded the cap: the bound is real, not advisory.
    assert.equal(await scalar('SELECT max(quantity)::bigint::text FROM billing.charges'), '1440');
  });

  it('keeps money exact across many charges, where a float total would drift', async () => {
    await reset();
    // 0.1 is the canonical inexact binary fraction. Summed 600 times as a
    // double it is not 60; as NUMERIC and BIGINT it is exact, and — the part
    // that actually matters — the total does not depend on the order the rows
    // were added, so the ledger can be re-derived.
    await psql(
      `INSERT INTO billing.billable_items (tenant_id, subject_id, rate_per_minute, currency, last_billed_at)
       SELECT 't', 'exact-' || i, 0.1, 'USD', now() - interval '10 minutes' FROM generate_series(1, 60) i;
       UPDATE billing.ledger_accounts SET balance_minor = 100000 WHERE kind = 'customer_balance';`,
    );

    await withDb((db) => drain({ db, batch: 20, maxMinutes: 1440, runner: 'exact' }));

    // 60 items * 10 minutes * 0.1 = 60.000000000000, exactly.
    assert.equal(await scalar('SELECT sum(amount_exact)::text FROM billing.charges'), '60.000000000000');
    // Each charge is 10 * 0.1 = 1.0 exactly, so no rounding residue anywhere.
    assert.equal(await scalar('SELECT sum(amount_minor)::text FROM billing.charges'), '60');
    assert.equal(
      await scalar('SELECT count(*)::text FROM billing.charges WHERE amount_exact <> amount_minor'),
      '0',
    );

    const residual = await scalar('SELECT sum(amount_minor)::text FROM billing.ledger_entries');
    assert.equal(residual, '0');
  });

  it('refuses a batch size or cap that would remove the bound', async () => {
    await assert.rejects(
      () => withDb((db) => meterBatch(db, { batch: 0 })),
      /p_batch must be at least 1/,
    );
    await assert.rejects(
      () => withDb((db) => meterBatch(db, { maxMinutes: 0 })),
      /p_max_minutes must be at least 1/,
    );
  });
});
