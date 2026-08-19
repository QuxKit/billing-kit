// Display formatting.
//
// The property that matters most is the one asserted last: formatting must not
// be able to change what a value *is*. Everything else here is arithmetic on
// strings.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  displayDefaults,
  formatMoney,
  formatQuantity,
  formatRate,
  Money,
  Quantity,
  Rate,
  setDisplayDefaults,
} from '../src/index';

test('a quantity shows two places instead of twelve', () => {
  // The bug this module was written for.
  assert.equal(Quantity.fromBigInt(1000n).toDecimalString(), '1000.000000000000');
  assert.equal(formatQuantity(Quantity.fromBigInt(1000n)), '1000.00');
  assert.equal(formatQuantity(Quantity.fromDecimalString('50000')), '50000.00');
});

test('the hidden places are dropped, not rounded up, by default', () => {
  // A usage meter that reads high is a complaint; one that reads low is a
  // pleasant surprise. So the default understates rather than overstates.
  assert.equal(formatQuantity(Quantity.fromDecimalString('1.999999999999')), '1.99');
  assert.equal(formatQuantity(Quantity.fromDecimalString('-1.999999999999')), '-1.99');
});

test('half-even is available for a figure that must agree with a total', () => {
  const half = { rounding: 'half-even' } as const;
  assert.equal(formatQuantity(Quantity.fromDecimalString('1.999999999999'), half), '2.00');
  assert.equal(formatQuantity(Quantity.fromDecimalString('1.005'), half), '1.00', 'ties go to even');
  assert.equal(formatQuantity(Quantity.fromDecimalString('1.015'), half), '1.02', 'and again, upward');
});

test('decimals is configurable per call', () => {
  const q = Quantity.fromDecimalString('1234.56789');
  assert.equal(formatQuantity(q, { decimals: 0 }), '1234');
  assert.equal(formatQuantity(q, { decimals: 4 }), '1234.5678');
  assert.equal(formatQuantity(q, { decimals: 14 }), '1234.56789000000000', 'asking for more than exists pads');
});

test('and once, at startup, for the whole process', () => {
  const before = displayDefaults();
  try {
    setDisplayDefaults({ decimals: 3, rounding: 'half-even' });
    assert.equal(formatQuantity(Quantity.fromDecimalString('1.9999')), '2.000');
    // A call site still wins over the default.
    assert.equal(formatQuantity(Quantity.fromDecimalString('1.9999'), { decimals: 1 }), '2.0');
  } finally {
    setDisplayDefaults(before);
  }
  assert.equal(formatQuantity(Quantity.fromDecimalString('1.9999')), '1.99', 'restored');
});

test('a bad decimals is a programmer error, and says so immediately', () => {
  assert.throws(() => setDisplayDefaults({ decimals: -1 }), TypeError);
  assert.throws(() => setDisplayDefaults({ decimals: 1.5 }), TypeError);
});

test('a rate keeps enough places to be worth reading', () => {
  // Two places would render every per-token price as 0.00, which is worse than
  // showing nothing at all.
  assert.equal(formatRate(Rate.fromDecimalString('0.000015')), '0.000015');
  assert.equal(formatRate(Rate.fromDecimalString('0.15')), '0.15');
  assert.equal(formatRate(Rate.fromDecimalString('12.5')), '12.50');
  assert.equal(formatRate(Rate.fromDecimalString('0.000015'), { decimals: 2 }), '0.00', 'unless you insist');
});

test('money keeps the currency exponent rather than a flat two', () => {
  assert.equal(formatMoney(Money.fromMinor(150n, 'USD')), '1.50 USD');
  // JPY has no minor unit and KWD has three. A hardcoded 2 would invent a
  // fraction of a yen and hide a third of a dinar.
  assert.equal(formatMoney(Money.fromMinor(150n, 'JPY')), '150 JPY');
  assert.equal(formatMoney(Money.fromMinor(1500n, 'KWD')), '1.500 KWD');
  assert.equal(formatMoney(Money.fromMinor(150n, 'USD'), { currency: false }), '1.50');
});

test('grouping is opt-in, because it is a locale decision', () => {
  const q = Quantity.fromDecimalString('1234567.89');
  assert.equal(formatQuantity(q), '1234567.89');
  assert.equal(formatQuantity(q, { locale: 'en-US' }), '1,234,567.89');
  assert.equal(formatQuantity(q, { locale: 'de-DE' }), '1.234.567.89');
});

test('trailing zeros can be trimmed for prose', () => {
  const q = Quantity.fromDecimalString('1.5');
  assert.equal(formatQuantity(q), '1.50');
  assert.equal(formatQuantity(q, { trailingZeros: false }), '1.5');
  assert.equal(formatQuantity(Quantity.fromBigInt(3n), { trailingZeros: false }), '3');
});

test('formatting cannot change what a value is', () => {
  // The whole reason this is a separate function and not a shorter toString():
  // the exact string and the wire format are untouched, so nothing that
  // round-trips stops round-tripping.
  const q = Quantity.fromDecimalString('1.999999999999');
  const shown = formatQuantity(q);
  assert.equal(shown, '1.99');
  assert.equal(q.toDecimalString(), '1.999999999999');
  assert.equal(q.toJSON(), '1.999999999999');
  assert.equal(String(q), '1.999999999999');
  assert.equal(JSON.parse(JSON.stringify({ q })).q, '1.999999999999');

  const money = Money.fromMinor(150n, 'USD');
  assert.deepEqual(money.toJSON(), { amount: '150', currency: 'USD' });
});
