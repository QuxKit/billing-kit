// providers/tests/apply.test.ts
//
// applyVerifiedEvent, end to end: real bytes signed with the test secret go
// through the real adapter's verifyWebhook, and the VerifiedEvent that comes
// out goes through the real replay guard into the real ledger. Nothing in the
// path is stubbed, because the properties under test — one posting per payment,
// nothing posted for a failure, a redelivery that writes nothing — live in a
// unique constraint and a transaction, not in TypeScript.
//
// Run against Postgres (BILLING_KIT_TEST_DATABASE_URL); skips without one
// unless REQUIRE_DB is set.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { balance, entries } from '../../ledger';
import { pgExecutor } from '../../pg';
import type { SqlExecutor } from '../../types';
import { applyVerifiedEvent, type ResolvedSubject } from '../apply';
import { createPaddleProvider } from '../paddle';
import { createStripeProvider } from '../stripe';
import type { VerifiedEvent } from '../types';
import * as paddleFx from './fixtures/paddle';
import * as stripeFx from './fixtures/stripe';

const TEST_DATABASE_URL = process.env.BILLING_KIT_TEST_DATABASE_URL ?? 'postgres://localhost:5432/billing_kit_test';
const REQUIRE_DB = process.env.REQUIRE_DB !== undefined && process.env.REQUIRE_DB !== '';
const SKIP_REASON = `no database at ${TEST_DATABASE_URL}`;

async function setup(): Promise<{ db: SqlExecutor; close(): Promise<void> } | null> {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    await pool.end().catch(() => {});
    if (REQUIRE_DB)
      throw new Error(`REQUIRE_DB is set and the test database is unreachable: ${SKIP_REASON}`, { cause: error });
    return null;
  }
  const ddl = (f: string) => readFile(fileURLToPath(new URL(`../../../sql/${f}`, import.meta.url)), 'utf8');
  await pool.query('DROP SCHEMA IF EXISTS billing CASCADE');
  await pool.query(await ddl('001_core.sql'));
  await pool.query('SELECT billing.ensure_core_partitions(2, $1)', [new Date()]);
  await pool.query(await ddl('030_provider_events.sql'));
  // Idempotent: applying the file twice must be a no-op.
  await pool.query(await ddl('030_provider_events.sql'));
  return { db: pgExecutor(pool), close: () => pool.end() };
}

const NOW_SECONDS = 1_767_225_600;
const now = () => NOW_SECONDS * 1000;

const stripe = createStripeProvider({
  apiKey: 'sk_test_x',
  webhookSecret: stripeFx.STRIPE_SECRET,
  baseUrl: 'https://stripe.test',
  now,
});
const paddle = createPaddleProvider({
  apiKey: 'pdl_test_x',
  webhookSecret: paddleFx.PADDLE_SECRET,
  baseUrl: 'https://paddle.test',
  now,
});

/** Sign a Stripe payload the way Stripe does and run it through verifyWebhook. */
async function stripeEvent(payload: unknown): Promise<VerifiedEvent> {
  const text = JSON.stringify(payload, null, 2);
  return stripe.verifyWebhook({
    body: new TextEncoder().encode(text),
    headers: { 'stripe-signature': stripeFx.signStripe(text, NOW_SECONDS) },
  });
}

async function paddleEvent(payload: unknown): Promise<VerifiedEvent> {
  const text = JSON.stringify(payload, null, 2);
  return paddle.verifyWebhook({
    body: new TextEncoder().encode(text),
    headers: { 'paddle-signature': paddleFx.signPaddle(text, NOW_SECONDS) },
  });
}

/** The host's mapping from settlement ref to subject. Fixed here. */
const known: Record<string, ResolvedSubject> = {
  in_TEST1: { tenantId: 'acme', subjectId: 'ada' },
  in_TEST2: { tenantId: 'acme', subjectId: 'ada' },
  re_TEST1: { tenantId: 'acme', subjectId: 'ada' },
  txn_TEST1: { tenantId: 'globex', subjectId: 'bob' },
  adj_TEST1: { tenantId: 'globex', subjectId: 'bob' },
};
const resolve = (event: VerifiedEvent): ResolvedSubject | null => {
  const ref =
    'settlementRef' in event && typeof event.settlementRef === 'string'
      ? event.settlementRef
      : 'refundRef' in event
        ? event.refundRef
        : null;
  return ref === null ? null : (known[ref] ?? null);
};

const harness = await setup();
after(async () => {
  await harness?.close();
});

