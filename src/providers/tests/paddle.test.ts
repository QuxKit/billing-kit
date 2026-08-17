// providers/tests/paddle.test.ts
//
// Paddle is the adapter that proves the interface.
//
// Every test in this file corresponds to something Paddle does that Stripe does
// not, and each of those was a place the abstraction had to give: quantity-only
// settlement, a total that is null on the way out, a refund that is a request
// rather than a fact, a subscription that cannot be created by an API call, a
// customer that can only be recovered by email, and no request idempotency key
// — which makes the ambiguous-failure path a real path rather than a comment.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Money } from '../../money';
import { createPaddleProvider } from '../paddle';
import { providerIdFromOurRecords } from '../types';
import { expectProviderError } from './fixtures/expect';
import { createHttpFixture, FixtureNetworkFailure, noJitter, noSleep, respond } from './fixtures/http';
import * as fx from './fixtures/paddle';

const CUSTOMER = providerIdFromOurRecords<'customer'>('ctm_TEST1');
const PERIOD = { start: new Date('2026-07-01T00:00:00Z'), end: new Date('2026-08-01T00:00:00Z') };

const provider = (fetch: ReturnType<typeof createHttpFixture>['fetch']) =>
  createPaddleProvider({
    apiKey: 'pdl_test_x',
    webhookSecret: fx.PADDLE_SECRET,
    baseUrl: 'https://paddle.test',
    fetch,
    sleep: noSleep,
    random: noJitter,
  });

describe('paddle: settlement is quantity-only', () => {
  it('sends quantities against prices Paddle holds and never an amount', async () => {
    const fixture = createHttpFixture({
      routes: { 'POST /transactions': respond(fx.wrap(fx.transaction())) },
    });
    const result = await provider(fixture.fetch).settle({
      mode: 'quantity',
      idempotencyKey: 'settle:subject-1:2026-07',
      customerId: CUSTOMER,
      subscriptionId: null,
      period: PERIOD,
      currency: 'USD',
      quantities: [{ itemId: providerIdFromOurRecords<'item'>('pri_TEST_TOKENS'), quantity: '1000' }],
    });

    const body = fixture.callsTo('POST', '/transactions')[0]?.body as Record<string, unknown>;
    assert.deepEqual(body.items, [{ price_id: 'pri_TEST_TOKENS', quantity: 1000 }]);
    assert.equal(body.customer_id, 'ctm_TEST1');
    assert.deepEqual(body.custom_data, { billing_kit_settlement: 'settle:subject-1:2026-07' });
    assert.deepEqual(body.billing_period, {
      starts_at: '2026-07-01T00:00:00.000Z',
      ends_at: '2026-08-01T00:00:00.000Z',
    });

    assert.equal(result.ref, 'txn_TEST1');
    // Null, not zero. Paddle has not priced it yet; the real number arrives on
    // settlement.finalized. Defaulting it to zero posts a zero-revenue period
    // that reconciles against nothing.
    assert.equal(result.providerTotal, null);
    assert.equal(result.providerTax, null);
  });

  it('reads the total once Paddle has priced it', async () => {
    const fixture = createHttpFixture({
      routes: {
        'POST /transactions': respond(
          fx.wrap(
            fx.withTotals(fx.transaction(), { subtotal: '4199', tax: '400', total: '4599', grand_total: '4599' }),
          ),
        ),
      },
    });
    const result = await provider(fixture.fetch).settle({
      mode: 'quantity',
      idempotencyKey: 'k',
      customerId: CUSTOMER,
      subscriptionId: null,
      period: PERIOD,
      currency: 'USD',
      quantities: [{ itemId: providerIdFromOurRecords<'item'>('pri_X'), quantity: '1' }],
    });
    assert.equal(result.providerTotal?.minor, 4599n);
    assert.equal(result.providerTotal?.currency, 'USD');
    // Their tax, recorded separately. A merchant of record's tax is its
    // liability, and folding it into our revenue overstates income.
    assert.equal(result.providerTax?.minor, 400n);
  });

  it('refuses a fractional quantity, with no lines mode to fall back to', async () => {
    const fixture = createHttpFixture({ routes: { 'POST /transactions': respond(fx.wrap({})) } });
    const error = await expectProviderError(
      () =>
        provider(fixture.fetch).settle({
          mode: 'quantity',
          idempotencyKey: 'k',
          customerId: CUSTOMER,
          subscriptionId: null,
          period: PERIOD,
          currency: 'USD',
          quantities: [{ itemId: providerIdFromOurRecords<'item'>('pri_X'), quantity: '12.5' }],
        }),
      'invalid_request',
    );
    assert.match(error.message, /aggregate to a whole unit/);
    assert.equal(fixture.calls.length, 0);
  });
});

