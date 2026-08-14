// CLI tests.
//
// These spawn `bin/billing-kit.mjs` as a child process rather than calling
// `run()` in-process. The launcher, the type stripping, the exit status and the
// text on stderr are the whole product here — a test that imported the module
// would exercise none of them and would still pass if `bin/` were deleted.
//
// The migration tests create and drop their own database. They do not touch any
// existing one: a tool whose failure mode is "applied the wrong DDL somewhere"
// should not be tested against a database anybody cares about.
//
// Most of them run against three throwaway .sql files rather than the shipped
// sql/, because what is under test is the applier — order, idempotency,
// checksums, transactions — and the shipped files would make each case a
// several-hundred-millisecond schema build. The shipped files get their own
// tests at the bottom, and one of them is red-by-reality: 001_core.sql and
// 010_metering.sql collide, so `migrate` on the shipped set halts at the
// second file. That is the SQL's documented state, not the CLI's bug, and the
// test pins the CLI's half of it — halt, roll back, record nothing, say why.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(REPO, 'bin', 'billing-kit.mjs');

/**
 * Where CREATE DATABASE is issued from. `postgres` is the maintenance database
 * every server has; nothing is created in it and nothing is read from it.
 */
const ADMIN_URL = process.env.BILLING_KIT_CLI_TEST_ADMIN_URL ?? 'postgresql://localhost:5432/postgres';
const TEST_DB = 'billing_kit_cli_test';
const TEST_URL = ((): string => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${TEST_DB}`;
  return url.toString();
})();

const SKIP_REASON =
  `no database server at ${ADMIN_URL} — set BILLING_KIT_CLI_TEST_ADMIN_URL to one that can ` +
  'CREATE DATABASE, or start Postgres';

// --- fixtures ---------------------------------------------------------------

const FIXTURES: ReadonlyArray<readonly [string, string]> = [
  ['001_first.sql', 'CREATE SCHEMA IF NOT EXISTS billing;\nCREATE TABLE billing.alpha (id int PRIMARY KEY);\n'],
  ['002_second.sql', 'CREATE TABLE billing.beta (id int PRIMARY KEY);\n'],
  ['003_third.sql', 'ALTER TABLE billing.alpha ADD COLUMN note text;\n'],
];

/** Creates a table and then fails. Proves the transaction covers both. */
const BAD_MIGRATION = 'CREATE TABLE billing.gamma (id int);\nSELECT 1 / 0;\n';

interface Cli {
  status: number;
  stdout: string;
  stderr: string;
}

const cli = (args: readonly string[], cwd = REPO): Cli => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

let admin: pg.Client | null = null;
const temps: string[] = [];

// realpath because on macOS `tmpdir()` is /var/... , a symlink to /private/var,
// and the child process reports the resolved form. Comparing the two as
// strings fails for a reason that has nothing to do with the CLI.
const temp = async (name: string): Promise<string> => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), `bk-cli-${name}-`)));
  temps.push(dir);
  return dir;
};

/** A directory of the three fixture migrations, fresh per test. */
const fixtureDir = async (): Promise<string> => {
  const dir = await temp('sql');
  for (const [name, sql] of FIXTURES) await writeFile(path.join(dir, name), sql);
  return dir;
};

/** Drop and recreate the throwaway database, so each test starts from nothing. */
const resetDatabase = async (): Promise<void> => {
  if (!admin) return;
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
};

const inTestDb = async <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => {
  const client = new pg.Client({ connectionString: TEST_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
};

before(async () => {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  try {
    await client.connect();
    admin = client;
  } catch {
    await client.end().catch(() => {});
  }
});

after(async () => {
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

// --- init -------------------------------------------------------------------

describe('billing-kit init', () => {
  it('writes billing.config.ts in a TypeScript project and prints what it wrote', async () => {
    const dir = await temp('init-ts');
    await writeFile(path.join(dir, 'tsconfig.json'), '{}');

    const r = cli(['init'], dir);
    assert.equal(r.status, 0, r.stderr);

    const target = path.join(dir, 'billing.config.ts');
    const written = await readFile(target, 'utf8');
    assert.match(r.stdout, new RegExp(`wrote ${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

    // Every line of the file appears in the output. "Print exactly what it
    // wrote" is the requirement, and a summary is not that.
    for (const line of written.split('\n').filter(Boolean)) {
      assert.ok(r.stdout.includes(line), `stdout is missing: ${line}`);
    }

    // The template has to state the design line it exists under, or the next
    // person adds a `process.env` read to the library instead.
    assert.match(written, /never reads this file and never reads\n\/\/ process\.env/);
    assert.match(written, /databaseUrl: process\.env\.DATABASE_URL/);
    assert.match(written, /schema: 'billing'/);
    assert.match(written, /provider/);
  });

  it('writes billing.config.js when the project is not TypeScript', async () => {
    const dir = await temp('init-js');
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', type: 'module' }));

    const r = cli(['init'], dir);
    assert.equal(r.status, 0, r.stderr);
    await assert.doesNotReject(readFile(path.join(dir, 'billing.config.js'), 'utf8'));
    await assert.rejects(readFile(path.join(dir, 'billing.config.ts'), 'utf8'));
  });

  it('refuses to clobber an existing config and exits non-zero', async () => {
    const dir = await temp('init-clobber');
    await writeFile(path.join(dir, 'tsconfig.json'), '{}');
    const mine = 'export default { databaseUrl: "postgres://mine" };\n';
    await writeFile(path.join(dir, 'billing.config.ts'), mine);

    const r = cli(['init'], dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /billing\.config\.ts already exists/);
    assert.match(r.stderr, /Nothing was written/);
    assert.equal(await readFile(path.join(dir, 'billing.config.ts'), 'utf8'), mine);
  });

  it('has no install hook that could run it unasked', async () => {
    const pkg = JSON.parse(await readFile(path.join(REPO, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish']) {
      assert.equal(pkg.scripts?.[hook], undefined, `package.json must not define a ${hook} script`);
    }
  });
});

