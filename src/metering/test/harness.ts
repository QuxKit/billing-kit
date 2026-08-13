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
import { promisify } from 'node:util';
import { join } from 'node:path';

const exec = promisify(execFile);

const PREFIX = process.env.BILLING_KIT_TEST_DB ?? 'billing_kit_test';

const SQL_DIR = join(import.meta.dirname, '..', '..', '..', 'sql');

/** In apply order. 002 must precede any charge; see its header. */
const SCHEMA_FILES = ['010_metering.sql', '011_partitions.sql', '012_meter_batch.sql', '013_runs.sql'];

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
  /** Drop, recreate, apply sql/010..013, and create partitions. */
  createDatabase(): Promise<void>;
  /** Empty the data, keep the schema. */
  reset(): Promise<void>;
  seed(options: SeedOptions): Promise<void>;
  /** Run SQL and return raw text. Callers parse; nothing here guesses a type. */
  psql(sql: string): Promise<string>;
  /** One scalar, as text. */
  scalar(sql: string): Promise<string>;
  /** Same, as a number, for count(*)-shaped assertions. */
  count(sql: string): Promise<number>;
}

export const createHarness = (name: string): Harness => {
  const database = `${PREFIX}_${name}`;

  const psql = async (sql: string): Promise<string> => {
    const { stdout } = await exec('psql', [
      '-X',
      '-q',
      '-A',
      '-t',
      '-v',
      'ON_ERROR_STOP=1',
      '-d',
      database,
      '-c',
      sql,
    ]);
    return stdout.trim();
  };

  return {
    database,

    createDatabase: async (): Promise<void> => {
      await exec('psql', ['-X', '-q', '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${database}`]);
      await exec('psql', ['-X', '-q', '-d', 'postgres', '-c', `CREATE DATABASE ${database}`]);
      for (const file of SCHEMA_FILES) {
        await exec('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', database, '-f', join(SQL_DIR, file)]);
      }
      await psql('SELECT billing.ensure_partitions(3, 2)');
    },

    reset: async (): Promise<void> => {
      // TRUNCATE and not DELETE: these are partitioned tables, and the point is
      // to start each test from a state where the only rows are its own.
      await psql(
        `TRUNCATE billing.charges, billing.ledger_entries, billing.ledger_accounts,
                  billing.billable_items, billing.meter_runs CASCADE`,
      );
    },

    /**
     * Create billable items already `minutesStale` minutes behind the grid, and
     * fund them.
     *
     * `subjects` matters for the concurrency test specifically: when several
     * items share a subject they share a ledger account, which is the only way
     * two workers' account sets overlap — and overlapping account sets are the
     * precondition for the deadlock that ordered locking exists to prevent. One
     * subject per item would test nothing about that.
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
        await psql(
          `UPDATE billing.ledger_accounts SET balance_minor = ${options.fundMinor}
            WHERE kind = 'customer_balance'`,
        );
      }
    },

    psql,
    scalar: psql,
    count: async (sql: string): Promise<number> => Number(await psql(sql)),
  };
};
