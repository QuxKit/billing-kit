// The shipped `pg` adapter: a SqlExecutor over a pg.Pool.
//
// billing-kit's runtime dependency on a database is the two-method SqlExecutor
// in ./types.ts, and this file is the proof of the design claim that a bare
// `pg.Pool` satisfies it in about thirty lines. It lives behind its own subpath
// (`@quxkit/billing-kit/pg`) so the root import stays free of `pg`: the driver
// is an OPTIONAL peer dependency, resolved only by consumers who import this.
//
// The type import below is erased at build time, so the module has no runtime
// import of `pg` at all — the pool is handed in, never constructed here.

import type { Pool, PoolClient } from 'pg';
import type { SqlExecutor } from './types.ts';

/** The subset of `pg.Pool` this adapter needs, so a compatible pool works too. */
export type PgPoolLike = Pick<Pool, 'query' | 'connect'>;

/**
 * Wrap a `pg.Pool` as a `SqlExecutor`.
 *
 * `query` goes to the pool. `transaction` checks one client out, pins the whole
 * callback to it, and BEGIN/COMMIT/ROLLBACKs on that client — handing the pool
 * itself to the callback would let each statement land on a different
 * connection, and the ROLLBACK would then cover none of them. A nested
 * `transaction()` inside the callback reuses the pinned client (no savepoint):
 * the outer transaction's outcome is the only one that matters.
 */
export function pgExecutor(pool: PgPoolLike): SqlExecutor {
  return {
    async query<T>(text: string, params?: readonly unknown[]): Promise<T[]> {
      const result = await pool.query(text, params as unknown[]);
      return result.rows as T[];
    },
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      const client: PoolClient = await pool.connect();
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
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
