// providers/tests/stripe.test.ts
//
// What is specific to Stripe, and therefore not in the contract suite.
//
// The settlement tests assert the *sequence* and the *keys*, not just the
// result. Settling on Stripe is three calls and is not atomic; the only thing
// that makes a crash between them survivable is that every call carries a key
// derived from the caller's settlement key. A test that only checked the
// returned invoice would pass with the keys removed.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Money } from '../../money';
import { createStripeProvider } from '../stripe';
import type { ProviderCustomerId, ProviderItemId, ProviderSettlementId } from '../types';
import { providerIdFromOurRecords } from '../types';
import { expectProviderError } from './fixtures/expect';
import { createHttpFixture, failThen, noJitter, noSleep, respond } from './fixtures/http';
import * as fx from './fixtures/stripe';

const CUSTOMER = providerIdFromOurRecords<'customer'>('cus_TEST1');
const PERIOD = { start: new Date('2026-07-01T00:00:00Z'), end: new Date('2026-08-01T00:00:00Z') };

const provider = (fetch: ReturnType<typeof createHttpFixture>['fetch']) =>
  createStripeProvider({
    apiKey: 'sk_test_x',
    webhookSecret: fx.STRIPE_SECRET,
    baseUrl: 'https://stripe.test',
    fetch,
    sleep: noSleep,
    random: noJitter,
  });

const settleRoutes = () => ({
  'POST /v1/invoiceitems': respond({ id: 'ii_TEST', object: 'invoiceitem' }),
  'POST /v1/invoices': respond(fx.invoice({ status: 'draft' })),
  'POST /v1/invoices/:id/finalize': respond(fx.invoice({ status: 'open' })),
});

describe('stripe: settlement in lines mode', () => {
  it('writes one invoice item per line, then creates and finalizes', async () => {
    const fixture = createHttpFixture({ routes: settleRoutes() });
    const result = await provider(fixture.fetch).settle({
      mode: 'lines',
      idempotencyKey: 'settle:subject-1:2026-07',
      customerId: CUSTOMER,
      subscriptionId: null,
      period: PERIOD,
      currency: 'USD',
      lines: [
        { description: 'tokens', quantity: '1500000', amount: Money.fromMinor(3599n, 'USD') },
        { description: 'storage', quantity: '12.5', amount: Money.fromMinor(1000n, 'USD') },
      ],
    });

    assert.deepEqual(
      fixture.calls.map((call) => `${call.method} ${call.path}`),
      ['POST /v1/invoiceitems', 'POST /v1/invoiceitems', 'POST /v1/invoices', 'POST /v1/invoices/in_TEST1/finalize'],
    );

    const items = fixture.callsTo('POST', '/v1/invoiceitems');
    const first = items[0]?.body as Record<string, string>;
    assert.equal(first['amount'], '3599');
    assert.equal(first['currency'], 'usd');
    // The quantity travels as metadata. Stripe's `quantity` multiplies a unit
    // price, and `amount` is already the total — sending both doubles the line.
    assert.equal(first['metadata[billing_kit_quantity]'], '1500000');
    assert.equal(first['quantity'], undefined);
    // A fractional quantity survives intact in lines mode, because we computed
    // the amount and Stripe is only being told what it was for.
    assert.equal((items[1]?.body as Record<string, string>)['metadata[billing_kit_quantity]'], '12.5');

    assert.equal(items[0]?.headers['idempotency-key'], 'settle:subject-1:2026-07:line:0');
    assert.equal(items[1]?.headers['idempotency-key'], 'settle:subject-1:2026-07:line:1');
    assert.equal(
      fixture.callsTo('POST', '/v1/invoices')[0]?.headers['idempotency-key'],
      'settle:subject-1:2026-07:invoice',
    );
    assert.equal(
      fixture.callsTo('POST', '/v1/invoices/:id/finalize')[0]?.headers['idempotency-key'],
      'settle:subject-1:2026-07:finalize',
    );

    assert.equal(result.ref, 'in_TEST1');
    assert.equal(result.status, 'open');
    assert.equal(result.providerTotal?.minor, 4599n);
    assert.equal(result.providerTax?.minor, 400n);
  });

  it('sweeps the pending items onto the invoice it just created', async () => {
    // Without pending_invoice_items_behavior=include the invoice is created
    // empty and the items wait for some later invoice, which bills this month's
    // usage next month.
    const fixture = createHttpFixture({ routes: settleRoutes() });
    await provider(fixture.fetch).settle({
      mode: 'lines',
      idempotencyKey: 'k',
      customerId: CUSTOMER,
      subscriptionId: null,
      period: PERIOD,
      currency: 'USD',
      lines: [{ description: 'tokens', quantity: '1', amount: Money.fromMinor(100n, 'USD') }],
    });
    const invoice = fixture.callsTo('POST', '/v1/invoices')[0]?.body as Record<string, string>;
    assert.equal(invoice['pending_invoice_items_behavior'], 'include');
    assert.equal(invoice['metadata[billing_kit_settlement]'], 'k');
  });

  it('refuses a line in a different currency from the settlement', async () => {
    const fixture = createHttpFixture({ routes: settleRoutes() });
    await expectProviderError(
      () =>
        provider(fixture.fetch).settle({
          mode: 'lines',
          idempotencyKey: 'k',
          customerId: CUSTOMER,
          subscriptionId: null,
          period: PERIOD,
          currency: 'USD',
          lines: [{ description: 'tokens', quantity: '1', amount: Money.fromMinor(100n, 'EUR') }],
        }),
      'invalid_request',
    );
    assert.equal(fixture.calls.length, 0, 'must fail before writing anything');
  });
});

