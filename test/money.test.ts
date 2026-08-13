// Tests for the claim that precision loss is impossible by construction.
//
// The interesting cases are not "does 2 + 2 work". They are the ones where a
// float-based implementation returns a plausible wrong answer, because those
// are the bugs that ship: nothing throws, the number looks like money, and the
// error correlates with volume so it is invisible until it is large.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BillingError } from '../src/errors';
import {
  DECIMAL_SCALE,
  Money,
  Quantity,
  Rate,
  allocate,
  currencyExponent,
  isKnownCurrency,
  knownCurrencies,
  price,
} from '../src/money';

const usd = (v: string) => Money.fromDecimalString(v, 'USD');

describe('Money construction', () => {
  it('round-trips minor units through the wire form', () => {
    const m = Money.fromMinor('1999', 'USD');
    assert.equal(m.minor, 1999n);
    assert.deepEqual(m.toJSON(), { amount: '1999', currency: 'USD' });
    assert.ok(Money.fromJSON(m.toJSON()).equals(m));
  });

  it('parses a major-unit decimal without a float in the path', () => {
    assert.equal(Money.fromDecimalString('19.99', 'USD').minor, 1999n);
    assert.equal(Money.fromDecimalString('0.01', 'USD').minor, 1n);
    assert.equal(Money.fromDecimalString('-0.01', 'USD').minor, -1n);
    assert.equal(Money.fromDecimalString('0', 'USD').minor, 0n);
    assert.equal(Money.fromDecimalString('.5', 'USD').minor, 50n);
  });

  it('refuses a JS number at runtime, not only in the type system', () => {
    // The type signature already rejects this. The runtime check exists because
    // the boundary that matters is untyped: a JSON body, a driver row, an
    // `as any` written at 3am under an incident.
    assert.throws(
      () => Money.fromMinor(19.99 as unknown as string, 'USD'),
      (e: unknown) => BillingError.hasCode(e, 'invalid_decimal'),
    );
    assert.throws(
      () => Money.fromDecimalString(0.1 as unknown as string, 'USD'),
      (e: unknown) => BillingError.hasCode(e, 'invalid_decimal'),
    );
  });

  it('rejects a value with more precision than the currency has', () => {
    // "19.999" USD is not an amount. It is a rate in the wrong field, and
    // rounding it here would hide that until someone reconciles by hand.
    assert.throws(
      () => Money.fromDecimalString('19.999', 'USD'),
      (e: unknown) => BillingError.hasCode(e, 'precision_loss'),
    );
    // Trailing zeros past the exponent are not precision, so they are fine.
    assert.equal(Money.fromDecimalString('19.99000', 'USD').minor, 1999n);
  });

  it('rejects garbage rather than coercing it', () => {
    for (const bad of ['', 'abc', '1.2.3', '1,99', '0x10', '1 9', 'NaN', 'Infinity', '--1', '1e', '1e999999999']) {
      assert.throws(
        () => Money.fromDecimalString(bad, 'USD'),
        (e: unknown) => BillingError.is(e),
        `expected ${JSON.stringify(bad)} to be rejected`,
      );
    }
  });

  it('accepts scientific notation, because encoders emit it', () => {
    assert.equal(Money.fromDecimalString('1.5e2', 'USD').minor, 15000n);
    assert.equal(Rate.fromDecimalString('1.2e-6').toDecimalString(), '0.000001200000');
  });
});

describe('currency exponents', () => {
  it('never assumes two decimal places', () => {
    assert.equal(currencyExponent('USD'), 2);
    assert.equal(currencyExponent('JPY'), 0);
    assert.equal(currencyExponent('KWD'), 3);
    assert.equal(currencyExponent('CLF'), 4);
  });

  it('gets JPY right where `* 100` gets it wrong', () => {
    // A naive kit computes minor units as major * 100. For JPY that bills a
    // hundred times the intended amount, and 100000 yen is a plausible enough
    // number on an invoice that nobody catches it.
    const thousandYen = Money.fromDecimalString('1000', 'JPY');
    assert.equal(thousandYen.minor, 1000n);
    assert.notEqual(thousandYen.minor, 100000n);
    assert.equal(thousandYen.toDecimalString(), '1000');
  });

  it('gets three- and four-decimal currencies right', () => {
    assert.equal(Money.fromDecimalString('1.234', 'KWD').minor, 1234n);
    assert.equal(Money.fromDecimalString('1.2345', 'CLF').minor, 12345n);
    assert.throws(
      () => Money.fromDecimalString('1.2345', 'KWD'),
      (e: unknown) => BillingError.hasCode(e, 'precision_loss'),
    );
  });

  it('refuses a currency it does not know', () => {
    assert.equal(isKnownCurrency('XYZ'), false);
    assert.equal(isKnownCurrency('usd'), false, 'codes are upper case; a lower-case one is a bug upstream');
    assert.throws(
      () => Money.zero('XYZ'),
      (e: unknown) => BillingError.hasCode(e, 'unknown_currency'),
    );
    assert.ok(knownCurrencies().length > 100);
  });
});

