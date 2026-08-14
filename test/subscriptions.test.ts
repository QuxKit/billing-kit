// The pure half of the subscriptions module: plan validation, period pricing,
// proration, trials, and the calendar arithmetic. No database — these are the
// tests that pin down what a period costs, which is the part that has to be
// right before any of it touches a ledger.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BillingError } from '../src/errors';
import { Money, Quantity, Rate } from '../src/money';
import { addInterval, chargeForPeriod, daysInPeriod, definePlan } from '../src/subscriptions/plan.ts';

const usd = (v: string) => Money.fromDecimalString(v, 'USD');

const pro = definePlan({
  id: 'pro',
  currency: 'USD',
  interval: 'month',
  flat: usd('49.00'),
  seats: { unit: usd('10.00'), min: 1 },
  usage: [
    {
      metric: 'tokens.input',
      included: Quantity.fromBigInt(1_000_000n),
      price: { kind: 'flat', rate: Rate.fromDecimalString('0.00012') },
    },
  ],
  trialDays: 14,
});

describe('chargeForPeriod', () => {
  it('sums base, seats and metered overage', () => {
    const c = chargeForPeriod(pro, {
      seats: 3,
      usage: { 'tokens.input': Quantity.fromBigInt(1_500_000n) },
    });
    // 4900 base + 3000 seats + 500,000 units @ 0.00012 = 60 → 7960
    assert.equal(c.total.minor, 7960n);
    assert.deepEqual(
      c.lines.map((l) => l.kind),
      ['flat', 'seats', 'usage'],
    );
    assert.equal(c.lines.find((l) => l.kind === 'usage')!.amount.minor, 60n);
  });

  it('does not charge below the included allowance', () => {
    const c = chargeForPeriod(pro, {
      seats: 1,
      usage: { 'tokens.input': Quantity.fromBigInt(800_000n) },
    });
    // base + seats only; no usage line
    assert.equal(c.total.minor, 5900n);
    assert.ok(!c.lines.some((l) => l.kind === 'usage'));
  });

  it('clamps seats up to the plan minimum', () => {
    const c = chargeForPeriod(pro, { seats: 0 });
    // seats forced to min 1: 4900 + 1000
    assert.equal(c.total.minor, 5900n);
  });

  it('waives base and seats during a trial but still prices usage', () => {
    const c = chargeForPeriod(pro, {
      seats: 3,
      usage: { 'tokens.input': Quantity.fromBigInt(1_500_000n) },
      trial: true,
    });
    assert.equal(c.total.minor, 60n);
    assert.deepEqual(c.lines.map((l) => l.kind), ['usage']);
  });

  it('prorates base and seats, never usage', () => {
    const c = chargeForPeriod(pro, {
      seats: 2,
      usage: { 'tokens.input': Quantity.fromBigInt(1_500_000n) },
      proration: { activeDays: 15, periodDays: 30 },
    });
    // base 4900*15/30 = 2450, seats 2000*15/30 = 1000, usage 60 (not prorated)
    assert.equal(c.total.minor, 3510n);
  });

  it('is zero for an untouched pure-usage plan', () => {
    const payg = definePlan({
      id: 'payg',
      currency: 'USD',
      interval: 'month',
      flat: Money.zero('USD'),
      usage: [{ metric: 'requests', price: { kind: 'flat', rate: Rate.fromDecimalString('0.01') } }],
    });
    assert.equal(chargeForPeriod(payg).total.minor, 0n);
  });
});

describe('definePlan validation', () => {
  it('rejects a base fee in the wrong currency', () => {
    assert.throws(
      () =>
        definePlan({
          id: 'x',
          currency: 'USD',
          interval: 'month',
          flat: Money.fromDecimalString('1.00', 'EUR'),
          usage: [],
        }),
      (e) => BillingError.hasCode(e, 'currency_mismatch'),
    );
  });

  it('rejects a duplicate metric', () => {
    assert.throws(
      () =>
        definePlan({
          id: 'x',
          currency: 'USD',
          interval: 'month',
          flat: Money.zero('USD'),
          usage: [
            { metric: 'm', price: { kind: 'flat', rate: Rate.zero() } },
            { metric: 'm', price: { kind: 'flat', rate: Rate.zero() } },
          ],
        }),
      (e) => BillingError.hasCode(e, 'invalid_plan'),
    );
  });

  it('rejects a negative trialDays', () => {
    assert.throws(
      () =>
        definePlan({
          id: 'x',
          currency: 'USD',
          interval: 'month',
          flat: Money.zero('USD'),
          usage: [],
          trialDays: -1,
        }),
      (e) => BillingError.hasCode(e, 'invalid_plan'),
    );
  });
});

describe('interval arithmetic', () => {
  it('clamps the day when a month is shorter', () => {
    const jan31 = new Date(Date.UTC(2021, 0, 31));
    const feb = addInterval(jan31, 'month');
    assert.equal(feb.getUTCMonth(), 1); // February
    assert.equal(feb.getUTCDate(), 28); // 2021 is not a leap year
  });

  it('adds a year across a leap day', () => {
    const leap = new Date(Date.UTC(2020, 1, 29));
    const next = addInterval(leap, 'year');
    assert.equal(next.getUTCFullYear(), 2021);
    assert.equal(next.getUTCMonth(), 1);
    assert.equal(next.getUTCDate(), 28);
  });

  it('counts whole days in a period', () => {
    assert.equal(daysInPeriod(new Date(Date.UTC(2021, 0, 1)), new Date(Date.UTC(2021, 1, 1))), 31);
  });
});