describe('stripe: settlement in quantity mode', () => {
  it('sends the quantity against a price Stripe holds', async () => {
    const fixture = createHttpFixture({ routes: settleRoutes() });
    await provider(fixture.fetch).settle({
      mode: 'quantity',
      idempotencyKey: 'k',
      customerId: CUSTOMER,
      subscriptionId: null,
      period: PERIOD,
      currency: 'USD',
      quantities: [{ itemId: providerIdFromOurRecords<'item'>('price_X'), quantity: '1200' }],
    });
    const item = fixture.callsTo('POST', '/v1/invoiceitems')[0]?.body as Record<string, string>;
    assert.equal(item['price'], 'price_X');
    assert.equal(item['quantity'], '1200');
    assert.equal(item['amount'], undefined, 'we do not price it in quantity mode');
  });

  it('refuses a fractional quantity instead of truncating it', async () => {
    // Stripe multiplies an integer quantity by a stored unit price. Truncating
    // 12.5 to 12 is a billing error that produces no error.
    const fixture = createHttpFixture({ routes: settleRoutes() });
    const error = await expectProviderError(
      () =>
        provider(fixture.fetch).settle({
          mode: 'quantity',
          idempotencyKey: 'k',
          customerId: CUSTOMER,
          subscriptionId: null,
          period: PERIOD,
          currency: 'USD',
          quantities: [{ itemId: providerIdFromOurRecords<'item'>('price_X'), quantity: '12.5' }],
        }),
      'invalid_request',
    );
    assert.match(error.message, /'lines' mode/);
    assert.equal(fixture.calls.length, 0);
  });
});

