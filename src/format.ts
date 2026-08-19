// Display formatting, kept deliberately apart from the values themselves.
//
// `Quantity` and `Rate` carry twelve decimal places because per-token pricing
// needs them, and `toDecimalString()` renders every one — which is right for
// `toJSON()`, where the exactness is the entire point, and wrong for a screen:
//
//     tokens used this period: 1000.000000000000 of 50000.000000000000
//
// The tempting fix is to shorten `toString()`. Do not: `ExactDecimal.toJSON()`
// calls `toDecimalString()`, so that string is the wire format, and any caller
// who wrote `String(quantity)` into a column would quietly begin losing
// precision — in a library whose whole claim is that a rounding error cannot
// exist. So formatting is a separate call you can see at the call site, and the
// exact values are never in doubt about what they are.
//
// `Money` is already sensible and is included only so an application has one
// formatting entry point rather than two: it renders at the currency's
// exponent, so USD arrives as `1.50` and JPY as `150`, and `decimals` here
// defaults to that rather than to 2.

import { currencyExponent, DECIMAL_SCALE, type Money, type Quantity, type Rate } from './money';

/** How a value should be shortened for a human. */
export interface DisplayOptions {
  /**
   * Decimal places to show. Default 2 for `Quantity` and `Rate`; for `Money`,
   * the currency's own exponent, so JPY does not grow two places it has never
   * had and KWD does not lose its third.
   */
  decimals?: number;
  /**
   * How the hidden places are dealt with.
   *
   * `truncate` (default) never shows a number larger than the real one, which
   * is the safer default for a usage figure someone is about to be billed for:
   * a meter that reads high is a complaint, a meter that reads low is a
   * pleasant surprise.
   *
   * `half-even` matches the rounding the arithmetic in this library already
   * uses, and is what you want when the displayed figure should agree with a
   * total computed elsewhere at the same scale.
   */
  rounding?: 'truncate' | 'half-even';
  /** Thousands separators, via `Intl`. Default off — grouping is a locale
   *  decision and a library that guesses gets it wrong in half the world. */
  locale?: string;
  /** Keep trailing zeros (`1.50`) rather than trimming to `1.5`. Default true:
   *  a column of amounts that do not line up is harder to read than one that
   *  does. */
  trailingZeros?: boolean;
}

/** Every key present, so the defaults can be captured and put back exactly. */
type Resolved = {
  decimals: number | undefined;
  rounding: NonNullable<DisplayOptions['rounding']>;
  locale: string | undefined;
  trailingZeros: boolean;
};

const INITIAL: Resolved = {
  decimals: undefined,
  rounding: 'truncate',
  locale: undefined,
  trailingZeros: true,
};

/**
 * Process-wide defaults.
 *
 * Mutable module state in a library is usually a mistake; it is right here for
 * the same reason a locale is set once at startup rather than passed to every
 * `toLocaleString`. It affects display only — no arithmetic, no serialisation,
 * nothing persisted reads it.
 */
let defaults: Resolved = { ...INITIAL };

/**
 * Set the defaults for every `format*` call that does not override them.
 *
 * Merges, so setting one key leaves the rest alone. To clear a key, pass it as
 * `undefined` explicitly — `{ decimals: undefined }` restores the per-type
 * default, where omitting the key entirely would leave whatever was set before.
 * `displayDefaults()` always returns every key for exactly this reason, so
 * `setDisplayDefaults(displayDefaults())` round-trips.
 */
export function setDisplayDefaults(options: DisplayOptions): void {
  // A plain TypeError, not a BillingError: the typed union is for failures a
  // caller branches on, and nobody writes a recovery path for "I passed -1".
  if (options.decimals !== undefined && (!Number.isInteger(options.decimals) || options.decimals < 0)) {
    throw new TypeError(`decimals must be a non-negative integer, got ${options.decimals}`);
  }
  defaults = { ...defaults, ...options };
}

/**
 * The defaults currently in force — every key, including the unset ones.
 *
 * Complete rather than sparse so it can be captured and restored: a sparse
 * snapshot fed back to `setDisplayDefaults` would merge over a later change
 * instead of undoing it, which is a leak between tests and a settings screen
 * that appears not to save.
 */