describe('applyVerifiedEvent', { skip: harness === null ? SKIP_REASON : false }, () => {
  const db = (harness as { db: SqlExecutor }).db;
  const cash = (subjectId: string, tenantId = 'acme') =>
    balance(db, { tenantId, subjectId, account: 'cash', currency: 'USD' });
  const owed = (subjectId: string, tenantId = 'acme') =>
    balance(db, { tenantId, subjectId, account: 'customer_balance', currency: 'USD' });

  it('posts a payment for a Stripe invoice.payment_succeeded, and a replay is a no-op', async () => {
    const event = await stripeEvent(
      stripeFx.event('invoice.payment_succeeded', stripeFx.invoice({ id: 'in_TEST1', amount_paid: 4599 })),
    );
    assert.equal(event.kind, 'payment.succeeded');

    const first = await applyVerifiedEvent(db, { provider: stripe.name, event, resolve });
    assert.equal(first.applied, true);
    assert.equal(first.deduplicated, false);
    if (!first.applied) throw new Error('unreachable');
    assert.equal(first.sourceKind, 'payment');
    assert.equal(first.tenantId, 'acme');
    assert.equal(first.subjectId, 'ada');

    assert.equal((await cash('ada')).toDecimalString(), '45.99');
    assert.equal((await owed('ada')).toDecimalString(), '-45.99');

    // The redelivery: same bytes, same event id.
    const again = await applyVerifiedEvent(db, { provider: stripe.name, event, resolve });
    assert.equal(again.applied, true);
    assert.equal(again.deduplicated, true);
    if (!again.applied) throw new Error('unreachable');
    assert.equal(again.transactionId, first.transactionId);
    assert.equal(again.sourceId, first.sourceId);
    assert.equal((await cash('ada')).toDecimalString(), '45.99', 'a replay must not post again');

    const rows = await entries(db, { tenantId: 'acme', subjectId: 'ada', account: 'cash' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sourceKind, 'payment');
    assert.equal(rows[0].postedAt.getTime(), event.occurredAt.getTime(), 'posted at the provider time');
  });

  it("dedupes Stripe's invoice.paid against the invoice.payment_succeeded it duplicates", async () => {
    // Two event ids, one payment. The posting is keyed by the settlement, so
    // the second event is recorded as new but its posting is the first one.
    const event = await stripeEvent(
      stripeFx.event('invoice.paid', stripeFx.invoice({ id: 'in_TEST1', amount_paid: 4599 }), { id: 'evt_TEST1_dup' }),
    );
    const out = await applyVerifiedEvent(db, { provider: stripe.name, event, resolve });
    assert.equal(out.applied, true);
    assert.equal(out.deduplicated, false, 'a new event id is a new event');
    assert.equal((await cash('ada')).toDecimalString(), '45.99', 'but not a second posting');
  });

  it('records a payment.failed and posts nothing', async () => {
    const event = await stripeEvent(
      stripeFx.event('invoice.payment_failed', stripeFx.invoice({ id: 'in_TEST2' }), { id: 'evt_FAIL1' }),
    );
    assert.equal(event.kind, 'payment.failed');
    const out = await applyVerifiedEvent(db, { provider: stripe.name, event, resolve });
    assert.deepEqual(
      { applied: out.applied, reason: out.applied ? null : out.reason, deduplicated: out.deduplicated },
      { applied: false, reason: 'payment_failed', deduplicated: false },
    );
    assert.equal((await cash('ada')).toDecimalString(), '45.99', 'balance unchanged');

    const replay = await applyVerifiedEvent(db, { provider: stripe.name, event, resolve });
    assert.equal(replay.applied, false);
    assert.equal(replay.deduplicated, true);
    if (replay.applied) throw new Error('unreachable');
    assert.equal(replay.reason, 'payment_failed');
  });

  it('posts a refund for a settled Stripe refund, mirroring the payment', async () => {
    const event = await stripeEvent(
      stripeFx.event(
        'refund.updated',
        { id: 're_TEST1', object: 'refund', currency: 'usd', amount: 599, status: 'succeeded', invoice: 'in_TEST1' },
        { id: 'evt_REF1' },
      ),
    );
    assert.equal(event.kind, 'refund.settled');
    const out = await applyVerifiedEvent(db, { provider: stripe.name, event, resolve });
    assert.equal(out.applied, true);
    if (!out.applied) throw new Error('unreachable');
    assert.equal(out.sourceKind, 'refund');
    assert.equal((await cash('ada')).toDecimalString(), '40.00');
    assert.equal((await owed('ada')).toDecimalString(), '-40.00');
  });

  it('records a declined refund and posts nothing', async () => {
    const event = await stripeEvent(
      stripeFx.event(
        'refund.updated',
        { id: 're_TEST1', object: 'refund', currency: 'usd', amount: 599, status: 'failed', invoice: 'in_TEST1' },
        { id: 'evt_REF2' },
      ),
    );
    assert.equal(event.kind, 'refund.declined');
    const out = await applyVerifiedEvent(db, { provider: stripe.name, event, resolve });
    assert.equal(out.applied, false);
    if (out.applied) throw new Error('unreachable');
    assert.equal(out.reason, 'refund_declined');
    assert.equal((await cash('ada')).toDecimalString(), '40.00');
  });

  it('records an unmodelled event and an informational one without posting', async () => {
    const unknown = await stripeEvent(
      stripeFx.event('radar.early_fraud_warning.created', { id: 'issfr_1' }, { id: 'evt_UNK' }),
    );
    const a = await applyVerifiedEvent(db, { provider: stripe.name, event: unknown, resolve });
    assert.equal(a.applied, false);
    if (a.applied) throw new Error('unreachable');
    assert.equal(a.reason, 'unmodelled');

    const voided = await stripeEvent(
      stripeFx.event('invoice.voided', stripeFx.invoice({ id: 'in_TEST2' }), { id: 'evt_VOID' }),
    );
    const b = await applyVerifiedEvent(db, { provider: stripe.name, event: voided, resolve });
    assert.equal(b.applied, false);
    if (b.applied) throw new Error('unreachable');
    assert.equal(b.reason, 'no_posting');
  });

  it('records a payment for a settlement it cannot resolve, and posts against no one', async () => {
    const event = await stripeEvent(
      stripeFx.event('invoice.payment_succeeded', stripeFx.invoice({ id: 'in_STRANGER', amount_paid: 100 }), {
        id: 'evt_STRANGER',
      }),
    );
    const out = await applyVerifiedEvent(db, { provider: stripe.name, event, resolve });
    assert.equal(out.applied, false);
    if (out.applied) throw new Error('unreachable');
    assert.equal(out.reason, 'unresolved_subject');
    const [row] = await db.query<{ tenant_id: string | null; outcome: string }>(
      `SELECT tenant_id, outcome FROM billing.provider_events WHERE provider = $1 AND provider_event_id = 'evt_STRANGER'`,
      [stripe.name],
    );
    assert.equal(row.outcome, 'skipped');
    assert.equal(row.tenant_id, null);
  });

  it('applies a Paddle transaction.completed and its approved refund adjustment', async () => {
    const paid = await paddleEvent(
      paddleFx.event(
        'transaction.completed',
        paddleFx.withTotals(paddleFx.transaction({ id: 'txn_TEST1', status: 'completed' }), {
          subtotal: '4199',
          tax: '400',
          total: '4599',
          grand_total: '4599',
        }),
        { event_id: 'evt_PDL1' },
      ),
    );
    assert.equal(paid.kind, 'payment.succeeded');
    const a = await applyVerifiedEvent(db, { provider: paddle.name, event: paid, resolve });
    assert.equal(a.applied, true);
    assert.equal((await cash('bob', 'globex')).toDecimalString(), '45.99');

    // Same event id under a different provider namespace must not collide.
    const b = await applyVerifiedEvent(db, {
      provider: paddle.name,
      event: { ...paid, providerEventId: 'evt_TEST1' },
      resolve,
    });
    assert.equal(b.deduplicated, false, 'evt_TEST1 was seen from stripe, not paddle');
    assert.equal((await cash('bob', 'globex')).toDecimalString(), '45.99', 'same settlement, one posting');

    const refunded = await paddleEvent(
      paddleFx.event(
        'adjustment.updated',
        paddleFx.adjustment({ status: 'approved', totals: { total: '599', tax: '0' } }),
        {
          event_id: 'evt_PDL2',
        },
      ),
    );
    assert.equal(refunded.kind, 'refund.settled');
    const c = await applyVerifiedEvent(db, { provider: paddle.name, event: refunded, resolve });
    assert.equal(c.applied, true);
    assert.equal((await cash('bob', 'globex')).toDecimalString(), '40.00');

    const pending = await paddleEvent(
      paddleFx.event('adjustment.created', paddleFx.adjustment({ status: 'pending_approval' }), {
        event_id: 'evt_PDL3',
      }),
    );
    const d = await applyVerifiedEvent(db, { provider: paddle.name, event: pending, resolve });
    assert.equal(d.applied, false);
    if (d.applied) throw new Error('unreachable');
    assert.equal(d.reason, 'unmodelled');
  });

  it('refuses a second, different amount for the same settlement rather than averaging', async () => {
    const event = await stripeEvent(
      stripeFx.event('invoice.payment_succeeded', stripeFx.invoice({ id: 'in_TEST1', amount_paid: 9999 }), {
        id: 'evt_CONFLICT',
      }),
    );
    await assert.rejects(
      applyVerifiedEvent(db, { provider: stripe.name, event, resolve }),
      (e: unknown) => (e as { code?: string }).code === 'idempotency_conflict',
    );
    // The transaction rolled back: nothing recorded, so a corrected redelivery starts clean.
    const rows = await db.query(
      `SELECT 1 FROM billing.provider_events WHERE provider = $1 AND provider_event_id = 'evt_CONFLICT'`,
      [stripe.name],
    );
    assert.equal(rows.length, 0);
  });

  it('survives concurrent delivery of one event: exactly one posting', async () => {
    const event = await stripeEvent(
      stripeFx.event('invoice.payment_succeeded', stripeFx.invoice({ id: 'in_TEST2', amount_paid: 1000 }), {
        id: 'evt_RACE',
      }),
    );
    const results = await Promise.all(
      Array.from({ length: 4 }, () => applyVerifiedEvent(db, { provider: stripe.name, event, resolve })),
    );
    assert.equal(results.filter((r) => !r.deduplicated).length, 1);
    assert.equal(new Set(results.map((r) => (r.applied ? r.transactionId : null))).size, 1);
    const rows = await entries(db, { tenantId: 'acme', subjectId: 'ada', account: 'cash' });
    assert.equal(rows.filter((r) => r.sourceId === `${stripe.name}:in_TEST2`).length, 1);
  });
});