describe('paddle: no request idempotency key', () => {
  it('sends no idempotency header, because a key it does not honour licenses a retry', async () => {
    const fixture = createHttpFixture({
      routes: { 'POST /customers': respond(fx.wrap(fx.customer())) },
    });
    await provider(fixture.fetch).ensureCustomer({ key: 'subject-1', email: 'ada@example.com' });
    const headers = fixture.callsTo('POST', '/customers')[0]?.headers ?? {};
    assert.ok(!('idempotency-key' in headers));
  });

  it('does not retry a POST that failed in flight', async () => {
    // The whole point. A repeat could create a second customer, so the failure
    // is `ambiguous` and the recovery is a question, not a repetition.
    const fixture = createHttpFixture({
      routes: {
        'POST /customers': () => {
          throw new FixtureNetworkFailure();
        },
        'GET /customers': respond(fx.wrapList([])),
      },
    });
    await expectProviderError(
      () => provider(fixture.fetch).ensureCustomer({ key: 'subject-1', email: 'ada@example.com' }),
      'ambiguous',
    );
    assert.equal(fixture.callsTo('POST', '/customers').length, 1);
  });

  it('recovers by lookup when the failed create had in fact landed', async () => {
    const fixture = createHttpFixture({
      routes: {
        'POST /customers': () => {
          throw new FixtureNetworkFailure();
        },
        'GET /customers': respond(fx.wrapList([fx.customer()])),
      },
    });
    const result = await provider(fixture.fetch).ensureCustomer({
      key: 'subject-1',
      email: 'ada@example.com',
    });
    assert.equal(result.id, 'ctm_TEST1');
    assert.equal(result.key, 'subject-1');
  });

  it('treats a duplicate-email conflict as success', async () => {
    // Propagating the conflict would make every retry after a timeout
    // permanently fatal, which is a state a subject never leaves.
    const fixture = createHttpFixture({
      routes: {
        'POST /customers': respond({ error: { code: 'customer_already_exists', detail: 'email in use' } }, 409),
        'GET /customers': respond(fx.wrapList([fx.customer()])),
      },
    });
    const result = await provider(fixture.fetch).ensureCustomer({
      key: 'subject-1',
      email: 'ada@example.com',
    });
    assert.equal(result.id, 'ctm_TEST1');
  });
});

describe('paddle: what it cannot do, stated rather than thrown at', () => {
  it('has no ensureSubscription at all', () => {
    // A Paddle subscription comes into existence when a customer completes a
    // checkout. The capability says so and the method is absent from the type,
    // so the call does not compile — see tests/compile-time.ts.
    const p = createPaddleProvider({ apiKey: 'x', webhookSecret: 'y' });
    assert.equal(p.capabilities.createsSubscriptions, false);
    assert.equal(p.ensureSubscription, undefined);
  });

  it('declares that customers can only be found by email', () => {
    const p = createPaddleProvider({ apiKey: 'x', webhookSecret: 'y' });
    assert.deepEqual([...p.capabilities.customerLookup], ['email']);
  });

  it('raises rather than answering null when it cannot look a customer up', async () => {
    // `null` means "the create never landed", and the caller's response to that
    // is to create one. On a provider that deduplicates by email that is either
    // a duplicate or a permanent conflict.
    const fixture = createHttpFixture({ routes: {} });
    const error = await expectProviderError(
      () => provider(fixture.fetch).findCustomer({ key: 'subject-1' }),
      'unsupported',
    );
    assert.match(error.message, /customerLookup/);
    assert.equal(fixture.calls.length, 0);
  });
});

