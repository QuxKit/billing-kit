// The metering driver: loop until drained, one bounded transaction at a time.
//
// The engine is in sql/012_meter_batch.sql. This file's whole job is to call it
// repeatedly, under bounds, and to leave a record of what happened including —
// especially — when it failed.
//
// Two things live here rather than in SQL, and both for the same reason: they
// have to survive the transaction failing.
//
//   - The run record. The reference implementation wrote its failure row inside
//     a PL/pgSQL EXCEPTION handler and then RAISEd. The RAISE aborts the
//     transaction and takes the INSERT with it, so the only run anyone needed a
//     record of is the only run that left none.
//   - The loop. Calling the batch once per cron tick would put the O(downtime)
//     recovery straight back, which is the thing the batch bound exists to
//     remove.

import { hostname } from 'node:os';
import type { SqlExecutor } from '../types.ts';
import type {
  AmountByCurrency,
  BatchOptions,
  BatchResult,
  DrainOptions,
  DrainReport,
  DrainStatus,
  MeteringHealth,
  PartitionRow,
} from './types.ts';

/**
 * Large enough that the per-transaction overhead is noise, small enough that
 * the lock set and the WAL of one batch are bounded by something you can hold
 * in your head. The number is a starting point, not a discovery — measure
 * against a real estate and move it.
 */
const DEFAULT_BATCH = 500;

/** 24h. See the cap's comment in sql/012_meter_batch.sql; it is a money decision. */
const DEFAULT_MAX_MINUTES = 1440;

const DEFAULT_DEADLINE_MS = 60_000;
const DEFAULT_MAX_ITERATIONS = 1_000;
const DEFAULT_LEASE_MS = 300_000;

// --- coercion ---------------------------------------------------------------
//
// Drivers disagree about what a BIGINT is. node-postgres returns a string,
// which is correct. Others return a number, which is correct up to 2^53 and
// silently wrong above it. Rather than trust whichever one is installed, every
// value that must be exact is checked on the way in.

const asBigInt = (value: unknown, field: string): bigint => {
  if (typeof value === 'bigint') return value;
  if (value === null || value === undefined) return 0n;
  if (typeof value === 'string') {
    if (!/^-?\d+$/.test(value)) {
      throw new Error(`metering: ${field} is not an integer literal: ${JSON.stringify(value)}`);
    }
    return BigInt(value);
  }
  if (typeof value === 'number') {
    // The guard that matters. A driver that hands back 9007199254740993 as a
    // number has already lost the last digit, and BigInt(value) would launder
    // the loss into an exact-looking type. Refusing is the only honest option:
    // there is no way to recover the digit from here.
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `metering: ${field} arrived as the number ${value}, which is outside the exactly-representable ` +
          `range. The SQL executor is returning BIGINT as a JavaScript number and has already lost precision.`,
      );
    }
    return BigInt(value);
  }
  throw new Error(`metering: ${field} has unusable type ${typeof value}`);
};

const asInt = (value: unknown, field: string): number => {
  const n = asBigInt(value, field);
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`metering: ${field} does not fit a JavaScript number: ${n}`);
  }
  return Number(n);
};

/**
 * `{"USD": "12940"}` from jsonb, into exact bigints.
 *
 * The values are strings in the database on purpose (see meter_runs's column
 * comment): a jsonb number is arbitrary-precision in Postgres and an IEEE-754
 * double the instant JSON.parse touches it. A number arriving here therefore
 * means somebody changed the SQL, so it is checked rather than assumed.
 */
const asAmountByCurrency = (value: unknown, field: string): AmountByCurrency => {
  if (value === null || value === undefined) return {};
  const raw: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`metering: ${field} is not a currency map`);
  }
  const out: Record<string, bigint> = {};
  for (const [currency, amount] of Object.entries(raw as Record<string, unknown>)) {
    out[currency] = asBigInt(amount, `${field}.${currency}`);
  }
  return out;
};

const addAmounts = (into: Map<string, bigint>, from: AmountByCurrency): void => {
  for (const [currency, amount] of Object.entries(from)) {
    into.set(currency, (into.get(currency) ?? 0n) + amount);
  }
};

/** bigint is not JSON-serialisable, so the wire form is a string in minor units. */
const amountsToJson = (amounts: Map<string, bigint>): string =>
  JSON.stringify(Object.fromEntries([...amounts].map(([c, a]) => [c, a.toString()])));

// --- batch ------------------------------------------------------------------

interface BatchRow {
  items_billed: unknown;
  minutes_billed: unknown;
  amount_by_currency: unknown;
  accounts_updated: unknown;
  items_suspended: unknown;
}

/**
 * One batch, in its own transaction.
 *
 * Exported so a host can run a single bounded batch — from a queue consumer, or
 * to bill one interval by hand during an incident — without taking the lease
 * and without the loop. It is the whole engine; `drain` is only a loop over it.
 */
