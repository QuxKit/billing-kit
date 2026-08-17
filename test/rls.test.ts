// Row-level security (sql/090_rls.sql), proven as the role it protects
// against: a NON-superuser, non-BYPASSRLS role that OWNS the tables. Owners
// bypass plain RLS — FORCE is the half of the file that matters — so a test
// run as the table owner is the strongest claim short of superuser, and a
// superuser would prove nothing (they always bypass).
//
// The admin connection (the normal test URL) only creates the role and hands
// it a schema; everything under test — DDL, seeding, the probes — runs on a
// second pool connected AS the owner role. Local trust/peer auth is assumed,
// the same assumption the rest of the harness makes.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { record } from '../src/events';
import { accrualPosting, balance, entries, post } from '../src/ledger';
import { Money, Quantity } from '../src/money';
import { pgExecutor } from '../src/pg';
import type { SqlExecutor } from '../src/types';
import { REQUIRE_DB, SKIP_REASON, TEST_DATABASE_URL } from './pg-executor';

const ROLE = 'billing_kit_rls_owner';
const NOW = new Date('2026-08-17T12:00:00Z');
const usd = (v: string) => Money.fromDecimalString(v, 'USD');

interface Harness {
  owner: pg.Pool;
  db: SqlExecutor;
  close(): Promise<void>;
}

async function setup(): Promise<Harness | null> {
  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
  try {
    await admin.query('SELECT 1');
  } catch (error) {
    await admin.end().catch(() => {});
    if (REQUIRE_DB)
      throw new Error(`REQUIRE_DB is set and the test database is unreachable: ${SKIP_REASON}`, { cause: error });
    return null;
  }

  await admin.query('DROP SCHEMA IF EXISTS billing CASCADE');
  // DROP OWNED first: a leftover role from an aborted run still holds the
  // database GRANT below, and DROP ROLE refuses while anything depends on it.
  await admin.query(`DROP OWNED BY ${ROLE} CASCADE`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${ROLE}`);
  await admin.query(`CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
  const [{ db: dbName }] = (await admin.query<{ db: string }>('SELECT current_database() AS db')).rows.length
    ? (await admin.query<{ db: string }>('SELECT current_database() AS db')).rows
    : [{ db: 'billing_kit_test' }];
  await admin
    .query(`GRANT CREATE ON DATABASE ${JSON.stringify(dbName).replaceAll('"', '"')} TO ${ROLE}`)
    .catch(async () => {
      await admin.query(`GRANT CREATE ON DATABASE billing_kit_test TO ${ROLE}`);
    });
  await admin.end();

  // From here on: the owner role, and only the owner role.
  const url = new URL(TEST_DATABASE_URL);
  url.username = ROLE;
  url.password = '';
  const owner = new pg.Pool({ connectionString: url.toString(), max: 4 });
  try {
    await owner.query('SELECT 1');
  } catch (error) {
    await owner.end().catch(() => {});
    if (REQUIRE_DB)
      throw new Error(`REQUIRE_DB is set and the ${ROLE} role cannot log in (trust auth assumed)`, { cause: error });
    return null;
  }

  const ddl = async (f: string) =>
    owner.query(await readFile(fileURLToPath(new URL(`../sql/${f}`, import.meta.url)), 'utf8'));
  await ddl('001_core.sql');
  await owner.query('SELECT billing.ensure_core_partitions(2, $1)', [NOW]);
  await ddl('020_subscriptions.sql');
  await ddl('030_provider_events.sql');
  await ddl('031_invoices.sql');
  await ddl('032_plan_changes.sql');
  await ddl('090_rls.sql');
  await ddl('090_rls.sql'); // idempotent

  return { owner, db: pgExecutor(owner), close: () => owner.end() };
}

const harness = await setup();
after(async () => {
  await harness?.close();
  // Leave no role behind.
  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  await admin.query('DROP SCHEMA IF EXISTS billing CASCADE').catch(() => {});
  await admin.query(`DROP OWNED BY ${ROLE} CASCADE`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => {});
  await admin.end().catch(() => {});
});

/** Run `fn` inside a transaction that has declared `tenant`. */
async function asTenant<T>(db: SqlExecutor, tenant: string, fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    // SET LOCAL cannot take a bound parameter; quote via literal. Test-only.
    await tx.query(`SET LOCAL tenancy.tenant_id = '${tenant.replaceAll("'", "''")}'`);
    return fn(tx);
  });
}