describe('paddle: refunds are requests', () => {
  it('reports a pending approval as pending, not as a failure', async () => {
    const fixture = createHttpFixture({
      routes: { 'POST /adjustments': respond(fx.wrap(fx.adjustment())) },
    });
    const ack = await provider(fixture.fetch).refund({
      idempotencyKey: 'refund:1',
      settlementRef: providerIdFromOurRecords<'settlement'>('txn_TEST1'),
      amount: null,
    });
    assert.equal(ack.status, 'pending');
    const body = fixture.callsTo('POST', '/adjustments')[0]?.body as Record<string, unknown>;
    assert.equal(body.type, 'full');
    assert.equal(body.action, 'refund');
  });

  it('allocates a partial refund to the single line it can', async () => {
    const fixture = createHttpFixture({
      routes: {
        'GET /transactions/:id': respond(fx.wrap(fx.transaction())),
        'POST /adjustments': respond(fx.wrap(fx.adjustment({ status: 'approved' }))),
      },
    });
    const ack = await provider(fixture.fetch).refund({
      idempotencyKey: 'refund:1',
      settlementRef: providerIdFromOurRecords<'settlement'>('txn_TEST1'),
      amount: Money.fromMinor(500n, 'USD'),
    });
    assert.equal(ack.status, 'settled');
    const body = fixture.callsTo('POST', '/adjustments')[0]?.body as Record<string, unknown>;
    assert.deepEqual(body.items, [{ item_id: 'txnitm_TEST1', type: 'partial', amount: '500' }]);
  });

  it('refuses a partial refund it would have to invent an allocation for', async () => {
    const fixture = createHttpFixture({
      routes: {
        'GET /transactions/:id': respond(
          fx.wrap(
            fx.transaction({
              items: [
                { id: 'txnitm_1', price: { id: 'pri_1' }, quantity: 1 },
                { id: 'txnitm_2', price: { id: 'pri_2' }, quantity: 1 },
              ],
            }),
          ),
        ),
      },
    });
    const error = await expectProviderError(
      () =>
        provider(fixture.fetch).refund({
          idempotencyKey: 'refund:1',
          settlementRef: providerIdFromOurRecords<'settlement'>('txn_TEST1'),
          amount: Money.fromMinor(500n, 'USD'),
        }),
      'invalid_request',
    );
    assert.match(error.message, /allocated across/);
  });
});

describe('paddle: recovery without a searchable key', () => {
  it('bounds the list by customer and period, then matches custom_data locally', async () => {
    const fixture = createHttpFixture({
      routes: {
        'GET /transactions': respond(
          fx.wrapList([fx.transaction({ id: 'txn_OTHER', custom_data: {} }), fx.transaction()]),
        ),
      },
    });
    const found = await provider(fixture.fetch).findSettlement({
      key: 'settle:subject-1:2026-07',
      customerId: CUSTOMER,
      period: PERIOD,
    });
    assert.equal(found?.ref, 'txn_TEST1');
    const call = fixture.callsTo('GET', '/transactions')[0];
    assert.equal(call?.query.customer_id, 'ctm_TEST1');
    assert.equal(call?.query['created_at[GTE]'], '2026-07-01T00:00:00.000Z');
  });

  it('returns null when the key is on none of them', async () => {
    const fixture = createHttpFixture({
      routes: { 'GET /transactions': respond(fx.wrapList([fx.transaction({ custom_data: {} })])) },
    });
    const found = await provider(fixture.fetch).findSettlement({
      key: 'settle:subject-1:2026-07',
      customerId: CUSTOMER,
      period: PERIOD,
    });
    assert.equal(found, null);
  });
});

