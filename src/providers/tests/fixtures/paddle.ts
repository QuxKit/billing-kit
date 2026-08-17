// providers/tests/fixtures/paddle.ts
//
// Canned Paddle objects and a webhook signer.
//
// Amounts are strings of minor units throughout, which is how Paddle sends
// them. Keeping the fixtures in the provider's real representation is what
// makes the `moneyFromMinorString` / `moneyFromNumber` split testable at all —
// normalise the fixtures and the difference the code exists to handle
// disappears from the suite.

import { createHmac } from 'node:crypto';

export const PADDLE_SECRET = 'pdl_ntfset_test_0123456789';

export const signPaddle = (body: string, timestampSeconds: number, secret = PADDLE_SECRET): string => {
  const digest = createHmac('sha256', secret).update(`${timestampSeconds}:${body}`).digest('hex');
  return `ts=${timestampSeconds};h1=${digest}`;
};

export const wrap = (data: unknown) => ({ data, meta: { request_id: 'req_TEST' } });

export const wrapList = (data: unknown[]) => ({
  data,
  meta: { request_id: 'req_TEST', pagination: { per_page: 50, has_more: false } },
});

export const customer = (overrides: Record<string, unknown> = {}) => ({
  id: 'ctm_TEST1',
  email: 'ada@example.com',
  status: 'active',
  custom_data: { billing_kit_subject: 'subject-1' },
  ...overrides,
});

/** A transaction as it comes back from a create: priced by Paddle, or not
 *  priced yet. `details` absent is the normal early state and is what makes
 *  `providerTotal: null` a real case rather than a defensive branch. */
export const transaction = (overrides: Record<string, unknown> = {}) => ({
  id: 'txn_TEST1',
  status: 'billed',
  customer_id: 'ctm_TEST1',
  currency_code: 'USD',
  custom_data: { billing_kit_settlement: 'settle:subject-1:2026-07' },
  items: [{ id: 'txnitm_TEST1', price: { id: 'pri_TEST_TOKENS' }, quantity: 1000 }],
  ...overrides,
});

export const withTotals = (base: Record<string, unknown>, totals: Record<string, string>): Record<string, unknown> => ({
  ...base,
  details: { totals },
});

export const subscription = (overrides: Record<string, unknown> = {}) => ({
  id: 'sub_TEST1',
  status: 'active',
  customer_id: 'ctm_TEST1',
  current_billing_period: { starts_at: '2026-07-01T00:00:00.000000Z', ends_at: '2026-08-01T00:00:00.000000Z' },
  items: [
    {
      price: {
        id: 'pri_TEST_TOKENS',
        custom_data: { billing_kit_metric: 'tokens' },
      },
    },
  ],
  ...overrides,
});

export const adjustment = (overrides: Record<string, unknown> = {}) => ({
  id: 'adj_TEST1',
  action: 'refund',
  status: 'pending_approval',
  transaction_id: 'txn_TEST1',
  currency_code: 'USD',
  totals: { total: '4599', tax: '400' },
  ...overrides,
});

export const event = (type: string, data: unknown, overrides: Record<string, unknown> = {}) => ({
  event_id: 'evt_TEST1',
  event_type: type,
  // Microsecond precision, as Paddle actually sends it.
  occurred_at: '2026-07-01T12:00:00.123456Z',
  notification_id: 'ntf_TEST1',
  data,
  ...overrides,
});
