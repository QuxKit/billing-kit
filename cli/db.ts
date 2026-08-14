// The CLI's one connection, behind `SqlExecutor`.
//
// `pg` is an OPTIONAL peer dependency (package.json, peerDependenciesMeta).
// The library has no runtime dependency on a driver and must not grow one: the
// whole point of `SqlExecutor` is that the adopter brings the connection. But
// the CLI is a program, not a library — it has to open a socket itself — so it
// imports `pg` dynamically and says what to install when it is absent. A static
// import would turn "no driver" into a module-resolution stack trace at
// startup, which is the same information delivered unusably.
//
// One `Client`, not a `Pool`, and that is load-bearing twice over:
//
//   - `pg_advisory_lock` belongs to a session. A pool hands out a different
//     connection per query, so the lock would be taken on one connection, never
//     seen by the migrations, and released on a third. ARCHITECTURE.md §5.4
//     records the same trap for the drain lease.
//   - `transaction` here can hand back `this` rather than pinning a connection,
//     because there is only ever one.

import type { SqlExecutor } from '../src/types.ts';
import { CliError } from './errors.ts';

const PG_MISSING = [
  '`pg` is an optional peer dependency of billing-kit: the library is',
  'driver-agnostic and does not install one. The CLI needs a driver to connect.',
  '',
  '  npm install pg          # or: pnpm add pg / yarn add pg',
];

export interface Connection extends SqlExecutor {
  close(): Promise<void>;
}

/** Minimal shape of what this file uses from `pg`, so nothing here needs @types/pg. */
interface PgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export async function connect(databaseUrl: string): Promise<Connection> {
  let PgClientCtor: new (config: { connectionString: string }) => PgClient;
  try {
    const mod: unknown = await import('pg');
    // `pg` is CommonJS, so the named exports an ESM importer sees depend on the
    // interop layer's cjs-named-export detection. `default` is the one that is
    // always there.
    const pg = ((mod as { default?: unknown }).default ?? mod) as {
      Client: new (config: { connectionString: string }) => PgClient;
    };
    PgClientCtor = pg.Client;
  } catch {
    throw new CliError('cannot load `pg`', PG_MISSING);
  }

  const client = new PgClientCtor({ connectionString: databaseUrl });
  try {
    await client.connect();
  } catch (error) {
    throw new CliError(`cannot connect to ${redact(databaseUrl)}`, [
      error instanceof Error ? error.message : String(error),
    ]);
  }

  const executor: Connection = {
    async query<T>(text: string, params?: readonly unknown[]): Promise<T[]> {
      const result = await client.query(text, params as unknown[]);
      return result.rows as T[];
    },
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      await client.query('BEGIN');
      try {
        const out = await fn(executor);
        await client.query('COMMIT');
        return out;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    },
    close: () => client.end(),
  };

  return executor;
}

/**
 * A connection string with the password replaced, for printing.
 *
 * Every command prints the URL it is acting on, because "which database did
 * that just run against" is the question a migration tool has to answer without
 * being asked. Printing the password too would put it in CI logs.
 */
export function redact(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    // Not a URL — a libpq keyword/value string, or a typo. Say nothing about
    // its contents rather than guess where the secret is.
    return '<database url>';
  }
}
