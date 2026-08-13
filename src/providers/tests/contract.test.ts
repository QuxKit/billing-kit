// providers/tests/contract.test.ts
//
// One suite, run against every adapter.
//
// This file is the actual proof that the interface is not one provider wearing
// a costume. Everything asserted here is asserted identically of Stripe and of
// Paddle, two providers that disagree about who the merchant is, whether an
// invoice can carry an amount we computed, whether a subscription can be
// created at all, and whether a refund is a fact or a request. If a third
// adapter is added, it is added to the table at the bottom and either it passes
// or the interface was wrong.
//
// The webhook assertions are the ones that earn their keep. Signature
// verification over raw bytes is the single most common integration bug in
// payment code, and the JSON round-trip case below is the exact shape of it.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { assertSettlementMode, canCreateSubscriptions } from '../capabilities';
import type { BillingProvider, CustomerRef, SettlementMode } from '../types';
import { createPaddleProvider } from '../paddle';
import { createStripeProvider } from '../stripe';
import { expectProviderError, expectProviderErrorSync } from './fixtures/expect';
import { createHttpFixture, respond, type RecordedCall } from './fixtures/http';
import * as paddleFixtures from './fixtures/paddle';
import * as stripeFixtures from './fixtures/stripe';

const NOW_SECONDS = 1_767_225_600;
const now = () => NOW_SECONDS * 1000;

interface Harness {
  name: string;
  provider: BillingProvider;
  /** A settlement mode the provider does NOT support, or null when it supports
   *  every mode there is. */
  unsupportedMode: SettlementMode | null;
  signatureHeader: string;
  sign(body: string, timestampSeconds: number): string;
  /** An event the adapter models, and the kind it must normalise to. */
  modelled: { body: unknown; kind: string };
  /** An event with a valid signature and a type we do not model. */
  unmodelled: unknown;
  /** Run ensureCustomer against a fixture and hand back the recorded POST. */
  ensureCustomerCall(ref: CustomerRef): Promise<RecordedCall>;
}

const stripeHarness = (): Harness => ({
  name: 'stripe',
  provider: createStripeProvider({
    apiKey: 'sk_test_x',
    webhookSecret: stripeFixtures.STRIPE_SECRET,
    baseUrl: 'https://stripe.test',
    now,
  }),
  unsupportedMode: null,
  signatureHeader: 'stripe-signature',
  sign: (body, ts) => stripeFixtures.signStripe(body, ts),
  modelled: {
    body: stripeFixtures.event('invoice.payment_succeeded', {
      id: 'in_TEST1',
      currency: 'usd',
      amount_paid: 4599,
    }),
    kind: 'payment.succeeded',
  },
  unmodelled: stripeFixtures.event('radar.early_fraud_warning.created', { id: 'issfr_1' }),
  ensureCustomerCall: async (ref) => {
    const fixture = createHttpFixture({
      routes: { 'POST /v1/customers': respond(stripeFixtures.customer()) },
    });
    const provider = createStripeProvider({
      apiKey: 'sk_test_x',
      webhookSecret: stripeFixtures.STRIPE_SECRET,
      baseUrl: 'https://stripe.test',
      fetch: fixture.fetch,
    });
    await provider.ensureCustomer(ref);
    const [call] = fixture.callsTo('POST', '/v1/customers');
    assert.ok(call);
    return call;
  },
});

const paddleHarness = (): Harness => ({
  name: 'paddle',
  provider: createPaddleProvider({
    apiKey: 'pdl_test_x',
    webhookSecret: paddleFixtures.PADDLE_SECRET,
    baseUrl: 'https://paddle.test',
    now,
  }),
  unsupportedMode: 'lines',
  signatureHeader: 'paddle-signature',
  sign: (body, ts) => paddleFixtures.signPaddle(body, ts),
  modelled: {
    body: paddleFixtures.event(
      'transaction.completed',
      paddleFixtures.withTotals(paddleFixtures.transaction({ status: 'completed' }), {
        subtotal: '4199',
        tax: '400',
        total: '4599',
        grand_total: '4599',
      }),
    ),
    kind: 'payment.succeeded',
  },
  unmodelled: paddleFixtures.event('report.created', { id: 'rep_1' }),
  ensureCustomerCall: async (ref) => {
    const fixture = createHttpFixture({
      routes: { 'POST /customers': respond(paddleFixtures.wrap(paddleFixtures.customer())) },
    });
    const provider = createPaddleProvider({
      apiKey: 'pdl_test_x',
      webhookSecret: paddleFixtures.PADDLE_SECRET,
      baseUrl: 'https://paddle.test',
      fetch: fixture.fetch,
    });
    await provider.ensureCustomer(ref);
    const [call] = fixture.callsTo('POST', '/customers');
    assert.ok(call);
    return call;
  },
});

const harnesses: Harness[] = [stripeHarness(), paddleHarness()];

