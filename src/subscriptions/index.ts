// billing-kit/subscriptions — recurring plans, priced on our side of the settle
// line and posted to the ledger.
//
// A separate entry point, like `billing-kit/metering` and `billing-kit/providers`,
// so an application that only records usage does not compile the subscription
// scheduler, and an application that only sells subscriptions does not carry the
// metering driver. The pricing half (`definePlan`, `chargeForPeriod`) is pure
// and needs no database; the store and `chargeSubscriptionPeriod` are the only
// parts that touch one.
//
// What this does NOT do, on purpose: it does not capture money. A charged period
// posts an accrual to the ledger — our number, our record — and the provider
// still settles and captures it, the same division the rest of the library
// keeps. There is no path here that credits a balance from anything but a
// verified payment webhook.

export { definePlan, chargeForPeriod, addInterval, daysInPeriod } from './plan.ts';

export { createSubscription, getSubscription, cancelSubscription } from './store.ts';
export type { CreateSubscriptionInput, SubscriptionRef } from './store.ts';

export { chargeSubscriptionPeriod } from './settle.ts';
export type { ChargePeriodInput, ChargePeriodResult } from './settle.ts';

export { createSubscriptions } from './instance.ts';
export type { Subscriptions, SubscriptionsOptions } from './instance.ts';

export type {
  BillingInterval,
  CancelWhen,
  ChargeLine,
  PeriodCharge,
  PeriodChargeInput,
  Plan,
  PlanSeats,
  PlanUsage,
  Subscription,
  SubscriptionState,
  UsagePrice,
} from './types.ts';