describe('stripe: recovery', () => {
  it('falls back from the lagging search index to the exact email index', async () => {
    // Stripe's search is eventually consistent by about a minute, which is
    // exactly the window a recovery runs in.
    const fixture = createHttpFixture({
      routes: {
        'GET /v1/customers/search': respond(fx.list([])),
        'GET /v1/customers': respond(fx.list([fx.customer()])),
      },
    });
    const found = await provider(fixture.fetch).findCustomer({
      key: 'subject-1',
      email: 'ada@example.com',
    });
    assert.equal(found?.id, 'cus_TEST1');
    assert.equal(found?.key, 'subject-1');
  });

  it('does not return a same-email customer belonging to another subject', async () => {
    const fixture = createHttpFixture({
      routes: {
        'GET /v1/customers/search': respond(fx.list([])),
        'GET /v1/customers': respond(fx.list([fx.customer({ metadata: { billing_kit_subject: 'subject-999' } })])),
      },
    });
    const found = await provider(fixture.fetch).findCustomer({
      key: 'subject-1',
      email: 'ada@example.com',
    });
    assert.equal(found, null);
  });

  it('finds a settlement by listing when search has not indexed it', async () => {
    const fixture = createHttpFixture({
      routes: {
        'GET /v1/invoices/search': respond(fx.list([])),
        'GET /v1/invoices': respond(fx.list([fx.invoice()])),
      },
    });
    const found = await provider(fixture.fetch).findSettlement({
      key: 'settle:subject-1:2026-07',
      customerId: CUSTOMER,
      period: PERIOD,
    });
    assert.equal(found?.ref, 'in_TEST1');
    // The list is bounded by customer and period, which is why the lookup is a
    // record rather than a bare key.
    const listed = fixture.callsTo('GET', '/v1/invoices')[0];
    assert.equal(listed?.query['customer'], 'cus_TEST1');
    assert.equal(listed?.query['created[gte]'], String(Math.floor(PERIOD.start.getTime() / 1000)));
  });

  it('returns null when nothing matches, rather than the first invoice it saw', async () => {
    const fixture = createHttpFixture({
      routes: {
        'GET /v1/invoices/search': respond(fx.list([])),
        'GET /v1/invoices': respond(fx.list([fx.invoice({ metadata: {} })])),
      },
    });
    const found = await provider(fixture.fetch).findSettlement({
      key: 'settle:subject-1:2026-07',
      customerId: CUSTOMER,
      period: PERIOD,
    });
    assert.equal(found, null);
  });

  it('retries a keyed POST through a transient 500', async () => {
    const fixture = createHttpFixture({
      routes: { 'POST /v1/customers': failThen(2, respond(fx.customer())) },
    });
    const result = await provider(fixture.fetch).ensureCustomer({
      key: 'subject-1',
      email: 'ada@example.com',
    });
    assert.equal(result.id, 'cus_TEST1');
    assert.equal(fixture.calls.length, 3);
    // Every attempt is the same request under the same key, so Stripe collapses
    // them. Without the key this would be three customers.
    const keys = new Set(fixture.calls.map((call) => call.headers['idempotency-key']));
    assert.deepEqual([...keys], ['customer:subject-1']);
  });
});

describe('stripe: refunds', () => {
  it('resolves the payment behind the invoice rather than taking one from the caller', async () => {
    const fixture = createHttpFixture({
      routes: {
        'GET /v1/invoices/:id': respond(fx.invoice({ status: 'paid' })),
        'POST /v1/refunds': respond({ id: 're_TEST1', object: 'refund', status: 'succeeded' }),
      },
    });
    const ack = await provider(fixture.fetch).refund({
      idempotencyKey: 'refund:1',
      settlementRef: providerIdFromOurRecords<'settlement'>('in_TEST1') as ProviderSettlementId,
      amount: Money.fromMinor(500n, 'USD'),
    });
    assert.equal(ack.status, 'settled');
    const call = fixture.callsTo('POST', '/v1/refunds')[0]?.body as Record<string, string>;
    assert.equal(call['payment_intent'], 'pi_TEST1');
    assert.equal(call['amount'], '500');
  });

  it('refuses to refund an invoice that was never paid', async () => {
    // Refunding an unpaid invoice posts cash out that never came in. It is
    // voided, not refunded.
    const fixture = createHttpFixture({
      routes: { 'GET /v1/invoices/:id': respond(fx.invoice({ payment_intent: null })) },
    });
    await expectProviderError(
      () =>
        provider(fixture.fetch).refund({
          idempotencyKey: 'refund:1',
          settlementRef: providerIdFromOurRecords<'settlement'>('in_TEST1'),
          amount: null,
        }),
      'invalid_request',
    );
  });
});