export const meterBatch = async (db: SqlExecutor, options: BatchOptions = {}): Promise<BatchResult> => {
  const batch = options.batch ?? DEFAULT_BATCH;
  const maxMinutes = options.maxMinutes ?? DEFAULT_MAX_MINUTES;

  const rows = await db.transaction((tx) =>
    tx.query<BatchRow>('SELECT * FROM billing.meter_batch($1, $2)', [batch, maxMinutes]),
  );

  const row = rows[0];
  if (row === undefined) {
    // meter_batch is RETURNS TABLE with a RETURN QUERY of one row, so this
    // cannot happen against the shipped function. It can happen against an
    // older one left behind by a partial migration, and returning zeroes there
    // would report a successful run that billed nothing.
    throw new Error('metering: billing.meter_batch returned no row; is sql/012_meter_batch.sql applied?');
  }

  return {
    itemsBilled: asInt(row.items_billed, 'items_billed'),
    minutesBilled: asBigInt(row.minutes_billed, 'minutes_billed'),
    amountByCurrency: asAmountByCurrency(row.amount_by_currency, 'amount_by_currency'),
    accountsUpdated: asInt(row.accounts_updated, 'accounts_updated'),
    itemsSuspended: asInt(row.items_suspended, 'items_suspended'),
  };
};

// --- partitions and health --------------------------------------------------

export const ensurePartitions = async (
  db: SqlExecutor,
  options: { monthsAhead?: number; monthsBehind?: number } = {},
): Promise<number> => {
  const rows = await db.query<{ created: unknown }>(
    'SELECT billing.ensure_partitions($1, $2) AS created',
    [options.monthsAhead ?? 3, options.monthsBehind ?? 1],
  );
  return asInt(rows[0]?.created, 'created');
};

export const partitionReport = async (db: SqlExecutor): Promise<PartitionRow[]> => {
  const rows = await db.query<Record<string, unknown>>(
    'SELECT parent, partition_name, is_default, bounds, live_rows FROM billing.partition_report()',
  );
  return rows.map((r) => ({
    parent: String(r.parent),
    partitionName: String(r.partition_name),
    isDefault: r.is_default === true || r.is_default === 't' || r.is_default === 'true',
    bounds: String(r.bounds),
    liveRows: asBigInt(r.live_rows, 'live_rows'),
  }));
};

/**
 * Ask the database what it actually has, not what the schema says it should.
 *
 * That distinction is the whole point (§6.2): `prisma db push` produces a plain
 * unpartitioned table where a partitioned one was declared, and it warns about
 * nothing. The only place the truth exists is the catalog.
 */
export const health = async (db: SqlExecutor): Promise<MeteringHealth> => {
  const rows = await db.query<{ health: unknown }>('SELECT billing.metering_health() AS health');
  const raw: unknown = typeof rows[0]?.health === 'string' ? JSON.parse(rows[0].health as string) : rows[0]?.health;
  const parsed = raw as { ok?: unknown; faults?: unknown } | undefined;
  return {
    ok: parsed?.ok === true,
    faults: Array.isArray(parsed?.faults) ? (parsed.faults as MeteringHealth['faults']) : [],
  };
};

// --- drain ------------------------------------------------------------------

const defaultRunner = (): string => {
  try {
    return `${hostname()}/${process.pid}`;
  } catch {
    // Not every runtime that can reach Postgres can name itself. A run row with
    // an unhelpful runner is better than a drain that will not start.
    return `unknown/${process.pid}`;
  }
};

/**
 * Loop until drained.
 *
 * Each iteration is its own transaction. That is the entire point of the batch
 * bound: one call is bounded work no matter how far behind the queue is, and
 * progress is durable per batch, so hitting a bound is a pause rather than a
 * rollback.
 *
 * Never throws for "someone else is running" or "there was nothing to do" —
 * both are normal and both are a status. It does rethrow a real failure, after
 * recording it, because a driver that swallows a billing error is a driver that
 * turns a broken engine into a silently free product.
 */