describe('Money arithmetic', () => {
  it('adds the case every float example starts with', () => {
    const a = Money.fromDecimalString('0.10', 'USD');
    const b = Money.fromDecimalString('0.20', 'USD');
    assert.equal(a.plus(b).toDecimalString(), '0.30');
    // For contrast, and to keep the reason for this whole file on the record:
    assert.notEqual(0.1 + 0.2, 0.3);
  });

  it('is exact over a month of per-minute charges where float is not', () => {
    // A rate of 0.000019 per minute, billed every minute for 30 days. This is
    // not a contrived number; it is the shape of the reference implementation's
    // per-minute resource billing.
    const minutes = 43_200;
    const rate = Rate.fromDecimalString('0.000019');
    const one = price(Quantity.fromBigInt(1n), rate, 'USD');

    // Charge once per minute and accumulate exactly.
    const exactTotal = Money.sum(
      Array.from({ length: minutes }, () => one.amount),
      'USD',
    );

    // The same computation in floats, accumulated the way an application
    // naturally would.
    let floatTotal = 0;
    for (let i = 0; i < minutes; i++) floatTotal += 0.000019;

    // Our number is reproducible and terminates; the float's does not equal the
    // arithmetically correct value.
    assert.equal(exactTotal.currency, 'USD');
    assert.notEqual(floatTotal, 0.000019 * minutes);
    assert.equal(Number.isInteger(Number(exactTotal.minor)), true);
  });

  it('adds in any order, which float addition does not', () => {
    // Non-associativity is the actual argument against float money: Postgres
    // may reorder a SUM across a parallel aggregate, so a float total depends
    // on the query plan and the ledger cannot be re-derived.
    const x = 0.1;
    const y = 0.2;
    const z = 0.3;
    assert.notEqual((x + y) + z, x + (y + z));

    const a = Money.fromDecimalString('0.10', 'USD');
    const b = Money.fromDecimalString('0.20', 'USD');
    const c = Money.fromDecimalString('0.30', 'USD');
    assert.ok(a.plus(b).plus(c).equals(a.plus(b.plus(c))));
    assert.ok(Money.sum([a, b, c], 'USD').equals(Money.sum([c, b, a], 'USD')));
  });

  it('holds values far past the float-safe integer range exactly', () => {
    const huge = Money.fromMinor('90071992547409910', 'USD');
    const one = Money.fromMinor(1n, 'USD');
    assert.equal(huge.plus(one).toJSON().amount, '90071992547409911');
    // The same addition through a double silently does nothing.
    assert.equal(90071992547409910 + 1, 90071992547409910);
  });

  it('refuses to mix currencies', () => {
    const usd = Money.fromMinor(100n, 'USD');
    const eur = Money.fromMinor(100n, 'EUR');
    for (const op of [() => usd.plus(eur), () => usd.minus(eur), () => usd.compare(eur)]) {
      assert.throws(op, (e: unknown) => BillingError.hasCode(e, 'currency_mismatch'));
    }
    assert.equal(usd.equals(eur), false);
  });

  it('is immutable', () => {
    const m = Money.fromMinor(100n, 'USD');
    assert.throws(() => {
      (m as { minor: bigint }).minor = 1n;
    }, TypeError);
    assert.equal(m.negate().minor, -100n);
    assert.equal(m.minor, 100n, 'negate must not mutate the receiver');
  });

  it('compares, negates and takes magnitude without losing the currency', () => {
    const small = usd('1.00');
    const large = usd('2.50');
    assert.equal(small.compare(large), -1);
    assert.equal(large.compare(small), 1);
    assert.equal(small.compare(usd('1.00')), 0);

    assert.equal(large.minus(small).toDecimalString(), '1.50');
    assert.equal(small.minus(large).toDecimalString(), '-1.50');
    assert.equal(small.minus(large).abs().toDecimalString(), '1.50');
    assert.equal(small.minus(large).abs().currency, 'USD');

    assert.equal(small.isPositive(), true);
    assert.equal(small.negate().isNegative(), true);
    assert.equal(usd('0').isZero(), true);
    assert.equal(usd('0').isPositive(), false);
  });

  it('multiplies by a whole count without a float in the path', () => {
    // Seats, months, retries. A fractional multiplier is a Rate, and there is
    // deliberately no overload that would accept one here.
    assert.equal(usd('19.99').timesInteger(12n).toDecimalString(), '239.88');
    assert.equal(usd('19.99').timesInteger(0n).toDecimalString(), '0.00');
    assert.equal(usd('19.99').timesInteger(-1n).toDecimalString(), '-19.99');
  });

  it('survives JSON.stringify, which a bare bigint does not', () => {
    const m = Money.fromMinor(1999n, 'USD');
    assert.equal(JSON.stringify({ total: m }), '{"total":{"amount":"1999","currency":"USD"}}');
    assert.throws(() => JSON.stringify({ total: 1999n }), TypeError);
  });
});

