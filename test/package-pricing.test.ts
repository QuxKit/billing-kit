// pricePackage and the plan overage strategy built on it. Pure money math —
// no database. The property under test is the one the per-unit workaround got
// wrong: "per 1,000, rounded up" bills 1,001 units as two whole packages, in
// integer arithmetic with zero residue, and the fractional variant rounds
// exactly once like every other price in the library.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BillingError } from '../src/errors';
import { Money, pricePackage, Quantity } from '../src/money';
import { chargeForPeriod, definePlan } from '../src/subscriptions/plan.ts';

const usd = (v: string) => Money.fromDecimalString(v, 'USD');
const q = (v: string | bigint) => (typeof v === 'bigint' ? Quantity.fromBigInt(v) : Quantity.fromDecimalString(v));
const per1000 = { unitsPerPackage: q(1000n), pricePerPackage: usd('2.00'), roundUp: true };

describe('pricePackage', () => {
  it('rounds a partial package up to a whole one', () => {
    assert.equal(pricePackage(q(1n), per1000).amount.toDecimalString(), '2.00');
    assert.equal(pricePackage(q(999n), per1000).amount.toDecimalString(), '2.00');
    assert.equal(pricePackage(q(1000n), per1000).amount.toDecimalString(), '2.00');
    assert.equal(
      pricePackage(q(1001n), per1000).amount.toDecimalString(),
      '4.00',
      'the case the per-unit rate got wrong',
    );
    assert.equal(pricePackage(q(2500n), per1000).amount.toDecimalString(), '6.00');
  });

  it('charges zero packages for zero usage, and is exact (no residue) when rounding up', () => {
    const zero = pricePackage(q(0n), per1000);
    assert.equal(zero.amount.toDecimalString(), '0.00');
    const r = pricePackage(q(1001n), per1000);
    assert.match(r.residueMinor, /^0\.0+$/);
    assert.match(r.exactMinor, /^400\.0+$/);
  });

  it('handles fractional quantities and fractional package sizes', () => {
    // 0.5 units per package: 1.2 units is 2.4 packages -> 3 packages.
    const half = { unitsPerPackage: q('0.5'), pricePerPackage: usd('1.00'), roundUp: true };
    assert.equal(pricePackage(q('1.2'), half).amount.toDecimalString(), '3.00');
    assert.equal(
      pricePackage(q('1000.000000000001'), per1000).amount.toDecimalString(),
      '4.00',
      'any excess is a package',
    );
  });

  it('prices fractional packages exactly when roundUp is false, rounding once half-to-even', () => {
    const frac = { ...per1000, roundUp: false };
    assert.equal(pricePackage(q(1001n), frac).amount.toDecimalString(), '2.00', '2.002 -> 200.2 minor -> 200');
    assert.equal(pricePackage(q(1500n), frac).amount.toDecimalString(), '3.00');
    const r = pricePackage(q(1001n), frac);
    assert.match(r.exactMinor, /^200\.2/);
    assert.match(r.residueMinor, /^0\.2/);
    // Half-to-even at the boundary: 1002.5 units -> 200.5 minor -> 200 (even).
    assert.equal(pricePackage(q('1002.5'), frac).amount.minor, 200n);
    assert.equal(pricePackage(q('1007.5'), frac).amount.minor, 202n, '201.5 -> 202');
  });

  it('refuses nonsense with typed errors', () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
        return null;
      } catch (e) {
        return BillingError.is(e) ? e.code : String(e);
      }
    };
    assert.equal(
      code(() => pricePackage(q(-1n), per1000)),
      'invalid_tiers',
    );
    assert.equal(
      code(() => pricePackage(q(1n), { ...per1000, unitsPerPackage: q(0n) })),
      'invalid_tiers',
    );
    assert.equal(
      code(() => pricePackage(q(1n), { ...per1000, unitsPerPackage: q(-5n) })),
      'invalid_tiers',
    );
    assert.equal(
      code(() => pricePackage(q(1n), { ...per1000, pricePerPackage: usd('-2.00') })),
      'invalid_tiers',
    );
  });
});

describe('package as a plan overage strategy', () => {
  const plan = definePlan({
    id: 'sms',
    currency: 'USD',
    interval: 'month',
    flat: usd('10.00'),
    usage: [
      {
        metric: 'sms',
        included: q(500n),
        price: { kind: 'package', package: { unitsPerPackage: q(500n), pricePerPackage: usd('1.50'), roundUp: true } },
      },
    ],
  });

  it('bills overage in whole packages after the included allowance', () => {
    const none = chargeForPeriod(plan, { usage: { sms: q(500n) } });
    assert.equal(none.total.toDecimalString(), '10.00', 'allowance covers it');
    const one = chargeForPeriod(plan, { usage: { sms: q(501n) } });
    assert.deepEqual(
      one.lines.map((l) => [l.kind, l.amount.toDecimalString()]),
      [
        ['flat', '10.00'],
        ['usage', '1.50'],
      ],
    );
    const many = chargeForPeriod(plan, { usage: { sms: q(1_800n) } });
    assert.equal(many.total.toDecimalString(), '14.50', '1300 over -> 3 packages');
    assert.equal(many.lines[1].quantity?.toDecimalString(), '1300.000000000000');
  });

  it('definePlan validates the package definition', () => {
    const base = { id: 'p', currency: 'USD', interval: 'month' as const, flat: usd('0.00') };
    assert.throws(
      () =>
        definePlan({
          ...base,
          usage: [
            {
              metric: 'm',
              price: {
                kind: 'package',
                package: { unitsPerPackage: q(0n), pricePerPackage: usd('1.00'), roundUp: true },
              },
            },
          ],
        }),
      (e: unknown) => BillingError.hasCode(e, 'invalid_plan'),
    );
    assert.throws(
      () =>
        definePlan({
          ...base,
          usage: [
            {
              metric: 'm',
              price: {
                kind: 'package',
                package: {
                  unitsPerPackage: q(10n),
                  pricePerPackage: Money.fromDecimalString('1.00', 'EUR'),
                  roundUp: true,
                },
              },
            },
          ],
        }),
      (e: unknown) => BillingError.hasCode(e, 'currency_mismatch'),
    );
    assert.throws(
      () =>
        definePlan({
          ...base,
          usage: [
            {
              metric: 'm',
              price: {
                kind: 'package',
                package: { unitsPerPackage: q(10n), pricePerPackage: usd('-1.00'), roundUp: true },
              },
            },
          ],
        }),
      (e: unknown) => BillingError.hasCode(e, 'invalid_plan'),
    );
  });
});
