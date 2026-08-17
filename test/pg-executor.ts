// The Postgres test harness.
//
// The executor itself is the shipped adapter, `pgExecutor` from `src/pg.ts`
// (published as `@quxkit/billing-kit/pg`); `fromPool` is kept as an alias so
// older test code and the README's earlier wording still resolve. What this file
// adds is the schema rebuild and the skip/require decision.
//
// `pg` is a devDependency here and an optional peer for consumers.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { pgExecutor } from '../src/pg';
import type { SqlExecutor } from '../src/types';

export const fromPool = pgExecutor;

export const TEST_DATABASE_URL =
  process.env.BILLING_KIT_TEST_DATABASE_URL ?? 'postgres://localhost:5432/billing_kit_test';

export const SKIP_REASON =
  `no database at ${TEST_DATABASE_URL} — set BILLING_KIT_TEST_DATABASE_URL or ` +
  'run `createdb billing_kit_test` to exercise the SQL paths';

/**
 * Whether the DB-backed suites may skip when the database is unreachable.
 *
 * Locally, yes: the money tests are useful on a laptop with no Postgres. In CI,
 * no: `REQUIRE_DB=1` turns an unreachable database into a hard failure, so a
 * misconfigured service container cannot produce a green run that exercised
 * none of the SQL.
 */
export const REQUIRE_DB = process.env.REQUIRE_DB !== undefined && process.env.REQUIRE_DB !== '';

/**
 * Called by every harness when the database cannot be reached. Throws under
 * `REQUIRE_DB`; otherwise returns so the caller can skip with `reason`.
 */
export function unreachable(reason: string, cause: unknown): void {
  if (!REQUIRE_DB) return;
  throw new Error(`REQUIRE_DB is set and the test database is unreachable: ${reason}`, { cause });
}

export interface Harness {
  db: SqlExecutor;
  pool: pg.Pool;
  close(): Promise<void>;
}

/**
 * Connect and rebuild the schema from `sql/001_core.sql`.
 *
 * Rebuilt per run rather than migrated, because the point of these tests is
 * that the shipped DDL produces the shipped behaviour. A schema that drifted
 * from the file would let the tests pass against something no adopter has.
 *
 * This drops and recreates the schema, so two test files doing it at once
 * destroy each other's tables mid-run. That is why the test script passes
 * `--test-concurrency=1`; node's test runner gives each file its own process
 * and runs them in parallel by default, and the resulting failures look like
 * flaky assertions rather than the collision they are.
 */
export async function setupDatabase(): Promise<Harness | null> {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });

  try {
    await pool.query('SELECT 1');
  } catch (error) {
    await pool.end().catch(() => {});
    unreachable(SKIP_REASON, error);
    return null;
  }

  const ddlPath = fileURLToPath(new URL('../sql/001_core.sql', import.meta.url));
  const ddl = await readFile(ddlPath, 'utf8');

  await pool.query('DROP SCHEMA IF EXISTS billing CASCADE');
  await pool.query(ddl);
  await pool.query('SELECT billing.ensure_core_partitions(2, $1)', [new Date()]);

  return {
    db: pgExecutor(pool),
    pool,
    close: () => pool.end(),
  };
}
