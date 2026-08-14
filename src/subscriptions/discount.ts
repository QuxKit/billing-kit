// Coupons and discounts — a modifier applied to a charge before it is posted.
//
// A discount is money math (a percentage of, or a fixed amount off, a Money) and
// it rounds through `scaleFraction`, the one place proration rounds, so a
// percentage discount cannot drift from the amount it discounts. A coupon wraps
// a rule with a duration — once, forever, or the first N periods — so the common
// "20% off for three months" is expressible without the caller re-deriving it.

import { BillingError } from '../errors.ts';
import { Money, scaleFraction } from '../money.ts';

/**
 * How much to take off.
 *
 * `percent` is basis points — an integer, 2000 = 20% — never a float, for the
 * same reason a rate is never a float: 0.2 is not 0.2, and a discount that
 * drifts is a discount an auditor cannot reproduce.
 */
export type DiscountRule =
  | { kind: 'percent'; bps: number }
  | { kind: 'amount'; off: Money };

/**
 * The discount amount for `amount` under a rule — a positive `Money` to subtract.
 *
 * Never more than the amount itself: a coupon cannot turn a bill negative and
 * hand the customer money, so a fixed discount larger than the charge is clamped
 * to the charge. A percentage rounds half-to-even through `scaleFraction`.
 */
export function applyDiscount(amount: Money, rule: DiscountRule): Money {
  if (amount.isNegative()) {
    throw new BillingError({ code: 'invalid_allocation', reason: 'cannot discount a negative amount' });
  }
  if (rule.kind === 'percent') {
    if (!Number.isInteger(rule.bps) || rule.bps < 0 || rule.bps > 10_000) {
      throw new BillingError({ code: 'invalid_plan', reason: 'discount bps must be an integer in 0..10000' });
    }
    return scaleFraction(amount, BigInt(rule.bps), 10_000n);
  }
  if (rule.off.currency !== amount.currency) {
    throw new BillingError({ code: 'currency_mismatch', left: amount.currency, right: rule.off.currency });
  }
  if (rule.off.isNegative()) {
    throw new BillingError({ code: 'invalid_plan', reason: 'discount amount must be positive' });
  }
  return rule.off.compare(amount) > 0 ? amount : rule.off;
}

/** How long a coupon applies from the period it is first redeemed in. */
export type CouponDuration = 'once' | 'forever' | { periods: number };

export interface Coupon {
  id: string;
  rule: DiscountRule;
  duration: CouponDuration;
}

/**
 * The rule to apply for a given period, or null when the coupon has run out.
 *
 * `periodIndex` is 0-based from redemption: 0 is the first period the coupon
 * applies to. `once` is that period only; `{ periods: 3 }` is the first three;
 * `forever` never returns null. The caller tracks the index (it is how many
 * periods this subscription has been charged with the coupon); keeping it a
 * pure function of the index means no clock and no storage live in here.
 */
export function discountForPeriod(coupon: Coupon, periodIndex: number): DiscountRule | null {
  if (periodIndex < 0) return null;
  if (coupon.duration === 'forever') return coupon.rule;
  if (coupon.duration === 'once') return periodIndex === 0 ? coupon.rule : null;
  return periodIndex < coupon.duration.periods ? coupon.rule : null;
}