for (const harness of harnesses) {
  describe(`provider contract: ${harness.name}`, () => {
    const { provider } = harness;

    const signed = (payload: unknown, ts = NOW_SECONDS, body?: string) => {
      const text = body ?? JSON.stringify(payload, null, 2);
      return {
        body: new TextEncoder().encode(text),
        headers: { [harness.signatureHeader]: harness.sign(text, ts) },
        text,
      };
    };

    it('declares at least one settlement mode and one customer lookup', () => {
      assert.ok(provider.capabilities.settlement.length > 0);
      assert.ok(provider.capabilities.customerLookup.length > 0);
    });

    it('verifies a webhook signed over the exact bytes', async () => {
      const request = signed(harness.modelled.body);
      const event = await provider.verifyWebhook(request);
      assert.equal(event.kind, harness.modelled.kind);
      assert.ok(event.providerEventId.length > 0);
      assert.ok(event.occurredAt instanceof Date);
      assert.ok(!Number.isNaN(event.occurredAt.getTime()));
    });

    it('rejects a body that has been through JSON.parse and back', async () => {
      // The integration bug this library is shaped to prevent. The signature is
      // over bytes; express.json() or `await req.json()` discards them, and the
      // re-serialised form differs in whitespace and key order. Every webhook
      // then fails verification with no useful error, so it must fail here,
      // loudly, in CI.
      const request = signed(harness.modelled.body);
      const roundTripped = JSON.stringify(JSON.parse(request.text));
      assert.notEqual(roundTripped, request.text, 'fixture must actually differ after a round trip');

      const error = await expectProviderError(
        () =>
          provider.verifyWebhook({
            body: new TextEncoder().encode(roundTripped),
            headers: request.headers,
          }),
        'signature_invalid',
      );
      assert.match(error.message, /signature/);
    });

    it('rejects a tampered amount', async () => {
      const request = signed(harness.modelled.body);
      const tampered = request.text.replace('4599', '9999');
      assert.notEqual(tampered, request.text);
      await expectProviderError(
        () =>
          provider.verifyWebhook({
            body: new TextEncoder().encode(tampered),
            headers: request.headers,
          }),
        'signature_invalid',
      );
    });

    it('separates a stale signature from an invalid one', async () => {
      // Different operational responses: stale in bulk means clock skew, and
      // invalid in bulk means the wrong secret or someone probing. Collapsing
      // them into one error loses that.
      const request = signed(harness.modelled.body, NOW_SECONDS - 4000);
      await expectProviderError(() => provider.verifyWebhook(request), 'signature_stale');
    });

    it('rejects a missing signature header', async () => {
      const request = signed(harness.modelled.body);
      await expectProviderError(
        () => provider.verifyWebhook({ body: request.body, headers: {} }),
        'signature_invalid',
      );
    });

    it('rejects a repeated signature header rather than picking one', async () => {
      const request = signed(harness.modelled.body);
      const header = request.headers[harness.signatureHeader];
      assert.ok(header);
      await expectProviderError(
        () =>
          provider.verifyWebhook({
            body: request.body,
            headers: { [harness.signatureHeader]: [header, 'ts=1;h1=deadbeef'] },
          }),
        'signature_invalid',
      );
    });

    it('normalises an unmodelled event to `unknown` instead of throwing', async () => {
      // 500-ing on an unmodelled event gets the endpoint disabled, and a
      // disabled endpoint loses the payment events too.
      const request = signed(harness.unmodelled);
      const event = await provider.verifyWebhook(request);
      assert.equal(event.kind, 'unknown');
    });

    it('refuses a settlement mode it did not declare', () => {
      const mode = harness.unsupportedMode;
      if (mode === null) return;
      // The static call site cannot reach this: `settle` narrows its parameter
      // to the declared modes, so `paddle.settle({ mode: 'lines', ... })` does
      // not compile. See tests/compile-time.ts. This covers the dynamic path,
      // where the mode came out of a configuration row.
      const error = expectProviderErrorSync(() => assertSettlementMode(provider, mode), 'unsupported');
      assert.match(error.message, /cannot settle/);
    });

    it('exposes ensureSubscription exactly when it declares it can create one', () => {
      assert.equal(
        typeof provider.ensureSubscription === 'function',
        provider.capabilities.createsSubscriptions,
      );
      assert.equal(canCreateSubscriptions(provider), provider.capabilities.createsSubscriptions);
    });

    it('sends an idempotency header if and only if it declares one', async () => {
      const call = await harness.ensureCustomerCall({ key: 'subject-1', email: 'ada@example.com' });
      const declared = provider.capabilities.idempotency;
      const headers = Object.fromEntries(
        Object.entries(call.headers).map(([key, value]) => [key.toLowerCase(), value]),
      );
      if (declared === null) {
        // A key the provider does not honour is worse than none: http.ts reads
        // its presence as permission to retry a POST.
        assert.ok(!('idempotency-key' in headers));
      } else {
        assert.equal(headers[declared.header.toLowerCase()], 'customer:subject-1');
      }
    });
  });
}

describe('provider contract: the library-wide rules', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));

  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return entry === 'tests' ? [] : sources(path);
      return path.endsWith('.ts') ? [path] : [];
    });

  it('never branches on a provider name', () => {
    // The rule that keeps a fourth provider a file rather than a rewrite, and
    // it is only a rule if something checks it. Every decision must come from
    // the capability descriptor.
    const offenders: string[] = [];
    for (const file of sources(root)) {
      const text = readFileSync(file, 'utf8');
      text.split('\n').forEach((line, index) => {
        // Comments are exempt, and one of them is the rule itself written out
        // in capabilities.ts. Cutting at `//` is crude — it would also cut a
        // string containing it — but a false exemption here is a missed
        // offender, not a wrong pass, and there are no such strings.
        const code = line.split('//')[0] ?? '';
        if (/\bname\s*===|===\s*['"](stripe|paddle|lago)['"]/.test(code)) {
          offenders.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    assert.deepEqual(offenders, []);
  });

  it('keeps adapters from importing each other', () => {
    // A shared helper between two adapters belongs in the shared layer. An
    // import across them means one provider's shape has started to define
    // another's, which is how the abstraction quietly becomes a costume.
    const offenders: string[] = [];
    for (const file of sources(root)) {
      const text = readFileSync(file, 'utf8');
      const foreign = file.includes('/stripe/') ? 'paddle' : file.includes('/paddle/') ? 'stripe' : null;
      if (foreign && new RegExp(`from '\\.\\./${foreign}`).test(text)) offenders.push(file);
    }
    assert.deepEqual(offenders, []);
  });
});
