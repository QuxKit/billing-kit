// Exact arithmetic for money, rates and quantities.
//
// The claim this file has to earn is that precision loss is impossible by
// construction rather than by discipline. Discipline means a reviewer noticing
// that someone wrote `total += price * qty`; construction means there is no
// overload that accepts the result of that expression in the first place.
//
// So: no method here takes a JavaScript `number`, anywhere, for a value. Not as
// a convenience overload, not behind a `fromFloat` escape hatch. Once a value
// has been through a double there is no way to distinguish an exact 19.99 from
// a 19.99 that has already drifted, and a library that accepts the ambiguity
// has to document it forever instead of refusing it once.
//
// Two types, because they are two different things:
//
//   Money     integer minor units in a bigint. What you owe, what you paid.
//   Rate      exact decimal, 12 fractional digits. What one unit costs.
//   Quantity  exact decimal, 12 fractional digits. How many units.
//
// Conflating the second into the first is how kits round in the wrong place: a
// unit price of $0.0000012 per token is not expressible in minor units, so a
// kit with only Money has to round the price, and then every charge is computed
// from a number that was already wrong.

import { BillingError } from './errors';

// --- currency ---------------------------------------------------------------

/**
 * ISO 4217 minor-unit digit counts.
 *
 * The exponent is never assumed. `* 100` is wrong for a third of the table, and
 * the failure is silent: a JPY amount multiplied by 100 bills a customer a
 * hundred times over and looks like a plausible number on an invoice.
 *
 * Entries worth knowing about:
 *   - zero-decimal: JPY, KRW, VND, CLP, ISK, XAF, XOF, XPF and friends.
 *   - three-decimal: BHD, IQD, JOD, KWD, LYD, OMR, TND.
 *   - four-decimal: CLF, UYW.
 *   - MGA and MRU are the only currencies whose subunit is not a power of ten
 *     (one fifth of the major unit, not one hundredth). ISO 4217 nonetheless
 *     assigns them 2 digits, and settlement systems follow ISO, so we do too.
 *     Recorded here because "5 iraimbilanja to the ariary" is true and will
 *     eventually be raised as a bug against this table; it is not one.
 */
const ISO_4217_EXPONENT: Readonly<Record<string, number>> = Object.freeze({
  AED: 2, AFN: 2, ALL: 2, AMD: 2, ANG: 2, AOA: 2, ARS: 2, AUD: 2, AWG: 2, AZN: 2,
  BAM: 2, BBD: 2, BDT: 2, BGN: 2, BHD: 3, BIF: 0, BMD: 2, BND: 2, BOB: 2, BOV: 2,
  BRL: 2, BSD: 2, BTN: 2, BWP: 2, BYN: 2, BZD: 2, CAD: 2, CDF: 2, CHE: 2, CHF: 2,
  CHW: 2, CLF: 4, CLP: 0, CNY: 2, COP: 2, COU: 2, CRC: 2, CUP: 2, CVE: 2, CZK: 2,
  DJF: 0, DKK: 2, DOP: 2, DZD: 2, EGP: 2, ERN: 2, ETB: 2, EUR: 2, FJD: 2, FKP: 2,
  GBP: 2, GEL: 2, GHS: 2, GIP: 2, GMD: 2, GNF: 0, GTQ: 2, GYD: 2, HKD: 2, HNL: 2,
  HTG: 2, HUF: 2, IDR: 2, ILS: 2, INR: 2, IQD: 3, IRR: 2, ISK: 0, JMD: 2, JOD: 3,
  JPY: 0, KES: 2, KGS: 2, KHR: 2, KMF: 0, KPW: 2, KRW: 0, KWD: 3, KYD: 2, KZT: 2,
  LAK: 2, LBP: 2, LKR: 2, LRD: 2, LSL: 2, LYD: 3, MAD: 2, MDL: 2, MGA: 2, MKD: 2,
  MMK: 2, MNT: 2, MOP: 2, MRU: 2, MUR: 2, MVR: 2, MWK: 2, MXN: 2, MXV: 2, MYR: 2,
  MZN: 2, NAD: 2, NGN: 2, NIO: 2, NOK: 2, NPR: 2, NZD: 2, OMR: 3, PAB: 2, PEN: 2,
  PGK: 2, PHP: 2, PKR: 2, PLN: 2, PYG: 0, QAR: 2, RON: 2, RSD: 2, RUB: 2, RWF: 0,
  SAR: 2, SBD: 2, SCR: 2, SDG: 2, SEK: 2, SGD: 2, SHP: 2, SLE: 2, SOS: 2, SRD: 2,
  SSP: 2, STN: 2, SVC: 2, SYP: 2, SZL: 2, THB: 2, TJS: 2, TMT: 2, TND: 3, TOP: 2,
  TRY: 2, TTD: 2, TWD: 2, TZS: 2, UAH: 2, UGX: 0, USD: 2, USN: 2, UYI: 0, UYU: 2,
  UYW: 4, UZS: 2, VED: 2, VES: 2, VND: 0, VUV: 0, WST: 2, XAF: 0, XCD: 2, XCG: 2,
  XOF: 0, XPF: 0, YER: 2, ZAR: 2, ZMW: 2, ZWG: 2,
});

