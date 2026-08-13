// What the metering driver takes and what it gives back.
//
// Plain data both ways, per API rule 1. Nothing here is a framework type,
// nothing here reads process.env, and there is no module-level state — a
// library that reads the environment cannot be instantiated twice in one
// process, and a test suite and a multi-region worker both need exactly that.

import type { Clock, Logger, SqlExecutor } from '../types.ts';

/**
 * Minor-unit totals, keyed by ISO 4217 code.
 *
 * A map and not a single total because a sum across currencies is a category
 * error that reads like a number: nothing rejects it, the dashboard renders it,
 * and it is wrong by whatever the exchange rate happens to be.
 *
 * `bigint` and not `number`, for the reason in ARCHITECTURE.md §3.2 — the one
 * that actually bites is not magnitude but that float addition is not
 * associative, so a total computed twice from the same rows can differ and the
 * ledger stops being re-derivable.
 */
export type AmountByCurrency = Readonly<Record<string, bigint>>;

/** One call to billing.meter_batch. */
export interface BatchResult {
  itemsBilled: number;
  minutesBilled: bigint;
  amountByCurrency: AmountByCurrency;
  accountsUpdated: number;
  itemsSuspended: number;
}

export interface BatchOptions {
  /** Items locked and settled per call. Bounds the transaction. */
  batch?: number;
  /** Minutes settled per item per call. Bounds a catch-up. */
  maxMinutes?: number;
}

export interface DrainOptions extends BatchOptions {
  db: SqlExecutor;

  /**
   * Wall-clock bound on the whole loop. Checked between batches, never inside
   * one: a deadline that could interrupt a batch would be a deadline that can
   * abandon a transaction holding locks on every item in it.
   */
  deadlineMs?: number;

  /**
   * Hard bound on iterations, independent of the deadline.
   *
   * Both, because they fail differently. The deadline does not bound work when
   * batches are fast, and the iteration cap does not bound time when a batch is
   * slow. A drain that keeps one of them keeps neither.
   */
  maxIterations?: number;

  /**
   * How long the lease survives without a heartbeat. Must comfortably exceed
   * the time one batch takes, or a slow batch loses the lease to a second
   * worker while still holding item locks.
   */
  leaseMs?: number;

  /** Identifies this worker in billing.meter_runs. Pod name, hostname, ordinal. */
  runner?: string;

  /**
   * Create partitions before draining. On by default: `charges` is partitioned
   * with no default-free guarantee that next month exists, and the cost of the
   * check when there is nothing to do is one catalog lookup per parent.
   */
  ensurePartitions?: boolean;

  /** Driver timeouts and tests only. Never an interval boundary — see driver.ts. */
  clock?: Clock;

  logger?: Logger;
}

export type DrainStatus =
  /** The queue emptied. The steady state. */
  | 'drained'
  /**
   * A bound was hit with work still outstanding. Not an error: progress is
   * durable per batch, so the next run resumes exactly where this one stopped.
   * It is reported rather than swallowed because a drain that never drains is
   * how you learn the batch size or the schedule is wrong, and it is the only
   * symptom you get.
   */
  | 'bounded'
  /** Another worker holds the lease. Also not an error. */
  | 'skipped'
  /**
   * The lease was taken away mid-drain — the heartbeat found the run no longer
   * 'running'. Reported as its own outcome rather than folded into 'bounded',
   * because it means two workers were briefly eligible to bill at once and the
   * lease interval is too short for how long a batch actually takes. That is a
   * configuration fault with a specific fix, and it is invisible if it is
   * reported as the same thing as a normal early exit.
   */
  | 'lease_lost';

export interface DrainReport {
  status: DrainStatus;
  /** Null only when the lease was not obtained, in which case nothing ran. */
  runId: string | null;
  iterations: number;
  itemsBilled: number;
  minutesBilled: bigint;
  amountByCurrency: AmountByCurrency;
  accountsUpdated: number;
  itemsSuspended: number;
  durationMs: number;
}

export interface PartitionRow {
  parent: string;
  partitionName: string;
  isDefault: boolean;
  bounds: string;
  liveRows: bigint;
}

export type HealthFault = Readonly<Record<string, unknown>> & { fault: string };

export interface MeteringHealth {
  ok: boolean;
  faults: readonly HealthFault[];
}