// --- config -----------------------------------------------------------------

describe('billing-kit config', () => {
  it('reads a config file and lets --database-url override it', async () => {
    const dir = await temp('config-read');
    await writeFile(
      path.join(dir, 'billing.config.js'),
      "export default { databaseUrl: 'postgres://localhost:1/from-config' };\n",
    );
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));

    const fromConfig = cli(['status'], dir);
    assert.match(fromConfig.stderr, /from-config/, 'the config url should be the one attempted');

    const overridden = cli(['status', '--database-url', 'postgres://localhost:1/from-flag'], dir);
    assert.match(overridden.stderr, /from-flag/);
    assert.doesNotMatch(overridden.stderr, /from-config/);
  });

  it('refuses an unknown config key rather than silently ignoring it', async () => {
    const dir = await temp('config-typo');
    await writeFile(path.join(dir, 'billing.config.js'), "export default { databaseURL: 'x' };\n");
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));

    const r = cli(['status'], dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown key: databaseURL/);
  });

  it('refuses a schema name other than billing, because sql/ hardcodes it', async () => {
    const dir = await temp('config-schema');
    await writeFile(
      path.join(dir, 'billing.config.js'),
      "export default { databaseUrl: 'postgres://localhost:1/x', schema: 'billing_v2' };\n",
    );
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));

    const r = cli(['status'], dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /schema must be 'billing'/);
  });

  it('says what to do when there is no database url at all', async () => {
    const dir = await temp('config-none');
    const r = cli(['status'], dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no database url/);
    assert.match(r.stderr, /billing-kit init/);
  });

  it('names `pg` and how to install it when the driver is absent', async () => {
    // A copy of the package with no node_modules. This is what an adopter who
    // installed billing-kit and no driver actually has, and the failure has to
    // be a sentence rather than a resolution stack trace.
    const dir = await temp('no-pg');
    for (const entry of ['bin', 'cli', 'src', 'sql', 'package.json']) {
      await cp(path.join(REPO, entry), path.join(dir, entry), { recursive: true });
    }

    const r = spawnSync(
      process.execPath,
      [path.join(dir, 'bin', 'billing-kit.mjs'), 'status', '--database-url', 'postgres://localhost:1/x'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /cannot load `pg`/);
    assert.match(r.stderr, /optional peer dependency/);
    assert.match(r.stderr, /npm install pg/);
  });
});

// --- migrate ----------------------------------------------------------------

