// providers/capabilities.ts
//
// Every decision billing-kit makes about a provider is made here, from the
// capability descriptor, and never from the provider's name.
//
// The rule is worth stating as a rule because it is the one that decays first.
// `if (provider.name === 'stripe')` is always the shortest way to fix today's
// bug, and each one makes the next provider a rewrite rather than a file. The
// rule is enforceable in review: grep the source for `.name` and every hit
// should be a log line, an error message, or a test.

import { ProviderError } from './errors';
import type {
  BillingProvider,
  ProviderCapabilities,
  SettlementMode,
} from './types';

export const supportsSettlement = (
  capabilities: ProviderCapabilities,
  mode: SettlementMode,
): boolean => capabilities.settlement.includes(mode);

/**
 * The runtime guard for the dynamic path.
 *
 * Statically typed call sites cannot reach this: `settle` narrows its parameter
 * to the modes the provider declared, so `paddle.settle({ mode: 'lines', ... })`
 * does not compile. This exists for the case where the mode came out of a
 * configuration row, and it fails before any provider call rather than halfway
 * through settling a period.
 */
export const assertSettlementMode = (
  provider: BillingProvider,
  mode: SettlementMode,
): void => {
  if (supportsSettlement(provider.capabilities, mode)) return;
  throw new ProviderError({
    kind: 'unsupported',
    provider: provider.name,
    message:
      `${provider.name} cannot settle in '${mode}' mode; it declares ` +
      `[${provider.capabilities.settlement.join(', ')}]. This is a capability, ` +
      `not an outage — change the configured mode, do not retry.`,
  });
};

/**
 * Pick a mode for a provider, preferring the caller's choice.
 *
 * Deliberately not a fallback. If the caller asked for a mode the provider
 * cannot serve, this raises rather than quietly settling the other way: the two
 * modes disagree about who owns the price, and swapping them without telling
 * the ledger produces a variance nobody can attribute a month later.
 */
export const settlementModeFor = (
  provider: BillingProvider,
  preferred?: SettlementMode,
): SettlementMode => {
  if (preferred !== undefined) {
    assertSettlementMode(provider, preferred);
    return preferred;
  }
  const [first] = provider.capabilities.settlement;
  if (first === undefined) {
    throw new ProviderError({
      kind: 'unsupported',
      provider: provider.name,
      message: `${provider.name} declares no settlement mode and cannot settle anything.`,
    });
  }
  return first;
};

/**
 * Narrow a provider to one that can create subscriptions.
 *
 * Polymorphic code holds `BillingProvider<ProviderCapabilities>`, where the
 * method is optional because the capability is `boolean`. This is the check
 * that makes it callable, and writing it as a predicate rather than an
 * `if (caps.createsSubscriptions)` is what stops the check drifting away from
 * the call it guards.
 */
export const canCreateSubscriptions = (
  provider: BillingProvider,
): provider is BillingProvider<ProviderCapabilities & { createsSubscriptions: true }> =>
  provider.capabilities.createsSubscriptions;

/**
 * Whether this ref carries the field the provider can actually search by.
 *
 * Checked before `findCustomer`, because the failure it prevents is subtle: a
 * provider that cannot answer returns nothing, "nothing" reads as "the create
 * never landed", and the recovery path creates a second customer for a subject
 * that already has one.
 */
export const canFindCustomer = (
  capabilities: ProviderCapabilities,
  ref: { key: string; email?: string },
): boolean =>
  capabilities.customerLookup.includes('key') ||
  (capabilities.customerLookup.includes('email') && ref.email !== undefined);

/**
 * Whether our computed amount is the authority for this settlement.
 *
 * False when the provider prices it — either because it is the legal seller, or
 * because we sent a quantity against a price it holds. The ledger records both
 * numbers in that case and posts the gap to a variance account, which alerts.
 * Absorbing the gap silently is how a rounding difference becomes a reconciled
 * ledger that is quietly wrong.
 */
export const ourAmountIsAuthoritative = (
  capabilities: ProviderCapabilities,
  mode: SettlementMode,
): boolean => !capabilities.merchantOfRecord && mode === 'lines';

/**
 * Whether a settled period may post cash to the ledger on the strength of the
 * settlement alone.
 *
 * False where the provider only invoices and hands off to a PSP. Posting cash
 * there records money that has not arrived, and the error is invisible until
 * someone compares the ledger to a bank statement.
 */
export const settlementPostsCash = (capabilities: ProviderCapabilities): boolean =>
  capabilities.capturesPayment;

/**
 * Whether tax on a settlement is ours to account for.
 *
 * A merchant of record collects and remits its own tax. Folding it into our
 * revenue overstates income and creates a liability we do not owe.
 */
export const taxIsOurs = (capabilities: ProviderCapabilities): boolean =>
  !capabilities.merchantOfRecord;