/** Fractional digits for an ISO 4217 alpha code. Throws on anything unlisted. */
export function currencyExponent(currency: string): number {
  const exponent = ISO_4217_EXPONENT[currency];
  if (exponent === undefined) {
    throw new BillingError({ code: 'unknown_currency', currency });
  }
  return exponent;
}

export function isKnownCurrency(currency: string): boolean {
  return ISO_4217_EXPONENT[currency] !== undefined;
}

/** Every code the table knows. Sorted, so a health check can diff it. */
export function knownCurrencies(): readonly string[] {
  return Object.keys(ISO_4217_EXPONENT).sort();
}

// --- lexical decimal parsing ------------------------------------------------

const TEN = 10n;

function pow10(n: number): bigint {
  return TEN ** BigInt(n);
}

interface ParsedDecimal {
  negative: boolean;
  digits: string;
  exponent: number;
}

/**
 * Parse a decimal literal into sign, digits and a decimal exponent.
 *
 * Lexical, character by character. Never `parseFloat`, never `Number()`, never
 * a regex that ends in a coercion: those are precisely the step that loses the
 * value before we ever get to store it. `Number("0.1")` is already not 0.1.
 *
 * Scientific notation is accepted because exports and provider payloads emit it
 * ("1.5e-7" from a JSON encoder that decided to), and rejecting it would push
 * the caller towards a float conversion to normalise it first.
 */
function parseDecimal(value: string, what: string): ParsedDecimal {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BillingError({ code: 'invalid_decimal', value: String(value), what });
  }

  let i = 0;
  let negative = false;
  const c0 = value[0];
  if (c0 === '+' || c0 === '-') {
    negative = c0 === '-';
    i = 1;
  }

  let intPart = '';
  let fracPart = '';
  let sawDigit = false;

  for (; i < value.length; i++) {
    const c = value[i]!;
    if (c >= '0' && c <= '9') {
      intPart += c;
      sawDigit = true;
    } else break;
  }

  if (value[i] === '.') {
    i++;
    for (; i < value.length; i++) {
      const c = value[i]!;
      if (c >= '0' && c <= '9') {
        fracPart += c;
        sawDigit = true;
      } else break;
    }
  }

  if (!sawDigit) {
    throw new BillingError({ code: 'invalid_decimal', value, what });
  }

  let expAdjust = 0;
  if (value[i] === 'e' || value[i] === 'E') {
    i++;
    let expNeg = false;
    const s = value[i];
    if (s === '+' || s === '-') {
      expNeg = s === '-';
      i++;
    }
    let expDigits = '';
    for (; i < value.length; i++) {
      const c = value[i]!;
      if (c >= '0' && c <= '9') expDigits += c;
      else break;
    }
    if (expDigits.length === 0 || expDigits.length > 6) {
      throw new BillingError({ code: 'invalid_decimal', value, what });
    }
    // Safe as a number: bounded to six digits above, and only ever used as a
    // shift count. It is not part of the value.
    expAdjust = (expNeg ? -1 : 1) * Number(expDigits);
  }

  if (i !== value.length) {
    throw new BillingError({ code: 'invalid_decimal', value, what });
  }

  return {
    negative,
    digits: intPart + fracPart,
    exponent: -fracPart.length + expAdjust,
  };
}

/**
 * Rescale a parsed decimal to an integer at `scale` fractional digits.
 *
 * Refuses to drop a non-zero digit. A silent truncation here is the whole class
 * of bug this module exists to prevent: `Rate.fromDecimalString("0.1234567890123")`
 * quietly becoming 0.123456789012 is a rate that is wrong on every future
 * charge, with nothing in the record saying so.
 */