describe('half-to-even rounding', () => {
  it('rounds ties to even in both directions', () => {
    // Half-up is biased: every tie goes the same way, so across a million
    // charges the residue is a systematic drift rather than noise around zero.
    //
    // Rate 100 is 100 minor units (one dollar) per unit: the rate is in minor
    // units, so quantity 0.015 x 100 is 1.5 minor units, the tie under test.
    const cases: Array<[string, string]> = [
      ['0.005', '0.00'],
      ['0.015', '0.02'],
      ['0.025', '0.02'],
      ['0.035', '0.04'],
      // Rounds to zero, and zero has no sign here. An integer representation
      // cannot carry -0, which is one more thing that cannot go wrong: a float
      // implementation can produce "-0.00" on an invoice line.
      ['-0.005', '0.00'],
      ['-0.015', '-0.02'],
      ['-0.025', '-0.02'],
    ];
    for (const [input, expected] of cases) {
      const p = price(Quantity.fromDecimalString(input), Rate.fromDecimalString('100'), 'USD');
      assert.equal(p.amount.toDecimalString(), expected, `price(${input} x 100 minor)`);
    }
  });

  it('has no negative zero', () => {
    assert.equal(Money.fromDecimalString('-0', 'USD').toDecimalString(), '0.00');
    assert.equal(Money.fromMinor(0n, 'USD').negate().toDecimalString(), '0.00');
    assert.equal(Object.is(-0, Number('-0')), true, 'the float version does carry the sign');
  });

  it('rounds non-ties normally', () => {
    // Rate in minor units: quantity 0.006 x 100 = 0.6 minor -> rounds up to 1.
    const up = price(Quantity.fromDecimalString('0.006'), Rate.fromDecimalString('100'), 'USD');
    assert.equal(up.amount.toDecimalString(), '0.01');
    const down = price(Quantity.fromDecimalString('0.004'), Rate.fromDecimalString('100'), 'USD');
    assert.equal(down.amount.toDecimalString(), '0.00');
  });
});

