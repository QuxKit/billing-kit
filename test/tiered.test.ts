// Tiered pricing: volume and graduated, with the same round-once guarantee as
// `price`. The cases that matter are the ones a per-tier-rounding implementation
// gets wrong — where the exact total across tiers rounds to a different minor
// amount than the sum of each tier rounded on its own.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BillingError } from '../src/errors';
import { Money, Quantity, Rate, price, priceTiered } from '../src/money';

const q = (n: bigint) => Quantity.fromBigInt(n);
const rate = (v: string) => Rate.fromDecimalString(v);
const usd = (v: string) => Money.fromDecimalString(v, 'USD');

// upTo=10 @ $0.10/unit, upTo=20 @ $0.05/unit, rest @ $0.01/unit (rates in minor).
const stepped = [
  { upTo: q(10n), rate: rate('10') },
  { upTo: q(20n), rate: rate('5') },
  { upTo: null, rate: rate('1') },
];

describe('graduated pricing', () => {
  it('prices each block in its own tier', () => {
    // 10@10 + 10@5 + 5@1 = 100 + 50 + 5 = 155 minor
    const p = priceTiered(q(25n), stepped, 'graduated', 'USD');
    assert.equal(p.amount.minor, 155n);
  });

  it('stops at the quantity, not the last tier', () => {
    // 10@10 only
    assert.equal(priceTiered(q(10n), stepped, 'graduated', 'USD').amount.minor, 100n);
    // 10@10 + 5@5 = 125
    assert.equal(priceTiered(q(15n), stepped, 'graduated', 'USD').amount.minor, 125n);
  });

  it('is zero for zero quantity', () => {
    assert.equal(priceTiered(q(0n), stepped, 'graduated', 'USD').amount.minor, 0n);
  });
});

describe('volume pricing', () => {
  it('prices the whole quantity at the tier it lands in', () => {
    // lands in tier 3 (unbounded): 25 @ 1 = 25
    assert.equal(priceTiered(q(25n), stepped, 'volume', 'USD').amount.minor, 25n);
    // lands in tier 2: 15 @ 5 = 75
    assert.equal(priceTiered(q(15n), stepped, 'volume', 'USD').amount.minor, 75n);
    // lands in tier 1 (10 <= 10): 10 @ 10 = 100
    assert.equal(priceTiered(q(10n), stepped, 'volume', 'USD').amount.minor, 100n);
  });

  it('gets cheaper retroactively when a threshold is crossed', () => {
    // 11 units lands in tier 2 and every unit is repriced: 11 @ 5 = 55,
    // less than 10 units in tier 1 at 10 = 100.
    assert.equal(priceTiered(q(11n), stepped, 'volume', 'USD').amount.minor, 55n);
  });
});

describe('per-tier flat fees', () => {
  const withFlat = [
    { upTo: q(10n), rate: rate('10'), flat: usd('5.00') },
    { upTo: null, rate: rate('5'), flat: usd('2.00') },
  ];

  it('adds the flat of every graduated tier that is reached', () => {
    // (10@10 + 500) + (5@5 + 200) = 600 + 225 = 825
    assert.equal(priceTiered(q(15n), withFlat, 'graduated', 'USD').amount.minor, 825n);
  });

  it('adds only the landed tier flat under volume', () => {
    // lands in tier 2: 15@5 + 200 = 275
    assert.equal(priceTiered(q(15n), withFlat, 'volume', 'USD').amount.minor, 275n);
  });
});

describe('rounding happens once, over the whole price', () => {
  it('rounds the summed exact total, not each tier', () => {
    // Two tiers at half a minor unit each. 3@0.5 = 1.5, 2@0.5 = 1.0.
    // Exact total 2.5 → half-to-even → 2. Rounding each tier first gives
    // 2 (1.5→even 2) + 1 = 3, which is the wrong answer this guards against.
    const halves = [
      { upTo: q(3n), rate: rate('0.5') },
      { upTo: null, rate: rate('0.5') },
    ];
    const p = priceTiered(q(5n), halves, 'graduated', 'USD');
    assert.equal(p.amount.minor, 2n);
    assert.ok(p.residueMinor.startsWith('0.5'), `residue was ${p.residueMinor}`);
  });

  it('matches price() for a single unbounded tier', () => {
    const one = [{ upTo: null, rate: rate('0.00012') }];
    const flat = price(Quantity.fromDecimalString('1234567'), rate('0.00012'), 'USD');
    for (const mode of ['volume', 'graduated'] as const) {
      const tiered = priceTiered(Quantity.fromDecimalString('1234567'), one, mode, 'USD');
      assert.equal(tiered.amount.minor, flat.amount.minor);
      assert.equal(tiered.exactMinor, flat.exactMinor);
    }
  });
});

describe('invalid tiers are refused, not guessed', () => {
  it('rejects an empty tier list', () => {
    assert.throws(() => priceTiered(q(1n), [], 'volume', 'USD'), (e) => BillingError.hasCode(e, 'invalid_tiers'));
  });

  it('rejects a bounded last tier (a forgotten upTo: null)', () => {
    const bounded = [{ upTo: q(10n), rate: rate('1') }];
    assert.throws(() => priceTiered(q(1n), bounded, 'graduated', 'USD'), (e) => BillingError.hasCode(e, 'invalid_tiers'));
  });

  it('rejects non-ascending boundaries', () => {
    const bad = [
      { upTo: q(10n), rate: rate('1') },
      { upTo: q(5n), rate: rate('1') },
      { upTo: null, rate: rate('1') },
    ];
    assert.throws(() => priceTiered(q(1n), bad, 'graduated', 'USD'), (e) => BillingError.hasCode(e, 'invalid_tiers'));
  });

  it('rejects a negative quantity', () => {
    const neg = Quantity.fromDecimalString('-1');
    assert.throws(() => priceTiered(neg, stepped, 'graduated', 'USD'), (e) => BillingError.hasCode(e, 'invalid_tiers'));
  });

  it('rejects a flat in the wrong currency', () => {
    const mixed = [
      { upTo: q(10n), rate: rate('1'), flat: Money.fromDecimalString('1.00', 'EUR') },
      { upTo: null, rate: rate('1') },
    ];
    assert.throws(() => priceTiered(q(1n), mixed, 'graduated', 'USD'), (e) => BillingError.hasCode(e, 'currency_mismatch'));
  });
});
