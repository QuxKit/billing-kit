// The metering engine: billing for the passage of time.
//
// For subscriptions priced by elapsed minutes — a running container, a
// provisioned database — where the usage event is that a minute went by and
// there is no client to emit it. Event-based metering (`billing.usage.record`)
// is the other half of the library and does not go through here.
//
//   await ensurePartitions(db);          // idempotent; drain does it for you
//   const report = await drain({ db });  // loop until the queue is empty
//
// The engine itself is SQL, in sql/010..013. This module is the driver and the
// types. Nothing here decides what anything costs; the rate is a column.
//
// What is deliberately NOT exported:
//
//   - Any HTTP endpoint. `drain` is a function. How it is triggered and how
//     that trigger is authenticated belong to the host, and the reference
//     application's cron route with its shared-secret check commented out is
//     the argument: a library cannot ship an endpoint that looks safe and have
//     the host's edits to it be the library's problem.
//   - Anything that credits a balance. Cash posts to the ledger from a verified
//     provider webhook and from nowhere else. There is no credit(amount) here
//     to be called from a request body.

export { drain, ensurePartitions, health, meterBatch, partitionReport } from './driver.ts';
export type { BoundDrainOptions, Metering, MeteringOptions } from './instance.ts';
export { createMetering } from './instance.ts';

export type {
  AmountByCurrency,
  BatchOptions,
  BatchResult,
  DrainOptions,
  DrainReport,
  DrainStatus,
  HealthFault,
  MeteringHealth,
  PartitionRow,
} from './types.ts';
