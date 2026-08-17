// Test database setup. Real Postgres, no mocks.
//
// A metering engine's correctness is entirely a property of what Postgres does
// with concurrent transactions — SKIP LOCKED, EvalPlanQual re-checks, unique
// index enforcement, lock ordering. None of that has a mock, and a mock of it
// would be a mock of the assumptions being tested.
//
// One database PER TEST FILE, which is why this is a factory rather than a
// module of functions over a shared name. `node --test` runs files in parallel
// by default, and a shared database means one file's createDatabase() drops the
// tables another file is mid-way through asserting on. The symptom is a failure
// in whichever file lost the race, which is never the file with the bug.
//
// The databases are dropped and recreated on every run, so they must not be
// ones you care about. Override the prefix with BILLING_KIT_TEST_DB.

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { REQUIRE_DB, SKIP_REASON } from './pg-env.ts';

export { REQUIRE_DB, SKIP_REASON } from './pg-env.ts';

const exec = promisify(execFile);

const PREFIX = process.env.BILLING_KIT_TEST_DB ?? 'billing_kit_test';

const SQL_DIR = join(import.meta.dirname, '..', '..', '..', 'sql');

/**
 * In apply order.
 *
 * 001_core is here because the metering engine posts into ITS
 * `billing.ledger_entries` — that table used to be declared a second time by
 * 010_metering.sql in an incompatible shape, and 001_core's won. 010 refuses to
 * apply without it. 011 must precede any charge; see its header.
 */
const SCHEMA_FILES = ['001_core.sql', '010_metering.sql', '011_partitions.sql', '012_meter_batch.sql', '013_runs.sql'];

export interface SeedOptions {
  items: number;
  minutesStale: number;
  ratePerMinute: string;
  currency?: string;
  tenant?: string;
  /** Minor units credited to each subject before metering starts. */
  fundMinor?: string;
  /** One subject per item by default; set to group items under fewer subjects. */
  subjects?: number;
}

export interface Harness {
  database: string;
  /**
   * Probe the server. False means the DB-backed suite should skip (with
   * SKIP_REASON); under REQUIRE_DB an unreachable server throws instead, so CI
   * cannot go green having run none of this.
   */
  available(): Promise<boolean>;
  /** Drop, recreate, apply sql/010..013, and create partitions. */
  createDatabase(): Promise<void>;
  /** Empty the data, keep the schema. */
  reset(): Promise<void>;
  seed(options: SeedOptions): Promise<void>;
  /**
   * Credit every subject that has a billable item, through the ledger.
   *
   * There is no other way to do it any more, and that is the point: the old
   * `UPDATE billing.ledger_accounts SET balance_minor = …` wrote to a cache
   * that no longer exists, so a test could put a subject in funding states the
   * entries never justified. Funding now posts the same two legs a payment
   * posts, and the guard reads the same sum production reads.
   */
  fund(minorUnits: string): Promise<void>;
  /** Run SQL and return raw text. Callers parse; nothing here guesses a type. */
  psql(sql: string): Promise<string>;
  /** One scalar, as text. */
  scalar(sql: string): Promise<string>;
  /** Same, as a number, for count(*)-shaped assertions. */
  count(sql: string): Promise<number>;
}

/**
 * One `opening_balance` posting per subject, funding them by `minor` units.
 *
 * Signed the way sql/001_core.sql signs a ledger: positive is a debit, and
 * `customer_balance` is a RECEIVABLE, so money the customer has put in makes it
 * negative and the charges push it back up. `paymentPosting()` in
 * src/ledger.ts posts exactly these two legs.
 */
