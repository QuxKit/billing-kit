// providers/tests/compile-time.ts
//
// Assertions the type checker runs, not the test runner.
//
// Every `@ts-expect-error` below fails the build if the error stops happening.
// That makes this file the enforcement for the three anti-patterns and for the
// rule that a provider must state what it cannot do rather than throw when
// asked: none of these is a runtime check that could be removed, commented out,
// or forgotten in a new call site.
//
// It is deliberately not a `.test.ts` — there is nothing to run. `tsc` is the
// assertion, so this file must be inside the typechecked source set.

import { Money } from '../../money';
import { createPaddleProvider } from '../paddle';
import { createStripeProvider } from '../stripe';
import type { BillingProvider, ProviderCustomerId, SettlementRequest } from '../types';
import { providerIdFromOurRecords } from '../types';

const stripe = createStripeProvider({ apiKey: 'x', webhookSecret: 'y' });
const paddle = createPaddleProvider({ apiKey: 'x', webhookSecret: 'y' });

const period = { start: new Date(), end: new Date() };
const customerId = providerIdFromOurRecords<'customer'>('cus_from_our_own_records');
const itemId = providerIdFromOurRecords<'item'>('pri_from_our_own_records');

// ---------------------------------------------------------------------------
// A provider cannot be asked to settle in a mode it did not declare
// ---------------------------------------------------------------------------

void stripe.settle({
  mode: 'lines',
  idempotencyKey: 'k',
  customerId,
  subscriptionId: null,
  period,
  currency: 'USD',
  lines: [{ description: 'tokens', quantity: '1', amount: Money.fromMinor(1n, 'USD') }],
});

const linesRequest: SettlementRequest<'lines'> = {
  mode: 'lines',
  idempotencyKey: 'k',
  customerId,
  subscriptionId: null,
  period,
  currency: 'USD',
  lines: [{ description: 'tokens', quantity: '1', amount: Money.fromMinor(1n, 'USD') }],
};

// @ts-expect-error Paddle is the merchant of record and cannot take an amount we computed.
void paddle.settle(linesRequest);

void paddle.settle({
  mode: 'quantity',
  idempotencyKey: 'k',
  customerId,
  subscriptionId: null,
  period,
  currency: 'USD',
  quantities: [{ itemId, quantity: '1' }],
});

// @ts-expect-error `lines` mode with no lines is not a request, and the union says so.
const incomplete: SettlementRequest<'lines'> = {
  mode: 'lines',
  idempotencyKey: 'k',
  customerId,
  subscriptionId: null,
  period,
  currency: 'USD',
};
void incomplete;

// ---------------------------------------------------------------------------
// A provider that cannot create subscriptions does not have the method
// ---------------------------------------------------------------------------

void stripe.ensureSubscription({
  customerId,
  planKey: 'pro',
  items: [{ priceId: 'price_x' }],
  currency: 'USD',
  idempotencyKey: 'k',
});

// @ts-expect-error A Paddle subscription is created by a checkout, not by us.
void paddle.ensureSubscription({
  customerId,
  planKey: 'pro',
  items: [{ priceId: 'price_x' }],
  currency: 'USD',
  idempotencyKey: 'k',
});

// ---------------------------------------------------------------------------
// NO CLIENT IDS — the IDOR is a type error
// ---------------------------------------------------------------------------

declare const request: { body: { customerId: string; amount: number } };

// @ts-expect-error This is the defect from the reference application: a provider
// customer id taken from the request body. `string` is not a `ProviderCustomerId`,
// so the portal call that leaked another customer's billing history does not compile.
const fromRequestBody: ProviderCustomerId = request.body.customerId;
void fromRequestBody;

// ---------------------------------------------------------------------------
// NO CREDIT — there is no way to move money in
// ---------------------------------------------------------------------------

// @ts-expect-error There is no credit(), topUp() or addFunds() on the boundary.
// Cash reaches the ledger only from a verified `payment.succeeded` webhook, so
// there is no function to call with `request.body.amount`.
void stripe.credit({ customerId, amount: request.body.amount });

// ---------------------------------------------------------------------------
// Money never comes from a JS number
// ---------------------------------------------------------------------------

// @ts-expect-error Once a value has been through a float there is no telling an
// exact 19.99 from one that already drifted, so the type refuses the ambiguity.
void Money.fromMinor(1999, 'USD');

// ---------------------------------------------------------------------------
// Polymorphic code must check a capability before using it
// ---------------------------------------------------------------------------

declare const anyProvider: BillingProvider;

// @ts-expect-error Possibly undefined: the general provider type does not promise
// subscription creation, so the capability has to be checked first.
void anyProvider.ensureSubscription({
  customerId,
  planKey: 'pro',
  items: [{ priceId: 'price_x' }],
  currency: 'USD',
  idempotencyKey: 'k',
});
