// The metering surface, bound to one executor.
//
// The same argument as src/instance.ts: `meterBatch(db, opts)` and friends
// repeat the wiring, and a worker that drains on a timer holds one executor for
// its whole life. `drain` already took `{ db, clock, logger }`, so this is
// mostly making the other four agree with it.
//
//   const metering = createMetering({ db });
//   await metering.ensurePartitions();
//   const report = await metering.drain();
//
// It lives here rather than in the core factory on purpose. `createBilling` is
// in the root entry point, and importing this from there would pull the
// metering driver into every application that only records events — which is
// the separation the two entry points exist to keep.

import type { Clock, Logger, SqlExecutor } from '../types.ts';
import { drain, ensurePartitions, health, meterBatch, partitionReport } from './driver.ts';
import type { BatchOptions, BatchResult, DrainOptions, DrainReport, MeteringHealth, PartitionRow } from './types.ts';

export interface MeteringOptions {
  db: SqlExecutor;
  /** Defaults to the system clock. Passed through to `drain`. */
  clock?: Clock;
  logger?: Logger;
}

/**
 * `drain` without the parts this instance already holds.
 *
 * Callers may still override the clock or logger per call — a backfill that
 * replays an old period is exactly that case — so they are omitted rather than
 * forbidden.
 */
export type BoundDrainOptions = Omit<DrainOptions, 'db'>;

export interface Metering {
  drain(options?: BoundDrainOptions): Promise<DrainReport>;
  meterBatch(options?: BatchOptions): Promise<BatchResult>;
  ensurePartitions(options?: { monthsAhead?: number; monthsBehind?: number }): Promise<number>;
  partitionReport(): Promise<PartitionRow[]>;
  health(): Promise<MeteringHealth>;

  readonly db: SqlExecutor;
}

export function createMetering(options: MeteringOptions): Metering {
  const { db, clock, logger } = options;

  return {
    db,

    // Per-call options win over the instance's, so a backfill can hand in its
    // own clock without building a second instance to hold it.
    drain: (o = {}) => drain({ clock, logger, ...o, db }),

    meterBatch: (o = {}) => meterBatch(db, o),
    ensurePartitions: (o = {}) => ensurePartitions(db, o),
    partitionReport: () => partitionReport(db),
    health: () => health(db),
  };
}