const FUND_SQL = (minor: string): string => `
  WITH s AS (
    SELECT DISTINCT tenant_id, subject_id, currency FROM billing.billable_items
  ),
  tx AS (
    INSERT INTO billing.ledger_transactions (id, tenant_id, source_kind, source_id, posted_at)
    SELECT gen_random_uuid(), s.tenant_id, 'opening_balance', s.subject_id, now() FROM s
    RETURNING id, tenant_id, source_id
  )
  INSERT INTO billing.ledger_entries
    (id, transaction_id, tenant_id, subject_id, account, currency,
     amount_minor, leg_no, source_kind, source_id, posted_at)
  SELECT gen_random_uuid(), tx.id, tx.tenant_id, tx.source_id, l.account, s.currency,
         l.amount_minor, l.leg_no, 'opening_balance', tx.source_id, now()
    FROM tx
    JOIN s ON s.tenant_id = tx.tenant_id AND s.subject_id = tx.source_id
    CROSS JOIN LATERAL (VALUES
      ('cash',             ${minor}::bigint, 0::smallint),
      ('customer_balance', -${minor}::bigint, 1::smallint)
    ) AS l(account, amount_minor, leg_no)`;

export const createHarness = (name: string): Harness => {
  const database = `${PREFIX}_${name}`;

  const psql = async (sql: string): Promise<string> => {
    const { stdout } = await exec('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', database, '-c', sql]);
    return stdout.trim();
  };

  return {
    database,

    available: async (): Promise<boolean> => {
      try {
        await exec('psql', ['-X', '-q', '-A', '-t', '-d', 'postgres', '-c', 'SELECT 1']);
        return true;
      } catch (error) {
        if (REQUIRE_DB) {
          throw new Error(`REQUIRE_DB is set and the test database is unreachable: ${SKIP_REASON}`, { cause: error });
        }
        return false;
      }
    },

    createDatabase: async (): Promise<void> => {
      await exec('psql', ['-X', '-q', '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${database}`]);
      await exec('psql', ['-X', '-q', '-d', 'postgres', '-c', `CREATE DATABASE ${database}`]);
      for (const file of SCHEMA_FILES) {
        await exec('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', database, '-f', join(SQL_DIR, file)]);
      }
      // Two calls because two files own partitions: 001_core's covers
      // usage_events and ledger_entries, 011's covers charges and keeps
      // ledger_entries ahead. Both delegate to the same
      // billing.ensure_month_partition(), so calling both is idempotent.
      await psql('SELECT billing.ensure_core_partitions(3)');
      await psql('SELECT billing.ensure_partitions(3, 2)');
    },

    reset: async (): Promise<void> => {
      // TRUNCATE and not DELETE: ledger_entries is append-only and every
      // partition carries a trigger that says so, and these are partitioned
      // tables anyway. The point is to start each test from a state where the
      // only rows are its own.
      await psql(
        `TRUNCATE billing.charges, billing.ledger_entries, billing.ledger_transactions,
                  billing.billable_items, billing.meter_runs CASCADE`,
      );
    },

    /**
     * Create billable items already `minutesStale` minutes behind the grid, and
     * fund them.
     *
     * `subjects` matters for the concurrency test specifically: when several
     * items share a subject they share a balance, so two workers billing
     * different items read and move the same account. One subject per item
     * would test nothing about that.
     */
    seed: async (options: SeedOptions): Promise<void> => {
      const tenant = options.tenant ?? 't-test';
      const currency = options.currency ?? 'USD';
      const subjects = options.subjects ?? options.items;

      await psql(
        `INSERT INTO billing.billable_items
           (tenant_id, subject_id, rate_per_minute, currency, last_billed_at)
         SELECT '${tenant}',
                'subject-' || (i % ${subjects}),
                ${options.ratePerMinute}::numeric,
                '${currency}',
                now() - interval '${options.minutesStale} minutes'
           FROM generate_series(0, ${options.items - 1}) AS i`,
      );

      if (options.fundMinor !== undefined) {
        await psql(FUND_SQL(options.fundMinor));
      }
    },

    fund: async (minorUnits: string): Promise<void> => {
      await psql(FUND_SQL(minorUnits));
    },

    psql,
    scalar: psql,
    count: async (sql: string): Promise<number> => Number(await psql(sql)),
  };
};