export const drain = async (options: DrainOptions): Promise<DrainReport> => {
  const { db } = options;
  const clock = options.clock ?? ((): Date => new Date());
  const logger = options.logger;

  const batch = options.batch ?? DEFAULT_BATCH;
  const maxMinutes = options.maxMinutes ?? DEFAULT_MAX_MINUTES;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const runner = options.runner ?? defaultRunner();

  if (leaseMs <= deadlineMs) {
    // Caught here rather than left to be discovered, because the symptom is two
    // workers billing at once for a few seconds and the cause is two numbers in
    // a config file that nobody thought of together. The lease has to outlive
    // the drain that holds it.
    throw new Error(
      `metering: leaseMs (${leaseMs}) must exceed deadlineMs (${deadlineMs}), ` +
        `or a drain can outlive its own lease and a second worker will start while this one is still billing.`,
    );
  }

  const startedAt = clock().getTime();

  const claimed = await db.query<{ run_id: unknown }>(
    'SELECT billing.claim_meter_run($1, make_interval(secs => $2::double precision)) AS run_id',
    [runner, leaseMs / 1000],
  );
  const runId = claimed[0]?.run_id;

  if (runId === null || runId === undefined) {
    // Not an error, and deliberately not a throw. A five-minute cron and a
    // six-minute drain will hit this every time during a backlog, and paging on
    // it would mean paging hardest exactly when the system is working through a
    // problem correctly.
    logger?.info('metering: drain skipped, lease held by another worker', { runner });
    return {
      status: 'skipped',
      runId: null,
      iterations: 0,
      itemsBilled: 0,
      minutesBilled: 0n,
      amountByCurrency: {},
      accountsUpdated: 0,
      itemsSuspended: 0,
      durationMs: clock().getTime() - startedAt,
    };
  }

  const id = String(runId);
  const amounts = new Map<string, bigint>();
  let iterations = 0;
  let itemsBilled = 0;
  let minutesBilled = 0n;
  let accountsUpdated = 0;
  let itemsSuspended = 0;
  let status: DrainStatus = 'bounded';

  const settle = async (
    finalStatus: DrainStatus | 'failed',
    error?: unknown,
  ): Promise<void> => {
    const durationMs = clock().getTime() - startedAt;
    const message = error instanceof Error ? error.message : error === undefined ? null : String(error);
    const code =
      error !== null && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : null;
    try {
      await db.query(
        `SELECT billing.settle_meter_run($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)`,
        [
          id,
          finalStatus,
          iterations,
          itemsBilled.toString(),
          minutesBilled.toString(),
          itemsSuspended.toString(),
          accountsUpdated.toString(),
          amountsToJson(amounts),
          durationMs,
          message,
          code,
        ],
      );
    } catch (settleError) {
      // Must never mask the original. A failed drain whose failure could not be
      // recorded is still a failed drain, and the caller needs the first error,
      // not the second one about bookkeeping.
      logger?.error('metering: could not settle the run record', {
        runId: id,
        cause: settleError instanceof Error ? settleError.message : String(settleError),
      });
    }
  };

  try {
    if (options.ensurePartitions !== false) {
      const created = await ensurePartitions(db);
      if (created > 0) {
        // Zero on every call but the first of each month. A non-zero count from
        // a run that was not expected to create anything means the previous
        // runs were not happening.
        logger?.info('metering: created partitions', { created });
      }
    }

    for (;;) {
      if (iterations >= maxIterations) {
        status = 'bounded';
        break;
      }
      if (clock().getTime() - startedAt >= deadlineMs) {
        status = 'bounded';
        break;
      }

      // Once per batch, before the work rather than after: the lease has to
      // cover the batch that is about to run, not the one that just did.
      const beat = await db.query<{ id: unknown }>('SELECT billing.heartbeat_meter_run($1) AS id', [id]);
      if (beat[0]?.id === null || beat[0]?.id === undefined) {
        logger?.error('metering: lease lost mid-drain, stopping', { runId: id, iterations, leaseMs });
        status = 'lease_lost';
        break;
      }

      const result = await meterBatch(db, { batch, maxMinutes });
      iterations += 1;
      itemsBilled += result.itemsBilled;
      minutesBilled += result.minutesBilled;
      accountsUpdated += result.accountsUpdated;
      itemsSuspended += result.itemsSuspended;
      addAmounts(amounts, result.amountByCurrency);

      // Drained means a batch billed NOTHING, not a batch that came back short.
      //
      // ARCHITECTURE.md §5.4 stops on `itemsBilled < batch`, and that is wrong
      // in exactly the situation the catch-up cap creates. An item 3 days
      // behind settles 1,440 minutes and is still due; if it is the only item,
      // the batch is short on its very first pass and a short-batch test calls
      // the queue drained with two thirds of the backlog unbilled. Recovery
      // then takes one cron interval per chunk — which is the O(downtime)
      // behaviour the cap and the loop exist to remove, reintroduced in the
      // loop's exit condition.
      //
      // Caught by the "settles a long outage" test in engine.test.ts, which
      // billed 1,440 of 4,320 minutes and stopped.
      //
      // A batch of zero is unambiguous: nothing was due, or a sibling holds
      // what is left under SKIP LOCKED and is billing it. Either way there is
      // nothing here to do.
      if (result.itemsBilled === 0) {
        status = 'drained';
        break;
      }
    }
  } catch (error) {
    await settle('failed', error);
    throw error;
  }

  await settle(status);

  const report: DrainReport = {
    status,
    runId: id,
    iterations,
    itemsBilled,
    minutesBilled,
    amountByCurrency: Object.fromEntries(amounts),
    accountsUpdated,
    itemsSuspended,
    durationMs: clock().getTime() - startedAt,
  };

  if (status === 'bounded') {
    logger?.warn('metering: drain hit a bound with work outstanding', {
      iterations,
      itemsBilled,
      maxIterations,
      deadlineMs,
    });
  }

  return report;
};