describe('row-level security', { skip: harness === null ? SKIP_REASON : false }, () => {
  const db = (harness as Harness).db;
  const owner = (harness as Harness).owner;

  it('is running as a non-superuser, non-BYPASSRLS table owner — the strongest honest claim', async () => {
    const [who] = await db.query<{ usename: string; usesuper: boolean; owns: string; bypass: boolean }>(
      `SELECT u.usename, u.usesuper,
              (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass,
              (SELECT tableowner FROM pg_tables WHERE schemaname = 'billing' AND tablename = 'ledger_transactions') AS owns
         FROM pg_user u WHERE u.usename = current_user`,
    );
    assert.equal(who.usename, ROLE);
    assert.equal(who.usesuper, false);
    assert.equal(who.bypass, false);
    assert.equal(who.owns, ROLE, 'the role under test owns the tables FORCE protects against');
  });

  it('covers every billing table that has a tenant_id column, with FORCE', async () => {
    const rows = await db.query<{ relname: string; enabled: boolean; forced: boolean; policies: string }>(
      `SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
              (SELECT COUNT(*)::text FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'billing' AND c.relkind IN ('r', 'p')
          AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
          AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)
        ORDER BY c.relname`,
    );
    assert.ok(rows.length >= 9, `expected at least 9 tenant tables, saw ${rows.length}`);
    for (const r of rows) {
      assert.equal(r.enabled, true, `${r.relname} has RLS enabled`);
      assert.equal(r.forced, true, `${r.relname} has RLS forced (owner not exempt)`);
      assert.equal(r.policies, '1', `${r.relname} has the tenant_isolation policy`);
    }
  });

  it('a declared tenant sees its rows; the other tenant and no-tenant see nothing', async () => {
    // Seed through the real APIs, inside declared-tenant transactions (writes
    // must pass WITH CHECK too).
    await asTenant(db, 'acme', async (tx) => {
      await record(
        tx,
        {
          tenantId: 'acme',
          subjectId: 'ada',
          source: 's',
          externalId: 'e1',
          metric: 'requests',
          quantity: Quantity.fromBigInt(5n),
          occurredAt: NOW,
        },
        NOW,
      );
      await post(
        tx,
        accrualPosting({ tenantId: 'acme', subjectId: 'ada', chargeId: 'chg-1', amount: usd('10.00') }),
        NOW,
      );
    });
    await asTenant(db, 'globex', async (tx) => {
      await post(
        tx,
        accrualPosting({ tenantId: 'globex', subjectId: 'bob', chargeId: 'chg-2', amount: usd('99.00') }),
        NOW,
      );
    });

    await asTenant(db, 'acme', async (tx) => {
      assert.equal(
        (
          await balance(tx, { tenantId: 'acme', subjectId: 'ada', account: 'customer_balance', currency: 'USD' })
        ).toDecimalString(),
        '10.00',
      );
      // The cross-tenant read: correct tenant_id in the WHERE, wrong tenant on
      // the connection. RLS answers empty, not an error.
      assert.equal(
        (
          await balance(tx, { tenantId: 'globex', subjectId: 'bob', account: 'customer_balance', currency: 'USD' })
        ).toDecimalString(),
        '0.00',
      );
      assert.deepEqual(await entries(tx, { tenantId: 'globex', subjectId: 'bob' }), []);
      // The forgotten-WHERE query this file exists for:
      const all = await tx.query<{ tenant_id: string }>('SELECT DISTINCT tenant_id FROM billing.ledger_entries');
      assert.deepEqual(
        all.map((r) => r.tenant_id),
        ['acme'],
      );
    });

    await asTenant(db, 'globex', async (tx) => {
      const all = await tx.query<{ tenant_id: string }>('SELECT DISTINCT tenant_id FROM billing.ledger_entries');
      assert.deepEqual(
        all.map((r) => r.tenant_id),
        ['globex'],
      );
    });

    // No SET LOCAL at all: closed by default.
    const bare = await owner.query('SELECT COUNT(*)::int AS n FROM billing.ledger_entries');
    assert.equal(bare.rows[0].n, 0, 'a connection that declared no tenant sees nothing');
    const bareTx = await db.transaction(async (tx) =>
      tx.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM billing.usage_events'),
    );
    assert.equal(bareTx[0].n, 0);
  });

  it('refuses a write for a tenant the transaction did not declare', async () => {
    await assert.rejects(
      asTenant(db, 'acme', (tx) =>
        post(tx, accrualPosting({ tenantId: 'globex', subjectId: 'bob', chargeId: 'chg-3', amount: usd('1.00') }), NOW),
      ),
      /row-level security|policy/i,
    );
    // And with no declaration at all.
    await assert.rejects(
      db.transaction((tx) =>
        post(tx, accrualPosting({ tenantId: 'acme', subjectId: 'ada', chargeId: 'chg-4', amount: usd('1.00') }), NOW),
      ),
      /row-level security|policy/i,
    );
  });

  it('SET LOCAL scopes the declaration to the transaction, not the connection', async () => {
    await asTenant(db, 'acme', async (tx) => {
      const [r] = await tx.query<{ t: string | null }>(`SELECT current_setting('tenancy.tenant_id', true) AS t`);
      assert.equal(r.t, 'acme');
    });
    // The same pool, next transaction: the setting is gone.
    const after = await db.transaction((tx) =>
      tx.query<{ t: string | null }>(`SELECT current_setting('tenancy.tenant_id', true) AS t`),
    );
    assert.ok(after[0].t === null || after[0].t === '', 'SET LOCAL must not leak past COMMIT');
  });
});
