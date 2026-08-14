// The subscriptions surface, bound to one executor and clock.
//
// Same argument as src/instance.ts and src/metering/instance.ts: the free
// functions take (db, ..., now) and an application that has one executor and one
// clock repeats that wiring at every call. This binds them once. The free
// functions remain the API; this is a convenience over them, never a different
// one.

import { chargeSubscriptionPeriod } from './settle.ts';
import type { ChargePeriodInput, ChargePeriodResult } from './settle.ts';
import {
  cancelSubscription,
  createSubscription,
  getSubscription,
} from './store.ts';
import type { CreateSubscriptionInput, SubscriptionRef } from './store.ts';
import { chargeDueSubscriptions, dueSubscriptions } from './sweep.ts';
import type { DueQuery, SweepOptions, SweepReport } from './sweep.ts';
import type { Clock, SqlExecutor, TenantId } from '../types.ts';
import type { CancelWhen, Subscription } from './types.ts';

export interface SubscriptionsOptions {
  db: SqlExecutor;
  /** Defaults to the system clock. */
  clock?: Clock;
}

export interface Subscriptions {
  createSubscription(input: CreateSubscriptionInput): Promise<Subscription>;
  getSubscription(ref: SubscriptionRef): Promise<Subscription | null>;
  cancelSubscription(ref: { tenantId: TenantId; id: string }, when: CancelWhen): Promise<Subscription>;
  /** Charge the current period and advance. `now` may still be overridden per
   *  call — a backfill that charges an old period is exactly that case. */
  chargeSubscriptionPeriod(input: ChargePeriodInput): Promise<ChargePeriodResult>;
  /** The subscriptions whose period has ended. What a cron fires against. */
  dueSubscriptions(query?: DueQuery): Promise<Subscription[]>;
  /** Charge everything due. The one call an authenticated cron endpoint makes. */
  chargeDueSubscriptions(opts: SweepOptions): Promise<SweepReport>;
}

export function createSubscriptions(opts: SubscriptionsOptions): Subscriptions {
  const { db } = opts;
  const clock: Clock = opts.clock ?? (() => new Date());

  return {
    createSubscription: (input) => createSubscription(db, input, clock()),
    getSubscription: (ref) => getSubscription(db, ref),
    cancelSubscription: (ref, when) => cancelSubscription(db, ref, when, clock()),
    chargeSubscriptionPeriod: (input) =>
      chargeSubscriptionPeriod(db, { ...input, now: input.now ?? clock() }),
    dueSubscriptions: (query) => dueSubscriptions(db, { ...query, now: query?.now ?? clock() }),
    chargeDueSubscriptions: (opts) =>
      chargeDueSubscriptions(db, { ...opts, now: opts.now ?? clock() }),
  };
}
