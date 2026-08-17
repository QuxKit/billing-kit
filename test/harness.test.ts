// The harness itself must import cleanly.
//
// Every DB-backed suite decides whether to run or skip inside a top-level
// `await`, and if the module that makes that decision fails to load, node's
// test runner reports the FILE as failed with no test names attached — which
// reads like an infrastructure hiccup rather than the broken import it is. This
// file has no database dependency of its own; it exists so a harness regression
// has a name.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pgExecutor } from '../src/pg';
import { fromPool, REQUIRE_DB, SKIP_REASON, setupDatabase, TEST_DATABASE_URL, unreachable } from './pg-executor';

describe('test harness', () => {
  it('imports and exposes the expected surface', () => {
    assert.equal(typeof setupDatabase, 'function');
    assert.equal(typeof unreachable, 'function');
    assert.equal(fromPool, pgExecutor, 'the harness must use the shipped adapter, not a private copy');
    assert.equal(typeof TEST_DATABASE_URL, 'string');
    assert.match(SKIP_REASON, /BILLING_KIT_TEST_DATABASE_URL/);
    assert.equal(typeof REQUIRE_DB, 'boolean');
  });

  it('unreachable() is a no-op without REQUIRE_DB and throws with it', () => {
    if (REQUIRE_DB) {
      assert.throws(() => unreachable('probe', new Error('down')), /REQUIRE_DB is set/);
    } else {
      assert.doesNotThrow(() => unreachable('probe', new Error('down')));
    }
  });

  it('pgExecutor wraps a pool-shaped object without touching pg at import', async () => {
    // A minimal pool double: enough to prove the wrapper routes query() to the
    // pool and transaction() to one pinned client with BEGIN/COMMIT around it.
    const log: string[] = [];
    const client = {
      query: async (text: string) => {
        log.push(`client:${text}`);
        return { rows: [{ ok: 1 }] };
      },
      release: () => log.push('release'),
    };
    const pool = {
      query: async (text: string) => {
        log.push(`pool:${text}`);
        return { rows: [{ ok: 2 }] };
      },
      connect: async () => client,
    };
    // biome-ignore lint/suspicious/noExplicitAny: a structural double for pg.Pool
    const db = pgExecutor(pool as any);
    assert.deepEqual(await db.query('SELECT 2'), [{ ok: 2 }]);
    const out = await db.transaction(async (tx) => {
      const rows = await tx.query('SELECT 1');
      // Nested transaction reuses the pinned client rather than checking out another.
      await tx.transaction(async (inner) => inner.query('SELECT 1b'));
      return rows;
    });
    assert.deepEqual(out, [{ ok: 1 }]);
    assert.deepEqual(log, [
      'pool:SELECT 2',
      'client:BEGIN',
      'client:SELECT 1',
      'client:SELECT 1b',
      'client:COMMIT',
      'release',
    ]);
  });

  it('pgExecutor rolls back and rethrows when the callback throws', async () => {
    const log: string[] = [];
    const client = {
      query: async (text: string) => {
        log.push(text);
        return { rows: [] };
      },
      release: () => log.push('release'),
    };
    // biome-ignore lint/suspicious/noExplicitAny: a structural double for pg.Pool
    const db = pgExecutor({ query: async () => ({ rows: [] }), connect: async () => client } as any);
    await assert.rejects(
      db.transaction(async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.deepEqual(log, ['BEGIN', 'ROLLBACK', 'release']);
  });
});