describe('billing-kit migrate', () => {
  const guard = () => (admin ? false : SKIP_REASON);

  it('applies every file, in lexical order, and records each one', async (t) => {
    if (guard()) return t.skip(SKIP_REASON);
    await resetDatabase();
    const sql = await fixtureDir();

    const r = cli(['migrate', '--database-url', TEST_URL, '--migrations', sql]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /applying {5}001_first\.sql … ok/);
    assert.match(r.stdout, /3 applied\./);

    await inTestDb(async (c) => {
      const rows = (await c.query('SELECT filename, checksum, duration_ms FROM billing.schema_migrations ORDER BY applied_at, filename')).rows;
      assert.deepEqual(
        rows.map((row) => row.filename),
        ['001_first.sql', '002_second.sql', '003_third.sql'],
      );
      for (const row of rows) assert.match(row.checksum, /^sha256:[0-9a-f]{64}$/);

      // The DDL actually ran, including the third file's ALTER.
      const cols = (
        await c.query(
          "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'billing' ORDER BY 1, 2",
        )
      ).rows;
      assert.ok(cols.some((x) => x.table_name === 'alpha' && x.column_name === 'note'));
      assert.ok(cols.some((x) => x.table_name === 'beta'));
    });
  });

  it('is a no-op the second time', async (t) => {
    if (guard()) return t.skip(SKIP_REASON);
    await resetDatabase();
    const sql = await fixtureDir();

    assert.equal(cli(['migrate', '--database-url', TEST_URL, '--migrations', sql]).status, 0);
    const first = await inTestDb((c) =>
      c.query('SELECT filename, applied_at FROM billing.schema_migrations ORDER BY filename').then((x) => x.rows),
    );

    const second = cli(['migrate', '--database-url', TEST_URL, '--migrations', sql]);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /nothing to apply/);

    const later = await inTestDb((c) =>
      c.query('SELECT filename, applied_at FROM billing.schema_migrations ORDER BY filename').then((x) => x.rows),
    );
    // Same rows, same timestamps: nothing was re-applied and nothing was
    // re-stamped. A tool that re-stamped would lose the record of when the
    // schema actually changed.
    assert.deepEqual(later, first);
  });

  it('refuses when an applied file has changed on disk, and applies nothing', async (t) => {
    if (guard()) return t.skip(SKIP_REASON);
    await resetDatabase();
    const sql = await fixtureDir();

    assert.equal(cli(['migrate', '--database-url', TEST_URL, '--migrations', sql]).status, 0);

    // Semantically identical — a trailing comment. The point is that the tool
    // does not get to decide which edits are harmless.
    await writeFile(path.join(sql, '002_second.sql'), `${FIXTURES[1][1]}-- reformatted\n`);
    await writeFile(path.join(sql, '004_fourth.sql'), 'CREATE TABLE billing.delta (id int);\n');

    const r = cli(['migrate', '--database-url', TEST_URL, '--migrations', sql]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /refusing to migrate/);
    assert.match(r.stderr, /002_second\.sql changed since it was applied/);
    assert.match(r.stderr, /recorded {2}sha256:/);
    assert.match(r.stderr, /on disk {3}sha256:/);
    assert.match(r.stderr, /UPDATE billing\.schema_migrations SET checksum/);

    // The pending file did not sneak in behind the refusal.
    await inTestDb(async (c) => {
      const rows = (await c.query('SELECT filename FROM billing.schema_migrations')).rows;
      assert.equal(rows.length, 3);
      assert.equal((await c.query("SELECT to_regclass('billing.delta') AS t")).rows[0].t, null);
    });
  });

  it('reports a file recorded as applied that is no longer on disk', async (t) => {
    if (guard()) return t.skip(SKIP_REASON);
    await resetDatabase();
    const sql = await fixtureDir();
    assert.equal(cli(['migrate', '--database-url', TEST_URL, '--migrations', sql]).status, 0);
    await rm(path.join(sql, '003_third.sql'));

    const r = cli(['migrate', '--database-url', TEST_URL, '--migrations', sql]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /003_third\.sql was applied .* and is no longer on disk/);
  });

  it('rolls a failing migration back whole, and records nothing for it', async (t) => {
    if (guard()) return t.skip(SKIP_REASON);
    await resetDatabase();
    const sql = await fixtureDir();
    await writeFile(path.join(sql, '004_bad.sql'), BAD_MIGRATION);

    const r = cli(['migrate', '--database-url', TEST_URL, '--migrations', sql]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /004_bad\.sql failed and was rolled back/);
    assert.match(r.stderr, /division by zero/);

    await inTestDb(async (c) => {
      // The CREATE TABLE in the same file went with it.
      assert.equal((await c.query("SELECT to_regclass('billing.gamma') AS t")).rows[0].t, null);
      const rows = (await c.query('SELECT filename FROM billing.schema_migrations ORDER BY filename')).rows;
      assert.deepEqual(rows.map((x) => x.filename), ['001_first.sql', '002_second.sql', '003_third.sql']);
    });
  });

  it('--dry-run prints the plan and writes nothing at all', async (t) => {
    if (guard()) return t.skip(SKIP_REASON);
    await resetDatabase();
    const sql = await fixtureDir();

    const r = cli(['migrate', '--dry-run', '--database-url', TEST_URL, '--migrations', sql]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /would apply {2}001_first\.sql/);
    assert.match(r.stdout, /Nothing was written/);

    await inTestDb(async (c) => {
      // Not even the tracking table. A dry run that creates its own bookkeeping
      // has already changed the database it promised not to touch.
      assert.equal((await c.query("SELECT to_regclass('billing.schema_migrations') AS t")).rows[0].t, null);
      assert.equal((await c.query("SELECT to_regclass('billing.alpha') AS t")).rows[0].t, null);
    });
  });
});

