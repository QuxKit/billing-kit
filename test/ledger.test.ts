// Ledger tests.
//
// Two halves. The pure half checks that the posting builders compose legs that
// balance, which is cheap and needs no database. The integration half checks
// the properties that only exist in Postgres: the deferred balance trigger, the
// append-only triggers, and idempotency under a real unique constraint.
//
// The second half matters more. "Append-only" enforced by a TypeScript module
// is a convention; enforced by a trigger it is a property, and the difference
// only shows up when someone opens psql.

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { BillingError } from '../src/errors';
import {
  accrualPosting,
  assertBalanced,
  balance,
  entries,
  paymentPosting,
  post,
  refundPosting,
  settlementPosting,
} from '../src/ledger';
import { Money } from '../src/money';
import type { LedgerLeg } from '../src/types';
import { SKIP_REASON, setupDatabase, type Harness } from './pg-executor';

const NOW = new Date('2026-08-13T12:00:00Z');
const usd = (v: string) => Money.fromDecimalString(v, 'USD');

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${(seq += 1)}`;

describe('assertBalanced', () => {
  it('accepts legs that sum to zero', () => {
    assertBalanced([
      { account: 'customer_balance', subjectId: 's', amount: usd('19.99') },
      { account: 'revenue_accrued', subjectId: 's', amount: usd('-19.99') },
    ]);
  });

  it('rejects legs that do not', () => {
    assert.throws(
      () =>
        assertBalanced([
          { account: 'customer_balance', subjectId: 's', amount: usd('19.99') },
          { account: 'revenue_accrued', subjectId: 's', amount: usd('-19.98') },
        ]),
      (e: unknown) => BillingError.hasCode(e, 'unbalanced_transaction') && e.failure.residualMinor === '1',
    );
  });

  it('balances per currency, not overall', () => {
    // +100 USD and -100 EUR sums to zero as a number. It is not a balanced
    // transaction; it is a hole with a cancelling hole next to it.
    const legs: LedgerLeg[] = [
      { account: 'customer_balance', subjectId: 's', amount: Money.fromMinor(100n, 'USD') },
      { account: 'revenue_accrued', subjectId: 's', amount: Money.fromMinor(-100n, 'EUR') },
    ];
    assert.throws(
      () => assertBalanced(legs),
      (e: unknown) => BillingError.hasCode(e, 'unbalanced_transaction'),
    );
  });

  it('rejects a single-legged transaction', () => {
    assert.throws(
      () => assertBalanced([{ account: 'cash', subjectId: 's', amount: usd('0') }]),
      (e: unknown) => BillingError.hasCode(e, 'unbalanced_transaction'),
    );
  });
});

describe('posting builders', () => {
  it('accrues revenue against the customer balance', () => {
    const p = accrualPosting({ tenantId: 't', subjectId: 's', chargeId: 'c1', amount: usd('19.99') });
    assert.equal(p.sourceKind, 'charge');
    assert.equal(p.legs.length, 2);
    assertBalanced(p.legs);
  });

  it('posts the gap between our number and the provider to a named account', () => {
    // Under quantity settlement the provider holds the price and theirs is
    // authoritative. Absorbing the difference into revenue is the one-line
    // version that hides a systematic pricing disagreement for a year.
    const p = settlementPosting({
      tenantId: 't',
      subjectId: 's',
      settlementId: 'i1',
      accrued: usd('19.99'),
      settled: usd('20.50'),
    });
    assertBalanced(p.legs);
    const variance = p.legs.find((l) => l.account === 'settlement_variance');
    assert.equal(variance?.amount.toDecimalString(), '0.51');
  });

  it('omits the variance leg when the two numbers agree', () => {
    const p = settlementPosting({
      tenantId: 't',
      subjectId: 's',
      settlementId: 'i2',
      accrued: usd('19.99'),
      settled: usd('19.99'),
    });
    assert.equal(p.legs.length, 2);
    assert.equal(p.legs.some((l) => l.account === 'settlement_variance'), false);
  });

  it('refuses a negative refund, because the legs carry the direction', () => {
    assert.throws(
      () =>
        refundPosting({
          tenantId: 't',
          subjectId: 's',
          refundId: 'r1',
          amount: usd('-5.00'),
          occurredAt: NOW,
        }),
      (e: unknown) => BillingError.hasCode(e, 'invalid_allocation'),
    );
  });

  it('makes a refund the mirror of a payment, not an edit of it', () => {
    const pay = paymentPosting({ tenantId: 't', subjectId: 's', paymentId: 'p1', amount: usd('19.99'), occurredAt: NOW });
    const ref = refundPosting({ tenantId: 't', subjectId: 's', refundId: 'r1', amount: usd('19.99'), occurredAt: NOW });

    const cashIn = pay.legs.find((l) => l.account === 'cash')!;
    const cashOut = ref.legs.find((l) => l.account === 'cash')!;
    assert.equal(cashIn.amount.plus(cashOut.amount).minor, 0n);
  });
});

const harness = await setupDatabase();

after(async () => {
  await harness?.close();
});

describe('ledger persistence', { skip: harness === null ? SKIP_REASON : false }, () => {
  const h = harness as Harness;

  it('writes both legs of a balanced posting', async () => {
    const chargeId = nextId('charge');
    const result = await post(
      h.db,
      accrualPosting({ tenantId: 't1', subjectId: 's1', chargeId, amount: usd('19.99') }),
      NOW,
    );

    assert.equal(result.deduplicated, false);
    assert.equal(result.entries.length, 2);
    assert.deepEqual(result.entries.map((e) => e.legNo), [0, 1]);
    assert.equal(
      Money.sum(result.entries.map((e) => e.amount), 'USD').minor,
      0n,
    );
  });

  it('reads amounts back exactly, through the driver', async () => {
    const chargeId = nextId('charge');
    // Larger than 2^53, so a driver or a layer that reached for a JS number
    // would come back with a different value.
    const amount = Money.fromMinor('9007199254740993', 'USD');
    const result = await post(
      h.db,
      accrualPosting({ tenantId: 't1', subjectId: 's-big', chargeId, amount }),
      NOW,
    );
    const debit = result.entries.find((e) => e.account === 'customer_balance')!;
    assert.equal(debit.amount.minor, 9007199254740993n);
    assert.equal(debit.amount.toJSON().amount, '9007199254740993');
  });

  it('replays a posting without writing it twice', async () => {
    const chargeId = nextId('charge');
    const posting = accrualPosting({ tenantId: 't1', subjectId: 's2', chargeId, amount: usd('5.00') });

    const first = await post(h.db, posting, NOW);
    const second = await post(h.db, posting, NOW);

    assert.equal(first.deduplicated, false);
    assert.equal(second.deduplicated, true);
    assert.equal(second.transactionId, first.transactionId);
    assert.equal(second.entries.length, 2);

    const bal = await balance(h.db, {
      tenantId: 't1',
      subjectId: 's2',
      account: 'customer_balance',
      currency: 'USD',
    });
    assert.equal(bal.toDecimalString(), '5.00', 'the replay must not double the balance');
  });

  it('scopes idempotency by tenant', async () => {
    const chargeId = nextId('charge');
    const a = await post(h.db, accrualPosting({ tenantId: 'ta', subjectId: 's', chargeId, amount: usd('1.00') }), NOW);
    const b = await post(h.db, accrualPosting({ tenantId: 'tb', subjectId: 's', chargeId, amount: usd('1.00') }), NOW);
    assert.equal(a.deduplicated, false);
    assert.equal(b.deduplicated, false);
    assert.notEqual(a.transactionId, b.transactionId);
  });

  it('refuses an unbalanced posting before it reaches the database', async () => {
    await assert.rejects(
      () =>
        post(
          h.db,
          {
            tenantId: 't1',
            sourceKind: 'adjustment',
            sourceId: nextId('adj'),
            legs: [
              { account: 'cash', subjectId: 's3', amount: usd('1.00') },
              { account: 'customer_balance', subjectId: 's3', amount: usd('-0.99') },
            ],
          },
          NOW,
        ),
      (e: unknown) => BillingError.hasCode(e, 'unbalanced_transaction'),
    );
  });

  it('has a database backstop when the application guard is bypassed', async () => {
    // Written as raw SQL on purpose: this asserts the deferred constraint
    // trigger, not the TypeScript check that would normally have caught it.
    // The trigger is what protects the ledger from the next writer, who may
    // not be this library.
    await assert.rejects(
      () =>
        h.db.transaction(async (tx) => {
          await tx.query(
            `INSERT INTO billing.ledger_transactions (id, tenant_id, source_kind, source_id, posted_at)
             VALUES (gen_random_uuid(), 't1', 'adjustment', $1, $2)`,
            [nextId('raw'), NOW],
          );
          await tx.query(
            `INSERT INTO billing.ledger_entries
               (id, transaction_id, tenant_id, subject_id, account, currency,
                amount_minor, leg_no, source_kind, source_id, posted_at)
             SELECT gen_random_uuid(), id, 't1', 's4', 'cash', 'USD', 100, 0, 'adjustment', source_id, posted_at
               FROM billing.ledger_transactions WHERE source_id = $1`,
            [`raw-${seq}`],
          );
        }),
      /does not sum to zero/,
    );
  });

  it('refuses UPDATE and DELETE at the database', async () => {
    const chargeId = nextId('charge');
    await post(h.db, accrualPosting({ tenantId: 't1', subjectId: 's5', chargeId, amount: usd('2.00') }), NOW);

    await assert.rejects(
      () => h.db.query('UPDATE billing.ledger_entries SET amount_minor = 0 WHERE subject_id = $1', ['s5']),
      /append-only/,
    );
    await assert.rejects(
      () => h.db.query('DELETE FROM billing.ledger_entries WHERE subject_id = $1', ['s5']),
      /append-only/,
    );
  });

  it('sums a balance exactly across many postings', async () => {
    const subjectId = 'sum-subject';
    for (let i = 0; i < 50; i++) {
      await post(
        h.db,
        accrualPosting({ tenantId: 't1', subjectId, chargeId: nextId('charge'), amount: usd('0.07') }),
        NOW,
      );
    }
    const bal = await balance(h.db, {
      tenantId: 't1',
      subjectId,
      account: 'customer_balance',
      currency: 'USD',
    });
    // 50 x 0.07 = 3.50 exactly. Accumulating 0.07 fifty times as a double gives
    // 3.4999999999999996, and SUM(double precision) may not even be stable.
    assert.equal(bal.toDecimalString(), '3.50');
  });

  it('keeps balances separate per currency', async () => {
    const subjectId = 'multi-currency';
    await post(
      h.db,
      accrualPosting({ tenantId: 't1', subjectId, chargeId: nextId('charge'), amount: usd('10.00') }),
      NOW,
    );
    await post(
      h.db,
      accrualPosting({
        tenantId: 't1',
        subjectId,
        chargeId: nextId('charge'),
        amount: Money.fromDecimalString('7.00', 'EUR'),
      }),
      NOW,
    );

    const inUsd = await balance(h.db, { tenantId: 't1', subjectId, account: 'customer_balance', currency: 'USD' });
    const inEur = await balance(h.db, { tenantId: 't1', subjectId, account: 'customer_balance', currency: 'EUR' });
    assert.equal(inUsd.toDecimalString(), '10.00');
    assert.equal(inEur.toDecimalString(), '7.00');
  });

  it('returns zero rather than null for an account never posted to', async () => {
    const bal = await balance(h.db, {
      tenantId: 't1',
      subjectId: 'never-seen',
      account: 'cash',
      currency: 'USD',
    });
    assert.equal(bal.minor, 0n);
    assert.equal(bal.currency, 'USD');
  });

  it('honours asOf so a balance can be reconstructed at a past instant', async () => {
    const subjectId = 'as-of-subject';
    await post(
      h.db,
      {
        ...accrualPosting({ tenantId: 't1', subjectId, chargeId: nextId('charge'), amount: usd('1.00') }),
        postedAt: new Date('2026-08-01T00:00:00Z'),
      },
      NOW,
    );
    await post(
      h.db,
      {
        ...accrualPosting({ tenantId: 't1', subjectId, chargeId: nextId('charge'), amount: usd('2.00') }),
        postedAt: new Date('2026-08-10T00:00:00Z'),
      },
      NOW,
    );

    const early = await balance(h.db, {
      tenantId: 't1',
      subjectId,
      account: 'customer_balance',
      currency: 'USD',
      asOf: new Date('2026-08-05T00:00:00Z'),
    });
    const late = await balance(h.db, {
      tenantId: 't1',
      subjectId,
      account: 'customer_balance',
      currency: 'USD',
    });
    assert.equal(early.toDecimalString(), '1.00');
    assert.equal(late.toDecimalString(), '3.00');
  });

  it('walks a full charge, settle and pay cycle to a zero balance', async () => {
    const subjectId = 'lifecycle';
    const amount = usd('19.99');

    await post(h.db, accrualPosting({ tenantId: 't1', subjectId, chargeId: nextId('charge'), amount }), NOW);
    await post(
      h.db,
      settlementPosting({
        tenantId: 't1',
        subjectId,
        settlementId: nextId('settle'),
        accrued: amount,
        settled: amount,
      }),
      NOW,
    );
    await post(
      h.db,
      paymentPosting({ tenantId: 't1', subjectId, paymentId: nextId('pay'), amount, occurredAt: NOW }),
      NOW,
    );

    const owed = await balance(h.db, { tenantId: 't1', subjectId, account: 'customer_balance', currency: 'USD' });
    const cash = await balance(h.db, { tenantId: 't1', subjectId, account: 'cash', currency: 'USD' });
    const settled = await balance(h.db, { tenantId: 't1', subjectId, account: 'revenue_settled', currency: 'USD' });
    const accrued = await balance(h.db, { tenantId: 't1', subjectId, account: 'revenue_accrued', currency: 'USD' });

    assert.equal(owed.toDecimalString(), '0.00', 'the customer paid what was charged');
    assert.equal(cash.toDecimalString(), '19.99');
    assert.equal(settled.toDecimalString(), '-19.99');
    assert.equal(accrued.toDecimalString(), '0.00', 'accrued revenue moved to settled');
  });

  it('reverses with a refund rather than editing the payment', async () => {
    const subjectId = 'refund-subject';
    const amount = usd('19.99');
    await post(
      h.db,
      paymentPosting({ tenantId: 't1', subjectId, paymentId: nextId('pay'), amount, occurredAt: NOW }),
      NOW,
    );
    await post(
      h.db,
      refundPosting({ tenantId: 't1', subjectId, refundId: nextId('refund'), amount, occurredAt: NOW }),
      NOW,
    );

    const cash = await balance(h.db, { tenantId: 't1', subjectId, account: 'cash', currency: 'USD' });
    assert.equal(cash.toDecimalString(), '0.00');

    const rows = await entries(h.db, { tenantId: 't1', subjectId });
    assert.equal(rows.length, 4, 'both the payment and the refund survive as history');
    assert.deepEqual(
      [...new Set(rows.map((r) => r.sourceKind))].sort(),
      ['payment', 'refund'],
    );
  });

  it('lists entries oldest first and filters by account', async () => {
    const subjectId = 'listing';
    await post(
      h.db,
      accrualPosting({ tenantId: 't1', subjectId, chargeId: nextId('charge'), amount: usd('1.00') }),
      NOW,
    );
    const all = await entries(h.db, { tenantId: 't1', subjectId });
    const onlyCash = await entries(h.db, { tenantId: 't1', subjectId, account: 'revenue_accrued' });

    assert.equal(all.length, 2);
    assert.equal(onlyCash.length, 1);
    assert.equal(onlyCash[0]!.account, 'revenue_accrued');
    for (let i = 1; i < all.length; i++) {
      assert.ok(all[i - 1]!.postedAt.getTime() <= all[i]!.postedAt.getTime());
    }
  });
});
