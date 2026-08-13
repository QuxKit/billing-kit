// A pg.Pool adapter for SqlExecutor, and the test harness that uses it.
//
// This file doubles as the proof of a design claim: §7.1 rule 3 says a bare
// `pg.Pool` satisfies the executor in about ten lines and that Prisma is not a
// runtime requirement. `fromPool` below is those lines. If it ever stops being
// short, the interface has grown something it should not have.
//
// `pg` is a devDependency. billing-kit itself has no runtime dependencies.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import type { SqlExecutor } from '../src/types';

export function fromPool(pool: pg.Pool): SqlExecutor {
  return {
    async query<T>(text: string, params?: readonly unknown[]): Promise<T[]> {
      const result = await pool.query(text, params as unknown[]);
      return result.rows as T[];
    },
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      // The body must run on one connection. Handing back the pool would let
      // each statement land on a different connection, and the ROLLBACK would
      // then cover none of them.
      const client = await pool.connect();
      const bound: SqlExecutor = {
        async query<R>(text: string, params?: readonly unknown[]): Promise<R[]> {
          const result = await client.query(text, params as unknown[]);
          return result.rows as R[];
        },
        transaction: (inner) => inner(bound),
      };
      try {
        await client.query('BEGIN');
        const out = await fn(bound);
        await client.query('COMMIT');
        return out;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export const TEST_DATABASE_URL =
  process.env.BILLING_KIT_TEST_DATABASE_URL ?? 'postgres://localhost:5432/billing_kit_test';

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
  } catch {
    await pool.end().catch(() => {});
    return null;
  }

  const ddlPath = fileURLToPath(new URL('../sql/001_core.sql', import.meta.url));
  const ddl = await readFile(ddlPath, 'utf8');

  await pool.query('DROP SCHEMA IF EXISTS billing CASCADE');
  await pool.query(ddl);
  await pool.query('SELECT billing.ensure_core_partitions(2, $1)', [new Date()]);

  return {
    db: fromPool(pool),
    pool,
    close: () => pool.end(),
  };
}

export const SKIP_REASON =
  `no database at ${TEST_DATABASE_URL} — set BILLING_KIT_TEST_DATABASE_URL or ` +
  'run `createdb billing_kit_test` to exercise the SQL paths';
