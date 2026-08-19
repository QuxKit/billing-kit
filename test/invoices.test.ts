// Invoices against Postgres: the draft → open → paid | void machine and its
// one refusal, gap-free numbering under concurrent finalizes, building an
// invoice from a charged period's persisted breakdown, rendering, and the
// webhook path that marks an attached invoice paid. The properties that matter
// — one number per finalize with no holes, one invoice per period, a guarded
// transition — live in a row lock, a unique constraint and a guarded UPDATE,
// so they are tested here and not in a unit test.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { BillingError } from '../src/errors';
import {
  addLine,
  attachSettlement,
  createInvoice,
  finalize,
  getInvoice,
  invoiceForPeriod,
  listInvoices,
  markPaid,
  markUncollectible,
  renderInvoice,
  voidInvoice,
} from '../src/invoices/index.ts';
import { balance } from '../src/ledger';
import { Money, Quantity, Rate } from '../src/money';
import { applyVerifiedEvent } from '../src/providers/apply';
import { createStripeProvider } from '../src/providers/stripe';
import * as stripeFx from '../src/providers/tests/fixtures/stripe';
import { definePlan } from '../src/subscriptions/plan.ts';
import { chargeSubscriptionPeriod } from '../src/subscriptions/settle.ts';
import { createSubscription } from '../src/subscriptions/store.ts';
import type { SqlExecutor } from '../src/types';
import { fromPool, SKIP_REASON, TEST_DATABASE_URL, unreachable } from './pg-executor';

const usd = (v: string) => Money.fromDecimalString(v, 'USD');
const q = (n: bigint) => Quantity.fromBigInt(n);
const NOW = new Date('2026-08-17T12:00:00Z');

async function setup(): Promise<{ db: SqlExecutor; close(): Promise<void> } | null> {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 12 });
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    await pool.end().catch(() => {});
    unreachable(SKIP_REASON, error);
    return null;
  }
  const ddl = (f: string) => readFile(fileURLToPath(new URL(`../sql/${f}`, import.meta.url)), 'utf8');
  await pool.query('DROP SCHEMA IF EXISTS billing CASCADE');
  await pool.query(await ddl('001_core.sql'));
  await pool.query('SELECT billing.ensure_core_partitions(2, $1)', [NOW]);
  await pool.query(await ddl('020_subscriptions.sql'));
  await pool.query(await ddl('030_provider_events.sql'));
  await pool.query(await ddl('031_invoices.sql'));
  await pool.query(await ddl('032_plan_changes.sql'));
  await pool.query(await ddl('033_tax_lines.sql'));
  await pool.query(await ddl('031_invoices.sql')); // idempotent
  return { db: fromPool(pool), close: () => pool.end() };
}

const harness = await setup();
after(async () => {
  await harness?.close();
});

const codeOf = (e: unknown) => (BillingError.is(e) ? e.code : String(e));