describe('paddle: webhook normalisation', () => {
  const verify = async (payload: unknown, seconds = 1_767_225_600) => {
    const text = JSON.stringify(payload);
    const p = createPaddleProvider({
      apiKey: 'x',
      webhookSecret: fx.PADDLE_SECRET,
      now: () => seconds * 1000,
    });
    return p.verifyWebhook({
      body: new TextEncoder().encode(text),
      headers: { 'paddle-signature': fx.signPaddle(text, seconds) },
    });
  };

  it('reads string minor units without going through a float', async () => {
    const event = await verify(
      fx.event('transaction.billed', fx.withTotals(fx.transaction(), { subtotal: '4199', tax: '400', total: '4599' })),
    );
    assert.equal(event.kind, 'settlement.finalized');
    if (event.kind !== 'settlement.finalized') return;
    assert.equal(event.total.minor, 4599n);
    assert.equal(event.tax?.minor, 400n);
  });

  it('posts cash at the amount actually charged, after credits', async () => {
    // grand_total is what left the customer's card; total is gross. Posting the
    // gross records money arriving that a credit already cancelled.
    const event = await verify(
      fx.event(
        'transaction.completed',
        fx.withTotals(fx.transaction({ status: 'completed' }), {
          total: '4599',
          grand_total: '4099',
          tax: '400',
        }),
      ),
    );
    assert.equal(event.kind, 'payment.succeeded');
    if (event.kind !== 'payment.succeeded') return;
    assert.equal(event.amount.minor, 4099n);
  });

  it('parses a microsecond timestamp the same way on every runtime', async () => {
    const event = await verify(fx.event('transaction.canceled', fx.transaction()));
    assert.equal(event.occurredAt.toISOString(), '2026-07-01T12:00:00.123Z');
  });

  it('leaves a refund awaiting approval as unknown', async () => {
    // Neither settled nor declined is true yet, so neither ledger entry is
    // written.
    const event = await verify(fx.event('adjustment.updated', fx.adjustment()));
    assert.equal(event.kind, 'unknown');
    if (event.kind !== 'unknown') return;
    assert.match(event.providerKind, /pending_approval/);
  });

  it('maps an approved refund to a settled one, with its transaction', async () => {
    const event = await verify(fx.event('adjustment.updated', fx.adjustment({ status: 'approved' })));
    assert.equal(event.kind, 'refund.settled');
    if (event.kind !== 'refund.settled') return;
    assert.equal(event.amount.minor, 4599n);
    assert.equal(event.settlementRef, 'txn_TEST1');
  });

  it('maps a rejected refund to declined', async () => {
    const event = await verify(fx.event('adjustment.updated', fx.adjustment({ status: 'rejected' })));
    assert.equal(event.kind, 'refund.declined');
  });

  it('does not treat a credit adjustment as a refund', async () => {
    const event = await verify(fx.event('adjustment.updated', fx.adjustment({ action: 'credit', status: 'approved' })));
    assert.equal(event.kind, 'unknown');
  });
});

describe('paddle: subscriptions', () => {
  it('cancels at the period end when asked to', async () => {
    const fixture = createHttpFixture({
      routes: { 'POST /subscriptions/:id/cancel': respond(fx.wrap(fx.subscription({ status: 'canceled' }))) },
    });
    const result = await provider(fixture.fetch).cancelSubscription(
      providerIdFromOurRecords<'subscription'>('sub_TEST1'),
      'period_end',
    );
    assert.equal(result.status, 'canceled');
    const body = fixture.callsTo('POST', '/subscriptions/:id/cancel')[0]?.body as Record<string, unknown>;
    assert.equal(body.effective_from, 'next_billing_period');
  });

  it('resolves our metric from the price custom_data', async () => {
    const fixture = createHttpFixture({
      routes: { 'GET /subscriptions/:id': respond(fx.wrap(fx.subscription())) },
    });
    const item = await provider(fixture.fetch).resolveItem(
      providerIdFromOurRecords<'subscription'>('sub_TEST1'),
      'tokens',
    );
    assert.equal(item?.id, 'pri_TEST_TOKENS');
  });
});
