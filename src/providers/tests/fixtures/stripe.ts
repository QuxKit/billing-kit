// providers/tests/fixtures/stripe.ts
//
// Canned Stripe objects and a webhook signer.
//
// The signer is real HMAC over real bytes with a test secret. Nothing here
// stubs out verification — a suite that mocks the signature check proves the
// mapping works and says nothing about the one thing that fails in production.

import { createHmac } from 'node:crypto';

export const STRIPE_SECRET = 'whsec_test_0123456789abcdef';

export const signStripe = (body: string, timestampSeconds: number, secret = STRIPE_SECRET): string => {
  const digest = createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex');
  return `t=${timestampSeconds},v1=${digest}`;
};

export const customer = (overrides: Record<string, unknown> = {}) => ({
  id: 'cus_TEST1',
  object: 'customer',
  email: 'ada@example.com',
  metadata: { billing_kit_subject: 'subject-1' },
  ...overrides,
});

export const invoice = (overrides: Record<string, unknown> = {}) => ({
  id: 'in_TEST1',
  object: 'invoice',
  currency: 'usd',
  status: 'open',
  total: 4599,
  tax: 400,
  payment_intent: 'pi_TEST1',
  metadata: { billing_kit_settlement: 'settle:subject-1:2026-07' },
  ...overrides,
});

export const subscription = (overrides: Record<string, unknown> = {}) => ({
  id: 'sub_TEST1',
  object: 'subscription',
  status: 'active',
  current_period_start: 1_767_225_600,
  current_period_end: 1_769_904_000,
  items: {
    object: 'list',
    data: [
      {
        id: 'si_TEST1',
        price: {
          id: 'price_TEST_TOKENS',
          object: 'price',
          metadata: { billing_kit_metric: 'tokens' },
        },
      },
    ],
  },
  ...overrides,
});

export const event = (type: string, object_: unknown, overrides: Record<string, unknown> = {}) => ({
  id: 'evt_TEST1',
  object: 'event',
  type,
  created: 1_767_225_600,
  data: { object: object_ },
  ...overrides,
});

export const list = (data: unknown[]) => ({ object: 'list', data, has_more: false });
