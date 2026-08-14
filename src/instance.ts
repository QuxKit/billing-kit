// The executor and the clock, bound once.
//
// Every core function takes `(db, …, now)`. That is the right shape for the
// functions — configuration as an argument, never a module-level global and
// never `process.env`, so the library can be instantiated twice in one process
// — and it is a poor shape for a call site, which repeats the wiring on every
// line:
//
//   await record(db, event, new Date());
//
// Look at the third argument. `Clock` exists so tests and driver timeouts do
// not depend on wall-clock drift, and passing `new Date()` inline defeats it at
// exactly the place the drift would show. Whatever the docs say, that line is
// what people copy.
//
// So this binds both, once:
//
//   const billing = createBilling({ db });
//   await billing.record(event);
//
// A factory, not a singleton. Two instances in one process is the case that
// matters — a test suite that wants a rolled-back executor per case, a worker
// that spans regions, a tenant sharded onto its own database — and a module
// that holds the connection can serve exactly one of them. `drain` in
// metering/driver.ts already takes `{ db, clock, logger }` for the same reason;
// this is that shape applied to the rest.
//
// The free functions stay exported. This is sugar over them, not a replacement:
// anyone holding a transaction, or dispatching across shards per call, still
// wants the argument.

import { record, recordMany, queryUsage } from './events';
import { post, balance, entries } from './ledger';
import type {
  Clock,
  LedgerEntry,
  LedgerPosting,
  Logger,
  PostedTransaction,
  RecordedEvent,
  SqlExecutor,
  UsageEvent,
} from './types';
import type { StoredUsageEvent, UsageQuery } from './events';
import type { BalanceQuery, EntriesQuery } from './ledger';
import type { Money } from './money';

export interface BillingOptions {
  db: SqlExecutor;
  /**
   * Defaults to the system clock.
   *
   * Supplied by tests and by anything that has to reason about a period
   * boundary from outside the process — the reason `now` is a parameter at all.
   */
  clock?: Clock;
  /** Carried for the surfaces that take one, and for `transaction` to pass on. */
  logger?: Logger;
}

/**
 * The bound surface.
 *
 * Deliberately only events and the ledger. Metering is a separate entry point
 * (`billing-kit/metering`) and importing it here would undo that: an
 * application that meters nothing and settles through one provider should not
 * load the metering driver to call `record`. `createMetering` is that entry
 * point's own factory.
 */
export interface Billing {
  record(event: UsageEvent): Promise<RecordedEvent>;
  recordMany(events: readonly UsageEvent[]): Promise<RecordedEvent[]>;
  queryUsage(q: UsageQuery): Promise<StoredUsageEvent[]>;

  post(posting: LedgerPosting): Promise<PostedTransaction>;
  balance(q: BalanceQuery): Promise<Money>;
  entries(q: EntriesQuery): Promise<LedgerEntry[]>;

  /**
   * Run several of these against one transaction.
   *
   * The thing that is genuinely awkward without it: recording usage and posting
   * the accrual for it are two writes that should not be able to disagree, and
   * committing them separately is how a ledger ends up describing usage that
   * was never recorded. Threading `tx` by hand is possible today; nothing
   * reminds you to.
   *
   * The instance handed to `fn` is bound to the transaction's executor, which
   * `SqlExecutor.transaction` pins to a single connection — so every call
   * inside the callback lands in the same transaction, and none of them can
   * quietly escape onto another pool connection.
   */
  transaction<T>(fn: (billing: Billing) => Promise<T>): Promise<T>;

  /** The executor this instance is bound to. Exposed for the free functions. */
  readonly db: SqlExecutor;
  /** The clock this instance reads `now` from. */
  readonly clock: Clock;
}

const systemClock: Clock = () => new Date();

export function createBilling(options: BillingOptions): Billing {
  const { db, logger } = options;
  const clock = options.clock ?? systemClock;

  // Read per call rather than captured once: a clock is a function precisely so
  // that time can move, and an instance built at boot must not pin `now` to
  // the moment the process started.
  const billing: Billing = {
    db,
    clock,

    record: (event) => record(db, event, clock()),
    recordMany: (events) => recordMany(db, events, clock()),
    queryUsage: (q) => queryUsage(db, q),

    post: (posting) => post(db, posting, clock()),
    balance: (q) => balance(db, q),
    entries: (q) => entries(db, q),

    transaction: <T>(fn: (b: Billing) => Promise<T>): Promise<T> =>
      db.transaction((tx) => fn(createBilling({ db: tx, clock, logger }))),
  };

  return billing;
}