describe('invoices', { skip: harness === null ? SKIP_REASON : false }, () => {
  const db = (harness as { db: SqlExecutor }).db;

  it('creates a draft, adds lines, and keeps subtotal and total honest', async () => {
    const inv = await createInvoice(
      db,
      {
        tenantId: 'acme',
        subjectId: 'ada',
        currency: 'USD',
        lines: [{ kind: 'base', description: 'team base', amount: usd('49.00') }],
      },
      NOW,
    );
    assert.equal(inv.state, 'draft');
    assert.equal(inv.number, null);
    assert.equal(inv.total.toDecimalString(), '49.00');

    const more = await addLine(
      db,
      { tenantId: 'acme', invoiceId: inv.id },
      [
        { kind: 'seats', description: '3 seats', amount: usd('30.00'), quantity: q(3n) },
        { kind: 'discount', description: 'launch coupon', amount: usd('-7.90') },
      ],
      NOW,
    );
    assert.deepEqual(
      more.lines.map((l) => [l.lineNo, l.kind, l.amount.toDecimalString()]),
      [
        [1, 'base', '49.00'],
        [2, 'seats', '30.00'],
        [3, 'discount', '-7.90'],
      ],
    );
    assert.equal(more.subtotal.toDecimalString(), '79.00', 'subtotal is the positive lines');
    assert.equal(more.total.toDecimalString(), '71.10', 'total is every line');
    assert.equal(more.lines[1].quantity?.toDecimalString(), '3.000000000000');
  });

  it('keeps tax out of the subtotal and in the total', async () => {
    const inv = await createInvoice(
      db,
      {
        tenantId: 'acme',
        subjectId: 'ada',
        currency: 'USD',
        lines: [
          { kind: 'base', description: 'team base', amount: usd('100.00') },
          { kind: 'discount', description: 'launch coupon', amount: usd('-10.00') },
          { kind: 'tax', description: 'NY State Sales Tax 4%', amount: usd('3.60') },
        ],
      },
      NOW,
    );
    // The tax was computed on 100 less the 10 discount. A subtotal carrying the
    // 3.60 would be a figure nothing on the document adds up to, and would read
    // to anyone reconciling as revenue we do not have.
    assert.equal(inv.subtotal.toDecimalString(), '100.00', 'subtotal excludes tax and discounts');
    assert.equal(inv.total.toDecimalString(), '93.60', 'total is every line, tax included');

    const json = renderInvoice(inv, { format: 'json' });
    assert.equal(json.tax, '3.60');

    // Tax renders under the subtotal, not among the things that were sold, and
    // keeps its own description so the jurisdiction survives onto the document.
    const html = renderInvoice(inv, { format: 'html' });
    const foot = html.slice(html.indexOf('<tfoot>'));
    assert.match(foot, /NY State Sales Tax 4%/);
    assert.doesNotMatch(html.slice(0, html.indexOf('<tfoot>')), /NY State Sales Tax/);
  });

  it('refuses a discount that is positive, a base that is negative, and a foreign currency', async () => {
    const ref = { tenantId: 'acme', subjectId: 'ada', currency: 'USD' };
    await assert.rejects(
      createInvoice(db, { ...ref, lines: [{ kind: 'discount', description: 'x', amount: usd('1.00') }] }, NOW),
      (e) => codeOf(e) === 'invalid_invoice',
    );
    await assert.rejects(
      createInvoice(db, { ...ref, lines: [{ kind: 'base', description: 'x', amount: usd('-1.00') }] }, NOW),
      (e) => codeOf(e) === 'invalid_invoice',
    );
    await assert.rejects(
      createInvoice(
        db,
        { ...ref, lines: [{ kind: 'base', description: 'x', amount: Money.fromDecimalString('1.00', 'EUR') }] },
        NOW,
      ),
      (e) => codeOf(e) === 'currency_mismatch',
    );
  });

  it('finalize assigns {prefix}-{YYYY}-{seq:06} and freezes the lines', async () => {
    const draft = await createInvoice(
      db,
      {
        tenantId: 'globex',
        subjectId: 'bob',
        currency: 'USD',
        lines: [{ kind: 'base', description: 'b', amount: usd('10.00') }],
      },
      NOW,
    );
    const open = await finalize(db, { tenantId: 'globex', invoiceId: draft.id }, NOW);
    assert.equal(open.state, 'open');
    assert.equal(open.number, 'INV-2026-000001');
    assert.equal(open.issuedAt?.toISOString(), NOW.toISOString());

    await assert.rejects(finalize(db, { tenantId: 'globex', invoiceId: draft.id }, NOW), (e) => {
      assert.ok(BillingError.hasCode(e, 'invoice_state'));
      assert.equal(e.failure.state, 'open');
      assert.deepEqual(e.failure.wanted, ['draft']);
      return true;
    });
    await assert.rejects(
      addLine(
        db,
        { tenantId: 'globex', invoiceId: draft.id },
        { kind: 'custom', description: 'late', amount: usd('1.00') },
        NOW,
      ),
      (e) => codeOf(e) === 'invoice_state',
    );

    // A second prefix and another year each start their own sequence.
    const d2 = await createInvoice(db, { tenantId: 'globex', subjectId: 'bob', currency: 'USD' }, NOW);
    const cn = await finalize(db, { tenantId: 'globex', invoiceId: d2.id, prefix: 'CN' }, NOW);
    assert.equal(cn.number, 'CN-2026-000001');
    const d3 = await createInvoice(db, { tenantId: 'globex', subjectId: 'bob', currency: 'USD' }, NOW);
    const ny = await finalize(
      db,
      { tenantId: 'globex', invoiceId: d3.id, issuedAt: new Date('2027-01-01T00:00:00Z') },
      NOW,
    );
    assert.equal(ny.number, 'INV-2027-000001');
    await assert.rejects(
      finalize(db, { tenantId: 'globex', invoiceId: d3.id, prefix: 'bad prefix!' }, NOW),
      (e) => codeOf(e) === 'invalid_invoice',
    );
  });

  it('numbers eight concurrent finalizes 000001..000008 with no gap and no duplicate', async () => {
    const drafts = await Promise.all(
      Array.from({ length: 8 }, (_v, i) =>
        createInvoice(
          db,
          {
            tenantId: 'initech',
            subjectId: `s${i}`,
            currency: 'USD',
            lines: [{ kind: 'base', description: 'b', amount: usd('1.00') }],
          },
          NOW,
        ),
      ),
    );
    const finals = await Promise.all(drafts.map((d) => finalize(db, { tenantId: 'initech', invoiceId: d.id }, NOW)));
    const numbers = finals.map((f) => f.number).sort();
    assert.deepEqual(
      numbers,
      Array.from({ length: 8 }, (_v, i) => `INV-2026-${String(i + 1).padStart(6, '0')}`),
    );
  });

  it('a finalize that rolls back leaves no hole in the sequence', async () => {
    const d = await createInvoice(db, { tenantId: 'initech', subjectId: 'x', currency: 'USD' }, NOW);
    await assert.rejects(
      db.transaction(async (tx) => {
        const f = await finalize(tx, { tenantId: 'initech', invoiceId: d.id }, NOW);
        assert.equal(f.number, 'INV-2026-000009');
        throw new Error('boom');
      }),
      /boom/,
    );
    const again = await finalize(db, { tenantId: 'initech', invoiceId: d.id }, NOW);
    assert.equal(again.number, 'INV-2026-000009', 'the rolled-back number is reissued');
  });

  it('walks the state machine and refuses everything else with invoice_state', async () => {
    const t = 'states';
    const mk = () => createInvoice(db, { tenantId: t, subjectId: 's', currency: 'USD' }, NOW);

    // draft → void: no number was ever taken.
    const d1 = await mk();
    const v1 = await voidInvoice(db, { tenantId: t, invoiceId: d1.id }, NOW);
    assert.equal(v1.state, 'void');
    assert.equal(v1.number, null);
    await assert.rejects(finalize(db, { tenantId: t, invoiceId: d1.id }, NOW), (e) => codeOf(e) === 'invoice_state');

    // draft → paid is not a transition.
    const d2 = await mk();
    await assert.rejects(markPaid(db, { tenantId: t, invoiceId: d2.id }, NOW), (e) => {
      assert.ok(BillingError.hasCode(e, 'invoice_state'));
      assert.deepEqual(e.failure.wanted, ['open']);
      return true;
    });

    // open → paid, then nothing else.
    const o2 = await finalize(db, { tenantId: t, invoiceId: d2.id }, NOW);
    const paidAt = new Date('2026-08-18T00:00:00Z');
    const p2 = await markPaid(db, { tenantId: t, invoiceId: d2.id, paidAt }, NOW);
    assert.equal(p2.state, 'paid');
    assert.equal(p2.paidAt?.toISOString(), paidAt.toISOString());
    assert.equal(p2.number, o2.number);
    await assert.rejects(voidInvoice(db, { tenantId: t, invoiceId: d2.id }, NOW), (e) => codeOf(e) === 'invoice_state');
    await assert.rejects(
      markUncollectible(db, { tenantId: t, invoiceId: d2.id }, NOW),
      (e) => codeOf(e) === 'invoice_state',
    );

    // open → void keeps the number, so the sequence stays gap-free and visible.
    const d3 = await mk();
    const o3 = await finalize(db, { tenantId: t, invoiceId: d3.id }, NOW);
    const v3 = await voidInvoice(db, { tenantId: t, invoiceId: d3.id }, NOW);
    assert.equal(v3.number, o3.number);
    assert.ok(v3.voidedAt);

    // open → uncollectible.
    const d4 = await mk();
    await finalize(db, { tenantId: t, invoiceId: d4.id }, NOW);
    const u4 = await markUncollectible(db, { tenantId: t, invoiceId: d4.id }, NOW);
    assert.equal(u4.state, 'uncollectible');

    // Unknown ids are not_found, not a state error.
    await assert.rejects(
      markPaid(db, { tenantId: t, invoiceId: '00000000-0000-0000-0000-000000000000' }, NOW),
      (e) => codeOf(e) === 'not_found',
    );
    assert.equal(await getInvoice(db, { tenantId: t, invoiceId: '00000000-0000-0000-0000-000000000000' }), null);

    const all = await listInvoices(db, { tenantId: t });
    assert.equal(all.length, 4);
    assert.equal((await listInvoices(db, { tenantId: t, state: 'void' })).length, 2);
  });

  describe('invoiceForPeriod', () => {
    const plan = definePlan({
      id: 'team',
      currency: 'USD',
      interval: 'month',
      flat: usd('49.00'),
      seats: { unit: usd('10.00'), min: 1 },
      usage: [
        {
          metric: 'tokens.input',
          included: q(1_000_000n),
          price: { kind: 'flat', rate: Rate.fromDecimalString('0.00012') },
        },
        { metric: 'gb_hours', price: { kind: 'flat', rate: Rate.fromDecimalString('5') } },
      ],
    });

    it('builds base, seats, per-meter overage and discount lines from the persisted charge', async () => {
      const sub = await createSubscription(
        db,
        { tenantId: 'acme', subjectId: 'ada', key: 'inv-1', plan, seats: 3, startAt: new Date('2026-07-01T00:00:00Z') },
        NOW,
      );
      const charged = await chargeSubscriptionPeriod(db, {
        plan,
        subscription: sub,
        usage: { 'tokens.input': q(1_500_000n), gb_hours: Quantity.fromDecimalString('10') },
        discount: { kind: 'percent', bps: 1000 },
        now: NOW,
      });
      const [{ id: periodId }] = await db.query<{ id: string }>(
        `SELECT id FROM billing.subscription_periods WHERE subscription_id = $1`,
        [sub.id],
      );

      const inv = await invoiceForPeriod(db, { tenantId: 'acme', subscriptionPeriodId: periodId }, NOW);
      assert.equal(inv.state, 'draft');
      assert.equal(inv.subscriptionPeriodId, periodId);
      assert.equal(inv.period?.start.toISOString(), '2026-07-01T00:00:00.000Z');
      assert.deepEqual(
        inv.lines.map((l) => [l.kind, l.metric, l.amount.toDecimalString()]),
        [
          ['base', null, '49.00'],
          ['seats', null, '30.00'],
          // Rates are minor units per unit: 500,000 tokens at 0.00012 cents.
          ['overage', 'tokens.input', '0.60'],
          ['overage', 'gb_hours', '0.50'],
          ['discount', null, '-8.01'],
        ],
      );
      assert.equal(
        inv.total.toDecimalString(),
        charged.charge.total.toDecimalString(),
        'the invoice says what was billed',
      );
      assert.equal(inv.lines[2].quantity?.toDecimalString(), '500000.000000000000', 'billable overage, not raw usage');
      assert.equal(inv.metadata?.chargeId, charged.chargeId);

      // Idempotent on the period, including under a race.
      const again = await Promise.all(
        Array.from({ length: 4 }, () =>
          invoiceForPeriod(db, { tenantId: 'acme', subscriptionPeriodId: periodId }, NOW),
        ),
      );
      assert.ok(again.every((a) => a.id === inv.id));
      assert.equal(
        (await db.query(`SELECT 1 FROM billing.invoices WHERE subscription_period_id = $1`, [periodId])).length,
        1,
      );
    });

    it('adds a credit line for prepaid credit the caller applied', async () => {
      const sub = await createSubscription(
        db,
        { tenantId: 'acme', subjectId: 'ada', key: 'inv-2', plan, seats: 1, startAt: new Date('2026-06-01T00:00:00Z') },
        NOW,
      );
      await chargeSubscriptionPeriod(db, { plan, subscription: sub, now: NOW });
      const [{ id: periodId }] = await db.query<{ id: string }>(
        `SELECT id FROM billing.subscription_periods WHERE subscription_id = $1`,
        [sub.id],
      );
      const inv = await invoiceForPeriod(
        db,
        { tenantId: 'acme', subscriptionPeriodId: periodId, credit: usd('20.00') },
        NOW,
      );
      assert.deepEqual(
        inv.lines.map((l) => [l.kind, l.amount.toDecimalString()]),
        [
          ['base', '49.00'],
          ['seats', '10.00'],
          ['credit', '-20.00'],
        ],
      );
      assert.equal(inv.subtotal.toDecimalString(), '59.00');
      assert.equal(inv.total.toDecimalString(), '39.00');
    });

    it('refuses a period charged before the breakdown was persisted, and an unknown period', async () => {
      const sub = await createSubscription(
        db,
        { tenantId: 'acme', subjectId: 'ada', key: 'inv-3', plan, startAt: new Date('2026-05-01T00:00:00Z') },
        NOW,
      );
      await chargeSubscriptionPeriod(db, { plan, subscription: sub, now: NOW });
      const [{ id: periodId }] = await db.query<{ id: string }>(
        `SELECT id FROM billing.subscription_periods WHERE subscription_id = $1`,
        [sub.id],
      );
      await db.query(`UPDATE billing.subscription_periods SET charge_lines = NULL WHERE id = $1`, [periodId]);
      await assert.rejects(
        invoiceForPeriod(db, { tenantId: 'acme', subscriptionPeriodId: periodId }, NOW),
        (e) => codeOf(e) === 'invalid_invoice',
      );
      await assert.rejects(
        invoiceForPeriod(db, { tenantId: 'acme', subscriptionPeriodId: '00000000-0000-0000-0000-000000000000' }, NOW),
        (e) => codeOf(e) === 'not_found',
      );
    });
  });

  it('renders JSON and print-styled HTML, escaping what the lines say', async () => {
    const draft = await createInvoice(
      db,
      {
        tenantId: 'render',
        subjectId: 'ada',
        currency: 'USD',
        lines: [
          { kind: 'base', description: '<script>alert(1)</script> & co', amount: usd('49.00') },
          {
            kind: 'overage',
            description: 'tokens',
            metric: 'tokens.input',
            quantity: q(500_000n),
            amount: usd('60.00'),
          },
          { kind: 'discount', description: '10% off', amount: usd('-10.90') },
        ],
        period: { start: new Date('2026-07-01T00:00:00Z'), end: new Date('2026-08-01T00:00:00Z') },
      },
      NOW,
    );
    const inv = await finalize(
      db,
      { tenantId: 'render', invoiceId: draft.id, dueAt: new Date('2026-09-01T00:00:00Z') },
      NOW,
    );

    const json = renderInvoice(inv, { format: 'json' });
    assert.equal(json.number, 'INV-2026-000001');
    assert.equal(json.total, '98.10');
    assert.equal(json.lines[1].quantity, '500000.000000000000');
    assert.equal(json.period?.start, '2026-07-01T00:00:00.000Z');
    assert.equal(json.dueAt, '2026-09-01T00:00:00.000Z');
    // Round-trips through JSON.stringify: nothing in it is a bigint or a class.
    assert.equal(JSON.parse(JSON.stringify(json)).total, '98.10');

    const html = renderInvoice(inv, {
      format: 'html',
      issuer: { name: 'QuxKit <Ltd>' },
      billTo: { name: 'Ada', email: 'ada@example.com' },
    });
    assert.match(html, /<!doctype html>/);
    assert.match(html, /Invoice INV-2026-000001/);
    assert.ok(!html.includes('<script>'), 'line text is escaped');
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; co/);
    assert.match(html, /QuxKit &lt;Ltd&gt;/);
    assert.match(html, /\$98\.10/);
    assert.match(html, /-\$10\.90/);
    assert.match(html, /500000/);
    assert.match(html, /Period 2026-07-01 to 2026-08-01/);
    assert.match(html, /Due 2026-09-01/);

    const draftHtml = renderInvoice(draft, { format: 'html', locale: 'xx-INVALID-LOCALE-@@' });
    assert.match(draftHtml, /Invoice Draft/);
  });

  describe('applyVerifiedEvent marks the attached invoice paid', () => {
    const NOW_SECONDS = 1_767_225_600;
    const stripe = createStripeProvider({
      apiKey: 'sk_test_x',
      webhookSecret: stripeFx.STRIPE_SECRET,
      baseUrl: 'https://stripe.test',
      now: () => NOW_SECONDS * 1000,
    });
    const paidEvent = async (invoiceRef: string, amountPaid: number, eventId: string) => {
      const text = JSON.stringify(
        stripeFx.event('invoice.payment_succeeded', stripeFx.invoice({ id: invoiceRef, amount_paid: amountPaid }), {
          id: eventId,
        }),
        null,
        2,
      );
      return stripe.verifyWebhook({
        body: new TextEncoder().encode(text),
        headers: { 'stripe-signature': stripeFx.signStripe(text, NOW_SECONDS) },
      });
    };

    it('resolves the subject from the invoice and moves it open → paid in the same transaction', async () => {
      const draft = await createInvoice(
        db,
        {
          tenantId: 'hook',
          subjectId: 'ada',
          currency: 'USD',
          lines: [{ kind: 'base', description: 'b', amount: usd('45.99') }],
        },
        NOW,
      );
      const open = await finalize(db, { tenantId: 'hook', invoiceId: draft.id }, NOW);
      await assert.rejects(
        attachSettlement(db, { tenantId: 'hook', invoiceId: draft.id, provider: 'stripe', providerRef: '' }, NOW).then(
          () =>
            attachSettlement(
              db,
              { tenantId: 'hook', invoiceId: draft.id, provider: 'stripe', providerRef: 'other' },
              NOW,
            ),
        ),
        (e) => codeOf(e) === 'invalid_invoice',
        'an invoice attaches to one settlement',
      );
      // Re-attaching the same ref is a no-op, not a refusal.
      await attachSettlement(db, { tenantId: 'hook', invoiceId: draft.id, provider: 'stripe', providerRef: '' }, NOW);
      const attached = await attachSettlement(
        db,
        { tenantId: 'hook', invoiceId: draft.id, provider: 'stripe', providerRef: '' },
        NOW,
      );
      assert.equal(attached.providerRef, '');
      // Use a real-looking ref for the rest.
      await db.query(`UPDATE billing.invoices SET provider_ref = 'in_HOOK1' WHERE id = $1`, [draft.id]);

      const event = await paidEvent('in_HOOK1', 4599, 'evt_HOOK1');
      const out = await applyVerifiedEvent(db, { provider: stripe.name, event }); // no resolver
      assert.equal(out.applied, true);
      if (!out.applied) throw new Error('unreachable');
      assert.equal(out.tenantId, 'hook');
      assert.equal(out.subjectId, 'ada');
      assert.equal(out.invoiceId, open.id);

      const paid = await getInvoice(db, { tenantId: 'hook', invoiceId: open.id });
      assert.equal(paid?.state, 'paid');
      assert.equal(paid?.paidAt?.getTime(), event.occurredAt.getTime());
      assert.equal(
        (await balance(db, { tenantId: 'hook', subjectId: 'ada', account: 'cash', currency: 'USD' })).toDecimalString(),
        '45.99',
      );

      // A replay: nothing changes, invoiceId is not re-reported.
      const again = await applyVerifiedEvent(db, { provider: stripe.name, event });
      assert.equal(again.deduplicated, true);
      if (!again.applied) throw new Error('unreachable');
      assert.equal(again.invoiceId, null);
    });

    it('does not resurrect a voided invoice, and the resolver wins over the invoice', async () => {
      const draft = await createInvoice(db, { tenantId: 'hook', subjectId: 'bob', currency: 'USD' }, NOW);
      await finalize(db, { tenantId: 'hook', invoiceId: draft.id }, NOW);
      await attachSettlement(
        db,
        { tenantId: 'hook', invoiceId: draft.id, provider: 'stripe', providerRef: 'in_HOOK2' },
        NOW,
      );
      await voidInvoice(db, { tenantId: 'hook', invoiceId: draft.id }, NOW);

      const event = await paidEvent('in_HOOK2', 100, 'evt_HOOK2');
      const out = await applyVerifiedEvent(db, {
        provider: stripe.name,
        event,
        resolve: () => ({ tenantId: 'hook', subjectId: 'override' }),
      });
      assert.equal(out.applied, true);
      if (!out.applied) throw new Error('unreachable');
      assert.equal(out.subjectId, 'override', 'the resolver was asked first');
      assert.equal(out.invoiceId, null, 'void stays void');
      assert.equal((await getInvoice(db, { tenantId: 'hook', invoiceId: draft.id }))?.state, 'void');
    });

    it('cannot attach a settlement to a draft or a paid invoice', async () => {
      const draft = await createInvoice(db, { tenantId: 'hook', subjectId: 'c', currency: 'USD' }, NOW);
      await assert.rejects(
        attachSettlement(db, { tenantId: 'hook', invoiceId: draft.id, provider: 'stripe', providerRef: 'in_X' }, NOW),
        (e) => codeOf(e) === 'invoice_state',
      );
    });
  });
});
