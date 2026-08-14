// Reading sql/, recording what has been applied, and refusing when the two
// disagree.
//
// The tracking table is `billing.schema_migrations`, keyed by filename:
//
//   filename    text primary key   -- the identity a human uses
//   checksum    text               -- sha256 of the file, hex
//   applied_at  timestamptz
//   duration_ms integer
//
// Keyed by filename rather than by a sequence number because the filename is
// what the user reads, what the error message has to name, and what `git log`
// can be pointed at. A serial version column would be a second identity that
// has to be kept in step with the first.
//
// The checksum is the whole reason the table has a second column. Without it a
// re-run of an edited migration is a silent no-op: the file says one thing, the
// database holds another, and nothing in either says they diverged. With it,
// the divergence is the loudest thing the tool can do.

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { SqlExecutor } from '../src/types.ts';
import { CliError } from './errors.ts';

/** Every object the CLI creates lives here. See ARCHITECTURE.md §7.6. */
export const SCHEMA = 'billing';
export const TABLE = `${SCHEMA}.schema_migrations`;

const LEDGER_DDL = `
  CREATE SCHEMA IF NOT EXISTS ${SCHEMA};

  CREATE TABLE IF NOT EXISTS ${TABLE} (
    filename    text PRIMARY KEY,
    checksum    text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now(),
    duration_ms integer NOT NULL
  );
`;

export interface MigrationFile {
  filename: string;
  absolutePath: string;
  checksum: string;
  sql: string;
}

export interface AppliedMigration {
  filename: string;
  checksum: string;
  appliedAt: Date;
}

export type PlanEntry =
  | { state: 'pending'; filename: string }
  | { state: 'applied'; filename: string; appliedAt: Date }
  /** On disk and applied, but not the same bytes. Refused, never skipped. */
  | { state: 'changed'; filename: string; appliedAt: Date; recorded: string; onDisk: string }
  /** Recorded as applied and no longer in sql/. Also drift, in the other direction. */
  | { state: 'missing'; filename: string; appliedAt: Date };

/**
 * sha256 over the file's bytes, unmodified.
 *
 * Not normalised. A newline convention change is a change to the bytes that
 * produced the schema, and a tool that decides some edits do not count is a
 * tool that has to be right about which ones. The cost is that a checkout with
 * `core.autocrlf=true` will report every migration as changed — correctly, and
 * with a message that says which files and what to do about it.
 */
export const checksum = (bytes: Buffer): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/**
 * Every `.sql` file in `dir`, in byte order of the filename.
 *
 * Byte order, not a parsed leading number: the files are zero-padded (`001`,
 * `010`) so the two orders agree, and parsing would invent a total order the
 * filenames do not have — `1_a.sql` and `01_b.sql` would compare equal and the
 * order would then be whatever readdir returned that day. `localeCompare` is
 * out for the same reason: it depends on the machine's locale.
 */
export async function readMigrations(dir: string): Promise<MigrationFile[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    throw new CliError(`no migrations directory at ${dir}`, [
      'Point at one with `--migrations <dir>` or the `migrations` key in billing.config.',
    ]);
  }

  const sql = names.filter((n) => n.endsWith('.sql')).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (sql.length === 0) throw new CliError(`no .sql files in ${dir}`);

  return Promise.all(
    sql.map(async (filename) => {
      const absolutePath = path.join(dir, filename);
      const bytes = await readFile(absolutePath);
      return { filename, absolutePath, checksum: checksum(bytes), sql: bytes.toString('utf8') };
    }),
  );
}

/** Present after `migrate`; absent before the first one. */
export async function ledgerExists(db: SqlExecutor): Promise<boolean> {
  const rows = await db.query<{ oid: string | null }>(`SELECT to_regclass($1)::text AS oid`, [TABLE]);
  return rows[0]?.oid != null;
}

export async function ensureLedger(db: SqlExecutor): Promise<void> {
  await db.query(LEDGER_DDL);
}

export async function readApplied(db: SqlExecutor): Promise<AppliedMigration[]> {
  const rows = await db.query<{ filename: string; checksum: string; applied_at: Date }>(
    `SELECT filename, checksum, applied_at FROM ${TABLE} ORDER BY filename`,
  );
  return rows.map((r) => ({ filename: r.filename, checksum: r.checksum, appliedAt: r.applied_at }));
}

/**
 * What the files and the database say about each other.
 *
 * Order is the file order, with anything recorded but absent from disk after
 * it — those have no place in the sequence, which is exactly the problem.
 */
export function plan(files: readonly MigrationFile[], applied: readonly AppliedMigration[]): PlanEntry[] {
  const byName = new Map(applied.map((a) => [a.filename, a]));
  const entries: PlanEntry[] = files.map((file) => {
    const row = byName.get(file.filename);
    if (!row) return { state: 'pending', filename: file.filename };
    if (row.checksum !== file.checksum) {
      return {
        state: 'changed',
        filename: file.filename,
        appliedAt: row.appliedAt,
        recorded: row.checksum,
        onDisk: file.checksum,
      };
    }
    return { state: 'applied', filename: file.filename, appliedAt: row.appliedAt };
  });

  const onDisk = new Set(files.map((f) => f.filename));
  for (const row of applied) {
    if (!onDisk.has(row.filename)) {
      entries.push({ state: 'missing', filename: row.filename, appliedAt: row.appliedAt });
    }
  }
  return entries;
}

/**
 * Apply one file and record it, atomically.
 *
 * Postgres runs DDL inside a transaction, so "applied but unrecorded" — the
 * state that makes the next run fail on a `CREATE TABLE` that already exists —
 * cannot happen here. It is not free everywhere: `CREATE INDEX CONCURRENTLY`
 * and `VACUUM` cannot run in a transaction block and would need this to be
 * relaxed per file. None of the shipped migrations use them, and the check is
 * one grep, so the transaction is unconditional until a file needs otherwise.
 *
 * The whole file goes to the server as one string. Splitting on semicolons is
 * the classic mistake: `$$ ... ; ... $$` in every one of these files is a
 * function body, and a splitter cuts it in half.
 */
export async function applyMigration(db: SqlExecutor, file: MigrationFile): Promise<number> {
  const started = Date.now();
  await db.transaction(async (tx) => {
    await tx.query(file.sql);
    await tx.query(
      `INSERT INTO ${TABLE} (filename, checksum, duration_ms) VALUES ($1, $2, $3)`,
      [file.filename, file.checksum, Date.now() - started],
    );
  });
  return Date.now() - started;
}

/**
 * Hold the migration lock for this session, or say who has it.
 *
 * Not for correctness of a single file — each one is its own transaction and
 * Postgres serialises the DDL anyway. It is so that two concurrent runs cannot
 * interleave *different* files, which produces a database in an order that no
 * single run would ever have produced and that nothing records.
 */
export async function takeLock(db: SqlExecutor): Promise<boolean> {
  const rows = await db.query<{ locked: boolean }>(
    `SELECT pg_try_advisory_lock(hashtext('billing-kit:migrate')) AS locked`,
  );
  return rows[0]?.locked === true;
}

export async function releaseLock(db: SqlExecutor): Promise<void> {
  await db.query(`SELECT pg_advisory_unlock(hashtext('billing-kit:migrate'))`);
}