export function displayDefaults(): Required<Pick<DisplayOptions, 'rounding' | 'trailingZeros'>> &
  Pick<DisplayOptions, 'decimals' | 'locale'> {
  return { ...defaults };
}

/** Back to the shipped defaults. */
export function resetDisplayDefaults(): void {
  defaults = { ...INITIAL };
}

/** Shorten a scaled integer to `decimals` places, without going through a float. */
function shorten(units: bigint, scale: number, decimals: number, rounding: Resolved['rounding']): bigint {
  if (decimals >= scale) return units * 10n ** BigInt(decimals - scale);

  const divisor = 10n ** BigInt(scale - decimals);
  const negative = units < 0n;
  const magnitude = negative ? -units : units;

  let result: bigint;
  if (rounding === 'truncate') {
    result = magnitude / divisor;
  } else {
    const quotient = magnitude / divisor;
    const twice = (magnitude % divisor) * 2n;
    if (twice > divisor) result = quotient + 1n;
    else if (twice < divisor) result = quotient;
    // The tie goes to even, so a long column of halves does not drift one way.
    else result = quotient % 2n === 0n ? quotient : quotient + 1n;
  }
  return negative ? -result : result;
}

function render(units: bigint, decimals: number, options: Resolved): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(decimals + 1, '0');
  const intPart = digits.slice(0, digits.length - decimals);
  let fracPart = decimals === 0 ? '' : digits.slice(digits.length - decimals);

  if (!options.trailingZeros && fracPart !== '') fracPart = fracPart.replace(/0+$/, '');

  const grouped = options.locale
    ? Number(intPart).toLocaleString(options.locale, { maximumFractionDigits: 0, useGrouping: true })
    : intPart;

  const body = fracPart === '' ? grouped : `${grouped}.${fracPart}`;
  return negative ? `-${body}` : body;
}

function resolve(options?: DisplayOptions): Resolved {
  return { ...defaults, ...options };
}

/** A quantity, shortened for display. Two decimal places unless told otherwise. */
export function formatQuantity(quantity: Quantity, options?: DisplayOptions): string {
  const resolved = resolve(options);
  const decimals = resolved.decimals ?? 2;
  return render(shorten(quantity.units, DECIMAL_SCALE, decimals, resolved.rounding), decimals, resolved);
}

/**
 * A rate, shortened for display.
 *
 * Rates are the one place where two places is usually wrong — a per-token price
 * is $0.000015, which shortens to `0.00` and tells the reader nothing. So a
 * rate keeps enough places to show its first significant digit unless
 * `decimals` says otherwise.
 */
export function formatRate(rate: Rate, options?: DisplayOptions): string {
  const resolved = resolve(options);
  const decimals = resolved.decimals ?? significantDecimals(rate.units, DECIMAL_SCALE);
  return render(shorten(rate.units, DECIMAL_SCALE, decimals, resolved.rounding), decimals, resolved);
}

/** Places needed before the first non-zero digit appears, floored at 2. */
function significantDecimals(units: bigint, scale: number): number {
  if (units === 0n) return 2;
  const magnitude = units < 0n ? -units : units;
  const whole = magnitude / 10n ** BigInt(scale);
  if (whole > 0n) return 2;

  const fraction = (magnitude % 10n ** BigInt(scale)).toString().padStart(scale, '0');
  const firstSignificant = fraction.search(/[1-9]/);
  // One place past the first significant digit, so 0.000015 reads 0.000015
  // rather than 0.00001.
  return Math.min(scale, Math.max(2, firstSignificant + 2));
}

/**
 * An amount, shortened for display, with its currency.
 *
 * Defaults to the currency's own exponent, which is what `toDecimalString`
 * already does — so this changes nothing for money unless you ask it to, and
 * exists so an application has one formatter rather than two.
 */
export function formatMoney(money: Money, options?: DisplayOptions & { currency?: boolean }): string {
  const resolved = resolve(options);
  const exponent = currencyExponent(money.currency);
  const decimals = resolved.decimals ?? exponent;
  const body = render(shorten(money.minor, exponent, decimals, resolved.rounding), decimals, resolved);
  return options?.currency === false ? body : `${body} ${money.currency}`;
}
