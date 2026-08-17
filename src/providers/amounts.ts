// providers/amounts.ts
//
// Reading money out of a provider's JSON.
//
// This is the boundary where exactness is lost in most billing code, and it is
// lost quietly. `JSON.parse` produces a JS number for every numeric literal, so
// a provider that sends `1999` hands us a double. That particular double is
// exact — but nothing in the code says so, and the first provider that sends a
// fractional amount, or an amount above 2^53, turns a silent assumption into a
// wrong ledger.
//
// So the assumption is asserted instead. A numeric amount must be a safe
// integer or the response is rejected as malformed. The provider changing its
// representation then produces an error naming the field, rather than a total
// that is slightly wrong in a direction that correlates with volume.

import { Money } from '../money';
import { ProviderError } from './errors';

const malformed = (provider: string, field: string, value: unknown): ProviderError =>
  new ProviderError({
    kind: 'malformed_response',
    provider,
    message:
      `${provider}: field '${field}' is not an exact minor-unit amount ` +
      `(got ${typeof value} ${JSON.stringify(value)}). Refusing to guess.`,
    raw: value,
  });

/**
 * Read an amount a provider sent as a JSON number.
 *
 * Rejects anything that is not a safe integer. A non-integer here means the
 * provider is not sending minor units and the adapter's assumption is wrong;
 * rounding it would hide that.
 */
export const moneyFromNumber = (value: unknown, currency: string, provider: string, field: string): Money => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw malformed(provider, field, value);
  }
  return Money.fromMinor(BigInt(value), currency);
};

/**
 * Read an amount a provider sent as a decimal string of minor units, e.g.
 * `"1999"`. The better representation, and the one to prefer where a provider
 * offers both: it crosses `JSON.parse` untouched.
 */
export const moneyFromMinorString = (value: unknown, currency: string, provider: string, field: string): Money => {
  if (typeof value !== 'string' || !/^-?\d{1,30}$/.test(value)) {
    throw malformed(provider, field, value);
  }
  return Money.fromMinor(BigInt(value), currency);
};

/** As above, but `null` when the provider has not priced the thing yet. A null
 *  total is a real state on a merchant of record and must not become zero. */
export const optionalMoneyFromMinorString = (
  value: unknown,
  currency: string,
  provider: string,
  field: string,
): Money | null =>
  value === null || value === undefined ? null : moneyFromMinorString(value, currency, provider, field);

export const optionalMoneyFromNumber = (
  value: unknown,
  currency: string,
  provider: string,
  field: string,
): Money | null => (value === null || value === undefined ? null : moneyFromNumber(value, currency, provider, field));

/**
 * Providers speak lowercase currency; ISO 4217 is uppercase, and `Money`
 * refuses a code it does not know. Normalising here rather than in five call
 * sites keeps the failure ("no such currency") meaningful.
 */
export const normaliseCurrency = (value: unknown, provider: string, field: string): string => {
  if (typeof value !== 'string' || !/^[A-Za-z]{3}$/.test(value)) {
    throw new ProviderError({
      kind: 'malformed_response',
      provider,
      message: `${provider}: field '${field}' is not an ISO 4217 code (got ${JSON.stringify(value)}).`,
      raw: value,
    });
  }
  return value.toUpperCase();
};

/**
 * A quantity crossing to a provider that only accepts whole units.
 *
 * Returns null when the value is not a whole number. The caller turns that into
 * a typed error naming the alternative, because silently truncating 1.5 GB-hours
 * to 1 is a billing error that never shows up as an error.
 */
export const asWholeQuantity = (quantity: string): string | null => {
  if (!/^\d+(\.0+)?$/.test(quantity)) return null;
  return quantity.split('.')[0] ?? null;
};