describe('stripe: webhook normalisation', () => {
  const verify = async (payload: unknown, seconds = 1_767_225_600) => {
    const text = JSON.stringify(payload);
    const p = createStripeProvider({
      apiKey: 'sk_test_x',
      webhookSecret: fx.STRIPE_SECRET,
      baseUrl: 'https://stripe.test',
      now: () => seconds * 1000,
    });
    return p.verifyWebhook({
      body: new TextEncoder().encode(text),
      headers: { 'stripe-signature': fx.signStripe(text, seconds) },
    });
  };

  it('reads a payment as minor units in the invoice currency', async () => {
    const event = await verify(
      fx.event('invoice.payment_succeeded', { id: 'in_1', currency: 'usd', amount_paid: 4599 }),
    );
    assert.equal(event.kind, 'payment.succeeded');
    if (event.kind !== 'payment.succeeded') return;
    assert.equal(event.amount.minor, 4599n);
    assert.equal(event.amount.currency, 'USD');
    assert.equal(event.settlementRef, 'in_1');
  });

  it('sums the newer total_taxes list as well as the older tax field', async () => {
    // Reading only one of the two silently reports zero tax on accounts using
    // the other, which understates a liability rather than breaking a screen.
    const event = await verify(
      fx.event('invoice.finalized', {
        id: 'in_1',
        currency: 'usd',
        total: 5000,
        total_taxes: [{ amount: 300 }, { amount: 200 }],
      }),
    );
    assert.equal(event.kind, 'settlement.finalized');
    if (event.kind !== 'settlement.finalized') return;
    assert.equal(event.total.minor, 5000n);
    assert.equal(event.tax?.minor, 500n);
  });

  it('does not treat an in-flight refund as settled', async () => {
    const event = await verify(
      fx.event('refund.updated', { id: 're_1', currency: 'usd', amount: 500, status: 'pending' }),
    );
    assert.equal(event.kind, 'unknown');
  });

  it('rejects an amount that is not an exact integer', async () => {
    // The assumption "provider amounts are integer minor units" is asserted
    // rather than assumed, so a provider changing representation is an error
    // naming the field and not a total that is quietly wrong.
    await expectProviderError(
      () => verify(fx.event('invoice.payment_succeeded', { id: 'in_1', currency: 'usd', amount_paid: 45.99 })),
      'malformed_response',
    );
  });

  it('maps a deleted subscription to canceled', async () => {
    const event = await verify(fx.event('customer.subscription.deleted', { id: 'sub_1', status: 'active' }));
    assert.equal(event.kind, 'subscription.changed');
    if (event.kind !== 'subscription.changed') return;
    assert.equal(event.status, 'canceled');
  });
});

describe('stripe: item resolution', () => {
  it('maps our metric key to the price that declares it', async () => {
    const fixture = createHttpFixture({
      routes: { 'GET /v1/subscriptions/:id': respond(fx.subscription()) },
    });
    const item = await provider(fixture.fetch).resolveItem(
      providerIdFromOurRecords<'subscription'>('sub_TEST1'),
      'tokens',
    );
    assert.equal(item?.id as ProviderItemId | undefined, 'price_TEST_TOKENS');
    assert.equal(item?.metric, 'tokens');
  });

  it('returns null for a metric this provider holds no price for', async () => {
    const fixture = createHttpFixture({
      routes: { 'GET /v1/subscriptions/:id': respond(fx.subscription()) },
    });
    const item = await provider(fixture.fetch).resolveItem(
      providerIdFromOurRecords<'subscription'>('sub_TEST1'),
      'storage',
    );
    assert.equal(item, null);
  });
});

describe('stripe: customers', () => {
  it('never lets a provider customer id enter from outside', () => {
    // Compile-time, not runtime: see tests/compile-time.ts. Recorded here so
    // the property is visible in the suite that documents the boundary.
    const stored: string = 'cus_from_our_database';
    const id: ProviderCustomerId = providerIdFromOurRecords<'customer'>(stored);
    assert.equal(id, 'cus_from_our_database');
  });
});
