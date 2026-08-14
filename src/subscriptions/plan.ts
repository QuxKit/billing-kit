// Plan definition, period pricing, and the calendar arithmetic a recurring
// plan needs. All pure: no database, no clock beyond the dates handed in.

import { BillingError } from '../errors.ts';
import { Money, Quantity, currencyExponent, price, priceTiered, scaleFraction } from '../money.ts';
import { applyDiscount } from './discount.ts';
import type {
  BillingInterval,
  ChargeLine,
  PeriodCharge,
  PeriodChargeInput,
  Plan,
} from './types.ts';

/**
 * Validate a plan and return a frozen copy.
 *
 * Refusing a malformed plan here, once, is cheaper than discovering at the
 * first charge that a seat price is in the wrong currency. What it cannot check
 * cheaply — that tiered overage is well formed — is validated when it is priced,
 * by `priceTiered`, so nothing is left unchecked; it is only checked later.
 */
export function definePlan(input: Plan): Plan {
  currencyExponent(input.currency); // throws unknown_currency

  const bad = (reason: string): never => {
    throw new BillingError({ code: 'invalid_plan', reason });
  };

  if (!input.id) bad('id is empty');
  if (!['day', 'week', 'month', 'year'].includes(input.interval)) bad(`unknown interval ${input.interval}`);

  if (input.flat.currency !== input.currency) {
    throw new BillingError({ code: 'currency_mismatch', left: input.currency, right: input.flat.currency });
  }
  if (input.flat.isNegative()) bad('base fee is negative');

  if (input.seats) {
    if (input.seats.unit.currency !== input.currency) {
      throw new BillingError({ code: 'currency_mismatch', left: input.currency, right: input.seats.unit.currency });
    }
    if (input.seats.unit.isNegative()) bad('seat price is negative');
    if ((input.seats.min ?? 0) < 0 || !Number.isInteger(input.seats.min ?? 0)) bad('seat minimum must be a non-negative integer');
  }

  const seen = new Set<string>();
  for (const u of input.usage) {
    if (!u.metric) bad('a usage component has an empty metric');
    if (seen.has(u.metric)) bad(`metric ${u.metric} appears twice`);
    seen.add(u.metric);
    if (u.included && u.included.isNegative()) bad(`included allowance for ${u.metric} is negative`);
  }

  if (input.trialDays !== undefined && (!Number.isInteger(input.trialDays) || input.trialDays < 0)) {
    bad('trialDays must be a non-negative integer');
  }

  return Object.freeze({
    ...input,
    usage: Object.freeze([...input.usage]),
  });
}

/**
 * What one period of a plan costs, as lines that sum to a total.
 *
 * Pure and side-effect-free, so it can be tested without a database and shown
 * to a customer as a preview before anything is posted. The base and seat fees
 * prorate; usage never does, because usage is what was consumed, not a fee for
 * access. During a trial the base and seats are waived and usage is still
 * priced — the plan sold the metered product, not free consumption of it.
 */
export function chargeForPeriod(plan: Plan, input: PeriodChargeInput = {}): PeriodCharge {
  const currency = plan.currency;
  const lines: ChargeLine[] = [];
  const trial = input.trial === true;
  const pro = input.proration;

  if (pro && (pro.periodDays <= 0 || pro.activeDays < 0 || !Number.isInteger(pro.activeDays) || !Number.isInteger(pro.periodDays))) {
    throw new BillingError({ code: 'invalid_subscription', reason: 'invalid proration window' });
  }
  const prorate = (m: Money): Money =>
    pro && pro.activeDays < pro.periodDays ? scaleFraction(m, BigInt(pro.activeDays), BigInt(pro.periodDays)) : m;

  if (!trial && !plan.flat.isZero()) {
    lines.push({ kind: 'flat', description: `${plan.id} base`, amount: prorate(plan.flat) });
  }

  if (!trial && plan.seats) {
    const count = Math.max(input.seats ?? 0, plan.seats.min ?? 0);
    if (count > 0) {
      const gross = plan.seats.unit.timesInteger(BigInt(count));
      lines.push({
        kind: 'seats',
        description: `${count} seat${count === 1 ? '' : 's'}`,
        amount: prorate(gross),
        quantity: Quantity.fromBigInt(BigInt(count)),
      });
    }
  }

  const usage = input.usage ?? {};
  for (const comp of plan.usage) {
    const metered = usage[comp.metric] ?? Quantity.zero();
    const billable = metered.minus(comp.included ?? Quantity.zero());
    if (billable.isNegative() || billable.isZero()) continue; // allowance covered it

    const priced =
      comp.price.kind === 'flat'
        ? price(billable, comp.price.rate, currency)
        : priceTiered(billable, comp.price.tiers, comp.price.mode, currency);
    if (priced.amount.isZero()) continue;

    lines.push({
      kind: 'usage',
      metric: comp.metric,
      description: `${comp.metric} overage`,
      amount: priced.amount,
      quantity: billable,
      residueMinor: priced.residueMinor,
    });
  }

  // A discount applies to the subtotal of everything charged so far. It is added
  // as a negative line, so the returned lines still sum to the total and an
  // invoice can show "−$10.00 coupon" as its own row.
  if (input.discount) {
    const subtotal = lines.length === 0 ? Money.zero(currency) : Money.sum(lines.map((l) => l.amount), currency);
    if (subtotal.isPositive()) {
      const off = applyDiscount(subtotal, input.discount);
      if (off.isPositive()) {
        lines.push({ kind: 'discount', description: 'discount', amount: off.negate() });
      }
    }
  }

  const total = lines.length === 0 ? Money.zero(currency) : Money.sum(lines.map((l) => l.amount), currency);
  return { currency, lines, total };
}

// --- calendar arithmetic ----------------------------------------------------

const DAY_MS = 86_400_000;

/**
 * Advance a date by one billing interval, in UTC.
 *
 * Month and year addition clamp the day rather than overflowing: one month
 * after Jan 31 is the last day of February, not March 3rd. Overflowing is the
 * default `setUTCMonth` behaviour and it silently moves a renewal date, so it
 * is corrected here.
 */
export function addInterval(from: Date, interval: BillingInterval, count = 1): Date {
  const d = new Date(from.getTime());
  switch (interval) {
    case 'day':
      d.setUTCDate(d.getUTCDate() + count);
      return d;
    case 'week':
      d.setUTCDate(d.getUTCDate() + 7 * count);
      return d;
    case 'month':
      return addMonths(d, count);
    case 'year':
      return addMonths(d, 12 * count);
  }
}

function addMonths(d: Date, months: number): Date {
  const day = d.getUTCDate();
  const target = new Date(d.getTime());
  target.setUTCDate(1); // avoid rolling over while we move the month
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}

/** Whole days in [start, end). Both are period boundaries produced by addInterval. */
export function daysInPeriod(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / DAY_MS);
}