function toScaledInteger(parsed: ParsedDecimal, scale: number, value: string, what: string): bigint {
  const shift = scale + parsed.exponent;
  let magnitude: bigint;

  if (shift >= 0) {
    magnitude = (parsed.digits === '' ? 0n : BigInt(parsed.digits)) * pow10(shift);
  } else {
    const drop = -shift;
    const digits = parsed.digits;
    if (drop >= digits.length) {
      // Everything is below the representable scale. Only exactly zero survives.
      if (/[1-9]/.test(digits)) {
        throw new BillingError({ code: 'precision_loss', value, scale, what });
      }
      return 0n;
    }
    const kept = digits.slice(0, digits.length - drop);
    const dropped = digits.slice(digits.length - drop);
    if (/[1-9]/.test(dropped)) {
      throw new BillingError({ code: 'precision_loss', value, scale, what });
    }
    magnitude = kept === '' ? 0n : BigInt(kept);
  }

  return parsed.negative ? -magnitude : magnitude;
}

/** Render a scaled integer back as a decimal string. Exact, both directions. */
function renderScaled(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0');
  const intPart = digits.slice(0, digits.length - scale);
  const fracPart = scale === 0 ? '' : digits.slice(digits.length - scale);
  const body = fracPart === '' ? intPart : `${intPart}.${fracPart}`;
  return negative ? `-${body}` : body;
}

/**
 * Integer division rounding half to even.
 *
 * Half-to-even and not half-up because half-up is biased: every tie rounds the
 * same direction, so over a million charges the residue is not noise around
 * zero but a systematic drift in the merchant's favour. That is the shape of an
 * error an auditor notices and cannot be talked out of.
 *
 * `denominator` must be positive; sign is carried by the numerator.
 */
function divideHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('divideHalfEven: denominator must be positive');

  const negative = numerator < 0n;
  const n = negative ? -numerator : numerator;

  const quotient = n / denominator;
  const remainder = n % denominator;
  const twice = remainder * 2n;

  let rounded: bigint;
  if (twice > denominator) rounded = quotient + 1n;
  else if (twice < denominator) rounded = quotient;
  else rounded = quotient % 2n === 0n ? quotient : quotient + 1n;

  return negative ? -rounded : rounded;
}

// --- Money ------------------------------------------------------------------

/** The wire form of an amount. A string, in minor units, plus its currency. */
export interface MoneyJSON {
  amount: string;
  currency: string;
}

/**
 * An exact amount of one currency, held as integer minor units.
 *
 * Immutable and currency-tagged. Every operation that combines two Money values
 * checks the tag, because "add USD to EUR" has no correct answer and the
 * plausible one (ignore it) produces a number that looks fine.
 */
export class Money {
  readonly minor: bigint;
  readonly currency: string;

  private constructor(minor: bigint, currency: string) {
    this.minor = minor;
    this.currency = currency;
    Object.freeze(this);
  }

  /**
   * Build from minor units.
   *
   * `string` is the primary form because that is what both drivers hand back:
   * node-postgres returns BIGINT as a string (it will not risk a lossy cast to
   * number), and a JSON body carries it as a string for the same reason.
   */
  static fromMinor(minor: bigint | string, currency: string): Money {
    currencyExponent(currency);
    let units: bigint;
    if (typeof minor === 'bigint') {
      units = minor;
    } else {
      const parsed = parseDecimal(minor, 'amount');
      units = toScaledInteger(parsed, 0, minor, 'amount');
    }
    return new Money(units, currency);
  }

  /**
   * Build from a major-unit decimal string: "19.99" USD is 1999 minor units.
   *
   * Rejects more fractional digits than the currency has rather than rounding
   * them away. "19.999" USD is not an amount; it is a rate someone put in the
   * wrong field, and rounding it here would hide that until reconciliation.
   */
  static fromDecimalString(value: string, currency: string): Money {
    const exponent = currencyExponent(currency);
    const parsed = parseDecimal(value, 'amount');
    return new Money(toScaledInteger(parsed, exponent, value, 'amount'), currency);
  }

  static zero(currency: string): Money {
    currencyExponent(currency);
    return new Money(0n, currency);
  }