// --- status -----------------------------------------------------------------

describe('billing-kit status', () => {
  const guard = () => (admin ? false : SKIP_REASON);

  it('reports everything pending on an untouched database', async (t) => {
    if (guard()) return t.skip(SKIP_REASON);
    await resetDatabase();
    const sql = await fixtureDir();

    const r = cli(['status', '--database-url', TEST_URL, '--migrations', sql]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /0 applied, 3 pending/);
    assert.doesNotMatch(r.stdout, /applied {3}00/);
  });

  it('reports the split after a partial migration', async (t) => {
    if (guard()) return t.skip(SKIP_REASON);
    await resetDatabase();
    const sql = await fixtureDir();
    // Apply the first two by migrating a directory that only holds those two.
    const partial = await temp('partial');
    for (const [name, body] of FIXTURES.slice(0, 2)) await writeFile(path.join(partial, name), body);
    assert.equal(cli(['migrate', '--database-url', TEST_URL, '--migrations', partial]).status, 0);

    const r = cli(['status', '--database-url', TEST_URL, '--migrations', sql]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /applied {3}001_first\.sql {2}\s*\d{4}-\d\d-\d\dT/);
    assert.match(r.stdout, /pending {3}003_third\.sql/);
    assert.match(r.stdout, /2 applied, 1 pending/);
  });

  it('exits non-zero on drift, so it can gate a deploy', async (t) => {
    if (guard()) return t.skip(SKIP_REASON);
    await resetDatabase();
    const sql = await fixtureDir();
    assert.equal(cli(['migrate', '--database-url', TEST_URL, '--migrations', sql]).status, 0);
    await writeFile(path.join(sql, '001_first.sql'), `${FIXTURES[0][1]}-- edited\n`);

    const r = cli(['status', '--database-url', TEST_URL, '--migrations', sql]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /CHANGED {3}001_first\.sql/);
    assert.match(r.stdout, /1 drifted — migrate will refuse/);
  });
});

// --- the shipped sql/ -------------------------------------------------------

describe('billing-kit migrate against the shipped sql/', () => {
  const guard = () => (admin ? false : SKIP_REASON);

  it('applies the metering group whole', async (t) => {
    if (guard()) return t.skip(SKIP_REASON);
    await resetDatabase();
    const dir = await temp('metering');
    for (const name of ['010_metering.sql', '011_partitions.sql', '012_meter_batch.sql', '013_runs.sql']) {
      await cp(path.join(REPO, 'sql', name), path.join(dir, name));
    }

    const r = cli(['migrate', '--database-url', TEST_URL, '--migrations', dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /4 applied\./);

    await inTestDb(async (c) => {
      const fn = (await c.query("SELECT to_regprocedure('billing.meter_batch(integer,integer)') AS f")).rows[0].f;
      assert.ok(fn, 'meter_batch should exist after 012');
      assert.equal(
        (await c.query('SELECT count(*)::int AS n FROM billing.schema_migrations')).rows[0].n,
        4,
      );
    });
  });

  it('halts on the documented 001/010 collision instead of skipping past it', async (t) => {
    if (guard()) return t.skip(SKIP_REASON);
    await resetDatabase();

    // The shipped five cannot all be applied: sql/001_core.sql and
    // sql/010_metering.sql declare billing.ledger_entries in two incompatible
    // shapes, and 010 raises rather than let the second definition be silently
    // ignored. Both files say so in their headers. This test asserts the CLI's
    // half of that contract, not that the situation is fine.
    const r = cli(['migrate', '--database-url', TEST_URL, '--migrations', path.join(REPO, 'sql')]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /applying {5}001_core\.sql … ok/);
    assert.match(r.stderr, /010_metering\.sql failed and was rolled back/);
    assert.match(r.stderr, /already exists in an incompatible shape/);

    await inTestDb(async (c) => {
      const rows = (await c.query('SELECT filename FROM billing.schema_migrations')).rows;
      assert.deepEqual(rows.map((x) => x.filename), ['001_core.sql'], 'only 001 should be recorded');
    });

    // And the state is resumable: status says where it stopped.
    const s = cli(['status', '--database-url', TEST_URL, '--migrations', path.join(REPO, 'sql')]);
    assert.match(s.stdout, /1 applied, 4 pending/);
  });
});
