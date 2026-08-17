// Subscriptions: the recurring-plan half of billing, owned here rather than
// delegated to the provider.
//
// The library already delegates `ensureSubscription` to a provider, and for
// "let Stripe bill $49/mo" that is right. But a plan that mixes a base fee,
// seats, an included allowance and metered overage is billing *logic*, and by
// the same argument the ledger makes — you must be able to answer "why is this
// number" from your own tables — that logic belongs on our side of the settle
// line. This module computes what a period costs; the provider still captures
// the money.
//
// Everything here is a type. The pricing (`plan.ts`) is pure and testable with
// no database; persistence (`store.ts`, `settle.ts`) is the only part that
// needs one.

import type { Money, Quantity, Rate, Tier, TierMode } from '../money.ts';
import type { SubjectId, TenantId } from '../types.ts';
import type { DiscountRule } from './discount.ts';

/** How often a plan renews. Interval arithmetic is calendar-aware (see plan.ts). */
export type BillingInterval = 'day' | 'week' | 'month' | 'year';

/**
 * How one metric's usage is priced once the included allowance is spent.
 *
 * `flat` is a single rate for every unit; `tiered` is volume or graduated over
 * `Tier`s — the same primitives as `priceTiered`, so a plan's overage rounds in
 * exactly the one place the rest of the library rounds.
 */
export type UsagePrice = { kind: 'flat'; rate: Rate } | { kind: 'tiered'; mode: TierMode; tiers: readonly Tier[] };

export interface PlanUsage {
  /** The metric this prices — matches a metering `metric` (`tokens.input`). */
  metric: string;
  /** Granted free each period before overage is charged. Omit for none. */
  included?: Quantity;
  price: UsagePrice;
}

/**
 * What a plan entitles a subscriber to, beyond the usage it prices.
 *
 * `true` is a boolean gate: the plan has it or it does not (`sso`,
 * `audit_log`). A metered feature is an allowance per period over a metric —
 * `{ limit: 100, meter: 'exports' }` — checked against `aggregateUsage` for the
 * current period. What happens past the limit is `overage`:
 *
 *   'deny'      refuse. The default when the plan does not price the meter.
 *   'postpaid'  allow; the overage is priced by the plan's `usage` component
 *               for the same metric. The default when it does.
 *   'wallet'    allow while the subject's prepaid wallet holds a positive
 *               balance; refuse when it is empty.
 */
export type PlanFeature =
  | true
  | {
      limit: Quantity;
      meter: string;
      /** How the meter's events are collapsed. Default `sum`. */
      method?: 'sum' | 'count' | 'max';
      overage?: 'deny' | 'postpaid' | 'wallet';
    };

export interface PlanSeats {
  /** Price per seat per period. */
  unit: Money;
  /** Minimum billable seats regardless of how few are assigned. Default 0. */
  min?: number;
}

/**
 * A plan, defined in code and validated by `definePlan`.
 *
 * Held by the caller, not persisted by billing-kit — the plan catalogue is the
 * application's, the same way the rate is a column in metering. A subscription
 * row references a plan by `id`; the object is passed back in at charge time.
 */
export interface Plan {
  id: string;
  currency: string;
  interval: BillingInterval;
  /** Recurring base fee. `Money.zero` for a pure pay-as-you-go plan. */
  flat: Money;
  seats?: PlanSeats;
  usage: readonly PlanUsage[];
  /** Feature gates and per-period allowances. See `PlanFeature`. */
  features?: Readonly<Record<string, PlanFeature>>;
  /** Free days at the start; the period a subscription begins in charges no
   *  base or seat fee. Usage in that period is still priced. Omit for none. */
  trialDays?: number;
}

/** One line of a period's charge, kept separate so an invoice can show them. */
export interface ChargeLine {
  kind: 'flat' | 'seats' | 'usage' | 'discount';
  description: string;
  amount: Money;
  /** Present on usage and seat lines. */
  metric?: string;
  quantity?: Quantity;
  /** Present on usage lines: the exact pre-rounding value, for audit. */
  residueMinor?: string;
}

/** What a period costs, broken into lines that sum to `total`. */
export interface PeriodCharge {
  currency: string;
  lines: readonly ChargeLine[];
  total: Money;
}

export interface PeriodChargeInput {
  /** Assigned seats this period. Clamped up to the plan's `seats.min`. */
  seats?: number;
  /** Metered usage for the period, by metric. Missing metrics count as zero. */
  usage?: Readonly<Record<string, Quantity>>;
  /**
   * Charge only a fraction of the base and seat fees — for a subscription that
   * was active for part of the period (a mid-period start, or a cancellation).
   * Usage is consumption and is never prorated. Omit for a full period.
   */
  proration?: { activeDays: number; periodDays: number };
  /** This period is within the trial: waive base and seats. Usage still priced. */
  trial?: boolean;
  /**
   * A discount applied to this period's charge, after base, seats and usage are
   * summed — the coupon a subscription redeemed. Use `discountForPeriod` to turn
   * a time-limited coupon into the rule (or nothing) for the period being billed.
   */
  discount?: DiscountRule;
}

export type SubscriptionState = 'trialing' | 'active' | 'canceled';

/** When a cancellation takes effect. */
export type CancelWhen = 'immediately' | 'period_end';

/** A subscription instance — the persisted state a plan is billed against. */
export interface Subscription {
  id: string;
  tenantId: TenantId;
  subjectId: SubjectId;
  /** The caller's idempotency key for creation. Unique per tenant. */
  key: string;
  planId: string;
  currency: string;
  state: SubscriptionState;
  seats: number;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  trialEnd: Date | null;
  startedAt: Date;
  canceledAt: Date | null;
  cancelAtPeriodEnd: boolean;
}