  /**
   * Add exactly, in any order.
   *
   * The associativity that bigint has and `double precision` does not is the
   * actual reason this class exists: Postgres may reorder a SUM across a
   * parallel aggregate, so a float ledger's total depends on the query plan and
   * cannot be re-derived. A total you cannot re-derive cannot be audited.
   */
  static sum(amounts: Iterable<Money>, currency: string): Money {
    currencyExponent(currency);
    let total = 0n;
    for (const amount of amounts) {
      if (amount.currency !== currency) {
        throw new BillingError({ code: 'currency_mismatch', left: currency, right: amount.currency });
      }
      total += amount.minor;
    }
    return new Money(total, currency);
  }

  plus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  minus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  abs(): Money {
    return this.minor < 0n ? this.negate() : this;
  }

  /** Whole multiples only. A fractional multiplier is a Rate; use `price`. */
  timesInteger(factor: bigint): Money {
    return new Money(this.minor * factor, this.currency);
  }

  /** -1, 0 or 1. Throws across currencies, for the same reason `plus` does. */
  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.minor < other.minor) return -1;
    if (this.minor > other.minor) return 1;
    return 0;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  /**
   * The wire form.
   *
   * `JSON.stringify` throws on a bare bigint — deliberately, so that a value
   * cannot silently become a float on the way out. That throw is correct and
   * still an outage, because it happens in a response serialiser at the far end
   * of a request. This method converts the outage into a string that is exact.
   */
  toJSON(): MoneyJSON {
    return { amount: this.minor.toString(), currency: this.currency };
  }

  static fromJSON(json: MoneyJSON): Money {
    return Money.fromMinor(json.amount, json.currency);
  }

  /**
   * Display only. Not for arithmetic, not for comparison, not for a database.
   *
   * Round-trips exactly through `fromDecimalString`, but the reason to say
   * "display only" anyway is that the moment this appears in a comparison
   * someone will compare "1.50" with "1.5".
   */
  toDecimalString(): string {
    return renderScaled(this.minor, currencyExponent(this.currency));
  }

  toString(): string {
    return `${this.toDecimalString()} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new BillingError({ code: 'currency_mismatch', left: this.currency, right: other.currency });
    }
  }
}

// --- exact decimals: Rate and Quantity --------------------------------------

/**
 * Fractional digits carried by a rate or a quantity, matching the
 * `NUMERIC(38,12)` the schema declares.
 *
 * Twelve because per-token pricing is real and already needs seven ($0.0000012
 * per token), and because the product of two twelve-digit decimals fits a
 * bigint comfortably while staying inside NUMERIC(38,12) after rounding.
 */
export const DECIMAL_SCALE = 12;

const SCALE_UNIT = pow10(DECIMAL_SCALE);

/**
 * An exact decimal at `DECIMAL_SCALE` fractional digits.
 *
 * Not exported. `Rate` and `Quantity` are separate nominal types over it,
 * because a rate and a quantity are structurally identical and swapping the two
 * arguments at a call site is exactly the mistake that produces a bill that is
 * wrong by a factor of a million with no type error.
 */
class ExactDecimal {
  readonly units: bigint;

  protected constructor(units: bigint) {
    this.units = units;
    Object.freeze(this);
  }

  toDecimalString(): string {
    return renderScaled(this.units, DECIMAL_SCALE);
  }

  toJSON(): string {
    return this.toDecimalString();
  }

  toString(): string {
    return this.toDecimalString();
  }

  isZero(): boolean {
    return this.units === 0n;
  }

  isNegative(): boolean {
    return this.units < 0n;
  }
}

/** What one unit costs. Exact to twelve fractional digits. */
export class Rate extends ExactDecimal {
  // Nominal marker. Without a private member, TypeScript's structural typing
  // makes Rate and Quantity interchangeable and `price(rate, quantity)` with
  // the arguments swapped compiles.
  readonly #rate = true;

  static fromDecimalString(value: string): Rate {
    const parsed = parseDecimal(value, 'rate');
    return new Rate(toScaledInteger(parsed, DECIMAL_SCALE, value, 'rate'));
  }

  static zero(): Rate {
    return new Rate(0n);
  }

  /** Present so the nominal marker is read somewhere and cannot be pruned. */
  isRate(): boolean {
    return this.#rate;
  }
}

/** How many units. Exact to twelve fractional digits; not an integer. */
export class Quantity extends ExactDecimal {
  readonly #quantity = true;

  static fromDecimalString(value: string): Quantity {
    const parsed = parseDecimal(value, 'quantity');
    return new Quantity(toScaledInteger(parsed, DECIMAL_SCALE, value, 'quantity'));
  }

  static fromBigInt(value: bigint): Quantity {
    return new Quantity(value * SCALE_UNIT);
  }

  static zero(): Quantity {
    return new Quantity(0n);
  }

  plus(other: Quantity): Quantity {
    return new Quantity(this.units + other.units);
  }

  static sum(quantities: Iterable<Quantity>): Quantity {
    let total = 0n;
    for (const q of quantities) total += q.units;
    return new Quantity(total);
  }

  isQuantity(): boolean {
    return this.#quantity;
  }
}

// --- the one rounding site --------------------------------------------------

/**
 * A priced quantity: the rounded amount, and the exact value it was rounded
 * from, so the rounding is auditable.
 */
export interface PricedAmount {
  /** What is charged. Minor units, rounded half-to-even, exactly once. */
  amount: Money;
  /** `quantity * rate` in minor units, unrounded. Decimal string, exact. */
  exactMinor: string;
  /** `exactMinor - amount`. Non-zero whenever rounding did anything. */
  residueMinor: string;
}

/**
 * Price a quantity. The only place in billing-kit where rounding happens.
 *
 * Stated once and enforced here: `quantity * rate` is computed exactly and
 * rounded to minor units once, at the charge, half-to-even, keeping the
 * pre-rounding value.
 *
 * Not at the event — rounding per event means the error grows with row count,
 * and a million events rounded individually are visibly not the same number as
 * their sum rounded once. Not at the invoice — round there and the ledger and
 * the invoice disagree by the residue, with no row explaining the gap.
 */
export function price(quantity: Quantity, rate: Rate, currency: string): PricedAmount {
  // The rate is in MINOR units per unit — cents, not dollars. A per-minute price
  // of $0.0019 is stored as the rate 0.19 (0.19 cents), so the product is already
  // in minor units and needs no major->minor conversion. This is the canonical
  // convention across the library; the SQL metering (sql/010_metering.sql) reads
  // the same rate the same way, so the two layers agree on what a rate literal
  // means. Expressing the rate in major units instead was a 10^exponent error
  // between this function and the SQL — the same literal priced 100x apart in USD.
  //
  // quantity and rate are each scaled by 10^12, so their product is scaled by
  // 10^24, and that product is minor units directly.
  const productUnits = quantity.units * rate.units;
  const productScale = DECIMAL_SCALE * 2;

  let minor: bigint;
  let exactMinor: string;

  if (productScale >= 0) {
    const divisor = pow10(productScale);
    minor = divideHalfEven(productUnits, divisor);
    exactMinor = renderScaled(productUnits, productScale);
  } else {
    // Only reachable for a currency with more fractional digits than 24, which
    // does not exist. Handled rather than asserted so the branch is total.
    const multiplier = pow10(-productScale);
    minor = productUnits * multiplier;
    exactMinor = (productUnits * multiplier).toString();
  }

  const amount = Money.fromMinor(minor, currency);
  const residueUnits = productUnits - minor * (productScale >= 0 ? pow10(productScale) : 1n);

  return {
    amount,
    exactMinor,
    residueMinor: productScale >= 0 ? renderScaled(residueUnits, productScale) : '0',
  };
}

/**
 * Split an amount into `parts` shares that sum back to the original exactly.
 *
 * The largest-remainder method: floor everything, then hand the leftover minor
 * units out one at a time. Dividing 100 by 3 and rounding each share gives
 * 33 + 33 + 33 = 99, and the missing penny is the kind of discrepancy that
 * surfaces as a failed reconciliation months later.
 */
export function allocate(amount: Money, weights: readonly bigint[]): Money[] {
  if (weights.length === 0) {
    throw new BillingError({ code: 'invalid_allocation', reason: 'no weights' });
  }
  let total = 0n;
  for (const w of weights) {
    if (w < 0n) throw new BillingError({ code: 'invalid_allocation', reason: 'negative weight' });
    total += w;
  }
  if (total === 0n) {
    throw new BillingError({ code: 'invalid_allocation', reason: 'weights sum to zero' });
  }

  const negative = amount.minor < 0n;
  const magnitude = negative ? -amount.minor : amount.minor;

  const shares: bigint[] = [];
  let allocated = 0n;
  for (const w of weights) {
    const share = (magnitude * w) / total;
    shares.push(share);
    allocated += share;
  }

  let leftover = magnitude - allocated;
  for (let i = 0; leftover > 0n; i = (i + 1) % shares.length) {
    shares[i] = shares[i]! + 1n;
    leftover -= 1n;
  }

  return shares.map((s) => Money.fromMinor(negative ? -s : s, amount.currency));
}