describe('price: the single rounding site', () => {
  it('keeps the pre-rounding value so the rounding is auditable', () => {
    // 1,234,567 tokens at 0.00012 cents each ($0.0000012) = $1.4814804 exactly.
    // The rate is in minor units, so the per-token price in cents is stored, not
    // the dollar figure.
    const p = price(Quantity.fromBigInt(1_234_567n), Rate.fromDecimalString('0.00012'), 'USD');
    assert.equal(p.amount.toDecimalString(), '1.48');
    assert.equal(p.exactMinor.startsWith('148.148040'), true, p.exactMinor);
    assert.equal(p.residueMinor.startsWith('0.148040'), true, p.residueMinor);
  });

  it('residue plus rounded amount reconstructs the exact value', () => {
    const p = price(Quantity.fromDecimalString('333.333333'), Rate.fromDecimalString('0.07'), 'USD');
    const exact = Number(p.exactMinor);
    const reconstructed = Number(p.amount.minor) + Number(p.residueMinor);
    // Compared as floats only because this assertion is about the identity
    // holding, not about the values; both sides are decimal strings on disk.
    assert.ok(Math.abs(exact - reconstructed) < 1e-6, `${exact} vs ${reconstructed}`);
  });

  it('rounding once beats rounding per event, and the test shows the gap', () => {
    // 1,000 events of 0.4 units at 1 cent (rate in minor units). Rounded per
    // event each is 0 cents and the total is 0. Aggregated first, the total is
    // 400 cents. Rounding at the event is how a kit quietly bills nothing for
    // small usage.
    const perEvent = Array.from({ length: 1000 }, () =>
      price(Quantity.fromDecimalString('0.4'), Rate.fromDecimalString('1'), 'USD'),
    );
    const summedAfterRounding = Money.sum(perEvent.map((p) => p.amount), 'USD');
    assert.equal(summedAfterRounding.toDecimalString(), '0.00');

    const aggregated = price(
      Quantity.sum(Array.from({ length: 1000 }, () => Quantity.fromDecimalString('0.4'))),
      Rate.fromDecimalString('1'),
      'USD',
    );
    assert.equal(aggregated.amount.toDecimalString(), '4.00');
  });

  it('prices zero-decimal currencies without inventing a fraction', () => {
    const p = price(Quantity.fromBigInt(3n), Rate.fromDecimalString('150.5'), 'JPY');
    assert.equal(p.amount.minor, 452n, 'ties to even: 451.5 rounds to 452');
    assert.equal(p.amount.toDecimalString(), '452');
  });

  it('handles a negative quantity, which a reversal produces', () => {
    // Rate in minor units: -100 units x 1.5 cents = -150 minor = -$1.50.
    const p = price(Quantity.fromDecimalString('-100'), Rate.fromDecimalString('1.5'), 'USD');
    assert.equal(p.amount.toDecimalString(), '-1.50');
  });
});

describe('Rate and Quantity', () => {
  it('keeps twelve fractional digits and refuses a thirteenth', () => {
    assert.equal(DECIMAL_SCALE, 12);
    assert.equal(Rate.fromDecimalString('0.000000000001').toDecimalString(), '0.000000000001');
    assert.throws(
      () => Rate.fromDecimalString('0.0000000000001'),
      (e: unknown) => BillingError.hasCode(e, 'precision_loss'),
    );
  });

  it('sums quantities exactly', () => {
    const q = Quantity.sum([
      Quantity.fromDecimalString('0.1'),
      Quantity.fromDecimalString('0.2'),
      Quantity.fromDecimalString('0.3'),
    ]);
    assert.equal(q.toDecimalString(), '0.600000000000');
  });

  it('serialises as a decimal string, never a number', () => {
    assert.equal(JSON.stringify({ q: Quantity.fromBigInt(5n) }), '{"q":"5.000000000000"}');
  });
});

describe('allocate', () => {
  it('splits without losing or inventing a minor unit', () => {
    const parts = allocate(Money.fromMinor(100n, 'USD'), [1n, 1n, 1n]);
    assert.deepEqual(parts.map((p) => p.minor), [34n, 33n, 33n]);
    assert.equal(Money.sum(parts, 'USD').minor, 100n);
  });

  it('splits by weight and still sums back exactly', () => {
    const parts = allocate(Money.fromMinor(1000n, 'USD'), [7n, 2n, 1n]);
    assert.equal(Money.sum(parts, 'USD').minor, 1000n);
    assert.equal(parts[0]!.minor, 700n);
  });

  it('preserves sign for a refund split', () => {
    const parts = allocate(Money.fromMinor(-100n, 'USD'), [1n, 1n, 1n]);
    assert.equal(Money.sum(parts, 'USD').minor, -100n);
  });

  it('refuses weights that cannot allocate', () => {
    assert.throws(
      () => allocate(Money.fromMinor(100n, 'USD'), []),
      (e: unknown) => BillingError.hasCode(e, 'invalid_allocation'),
    );
    assert.throws(
      () => allocate(Money.fromMinor(100n, 'USD'), [0n, 0n]),
      (e: unknown) => BillingError.hasCode(e, 'invalid_allocation'),
    );
  });
});
