// A SqlExecutor backed by a long-lived `psql` subprocess. TEST ONLY.
//
// billing-kit has no runtime dependencies and no database driver — that is the
// point of SqlExecutor — so there is no `pg` to test against. Rather than test
// the driver against a mock and call the engine verified, this drives real
// Postgres through psql: one subprocess is one backend, so N executors are N
// genuinely concurrent connections and BEGIN/COMMIT really is one session.
//
// It is not a production adapter and must never become one. Two reasons, both
// disqualifying:
//
//   - Parameters are interpolated as literals, because psql has no bind
//     protocol. The quoting below is careful, but "careful quoting" is the
//     thing bind parameters exist to replace.
//   - Every statement is wrapped so it returns JSON rows, so a statement with
//     no RETURNING clause does not work here.
//
// A real adapter over `pg.Pool` is about ten lines and belongs with the docs.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { SqlExecutor } from '../../types.ts';

const SENTINEL = '__billing_kit_eos__';

/**
 * Quote a JS value as a Postgres literal.
 *
 * Test-only, and the reason it is acceptable here and nowhere else is that
 * every value passed in these tests originates in the test itself. Nothing
 * user-supplied reaches it.
 */
const literal = (value: unknown): string => {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`psql-executor: cannot bind ${value}`);
    return String(value);
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return `'${String(value).replaceAll("'", "''")}'`;
};

/** $1-style placeholders, filled in client-side. See the caveat above. */
const bind = (text: string, params: readonly unknown[]): string =>
  text.replace(/\$(\d+)/g, (_match, index: string) => {
    const value = params[Number(index) - 1];
    if (value === undefined && Number(index) > params.length) {
      throw new Error(`psql-executor: no parameter $${index}`);
    }
    return literal(value);
  });

export interface PsqlExecutor extends SqlExecutor {
  close(): Promise<void>;
}

export const createPsqlExecutor = (database: string): PsqlExecutor => {
  const child: ChildProcessWithoutNullStreams = spawn(
    'psql',
    [
      '-X', // no ~/.psqlrc; the test must not depend on the developer's shell
      '-q',
      '-A',
      '-t',
      '--no-psqlrc',
      '-v',
      'ON_ERROR_STOP=0',
      '-d',
      database,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );

  let out = '';
  let err = '';
  let waiting: (() => void) | null = null;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    out += chunk;
    if (waiting !== null && out.includes(SENTINEL)) waiting();
  });
  child.stderr.on('data', (chunk: string) => {
    err += chunk;
  });
  child.on('close', () => {
    if (waiting !== null) waiting();
  });

  // One statement at a time down one pipe. Without this, two overlapping
  // queries interleave their output and both parse garbage — which presents as
  // a flaky test rather than as the serialisation bug it is.
  let tail: Promise<unknown> = Promise.resolve();
  const serialise = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn, fn);
    tail = next.catch(() => undefined);
    return next;
  };

  const send = (sql: string): Promise<string> =>
    new Promise((resolve, reject) => {
      out = '';
      err = '';
      waiting = (): void => {
        const at = out.indexOf(SENTINEL);
        if (at === -1) {
          waiting = null;
          reject(new Error(`psql exited (${child.exitCode}) before completing: ${err}`));
          return;
        }
        waiting = null;
        // stderr is written before the sentinel reaches stdout for the same
        // statement, so by here it is complete for this statement.
        if (/^(ERROR|FATAL):/m.test(err)) {
          reject(new Error(err.trim()));
          return;
        }
        resolve(out.slice(0, at));
      };
      child.stdin.write(`${sql}\n\\echo ${SENTINEL}\n`);
    });

  const run = async <T>(text: string, params: readonly unknown[] = []): Promise<T[]> => {
    const sql = bind(text, params);
    // Wrapping in a CTE is what lets one code path serve SELECT, INSERT
    // ... RETURNING and UPDATE ... RETURNING alike, and row_to_json is what
    // preserves column names through psql's tuples-only output.
    const wrapped = `WITH __q AS (${sql}) SELECT row_to_json(__q)::text FROM __q;`;
    const body = await send(wrapped);
    return body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as T);
  };

  const executor: PsqlExecutor = {
    query: <T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]> =>
      serialise(() => run<T>(text, params ?? [])),

    transaction: <T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> =>
      serialise(async () => {
        // The inner executor bypasses `serialise` — it is already inside the
        // serialised slot, and re-entering it would deadlock on `tail`.
        const tx: SqlExecutor = {
          query: <R = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<R[]> =>
            run<R>(text, params ?? []),
          transaction: () => {
            throw new Error('psql-executor: nested transactions are not supported');
          },
        };
        await send('BEGIN;');
        try {
          const result = await fn(tx);
          await send('COMMIT;');
          return result;
        } catch (error) {
          await send('ROLLBACK;').catch(() => undefined);
          throw error;
        }
      }),

    close: () =>
      new Promise<void>((resolve) => {
        child.once('close', () => resolve());
        child.stdin.end();
      }),
  };

  return executor;
};
