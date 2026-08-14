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
  creditNotePosting,
  entries,
  paymentPosting,
  post,
  refundPosting,
  settlementPosting,
  walletBalance,
  walletRedeemPosting,
  walletTopupPosting,
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

describe('partition maintenance', { skip: harness === null ? SKIP_REASON : false }, () => {
  const h = harness as Harness;

  const rowsIn = async (table: string, subjectId: string): Promise<number> => {
    const rows = await h.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM billing.${table} WHERE subject_id = $1`,
      [subjectId],
    );
    return Number(rows[0]!.n);
  };

  it('stores a posting outside every month partition, in the default', async () => {
    // A payment webhook that arrives for a date nobody built a partition for.
    // Without a default partition Postgres refuses the insert — "no partition
    // of relation ... found for row" — and a real payment cannot be recorded.
    const long = new Date(NOW.getTime() - 400 * 24 * 3600e3);
    await post(
      h.db,
      paymentPosting({
        tenantId: 't1', subjectId: 'far-past', paymentId: nextId('pay'),
        amount: usd('42.00'), occurredAt: long,
      }),
      NOW,
    );

    assert.equal(await rowsIn('ledger_entries_default', 'far-past'), 2);

    const cash = await balance(h.db, {
      tenantId: 't1', subjectId: 'far-past', account: 'cash', currency: 'USD',
    });
    assert.equal(cash.toDecimalString(), '42.00', 'and it is part of the balance, not a row in a corner');
  });

  it('moves rows out of the default when their month partition is created', async () => {
    // The failure this covers is the one that turns the default partition from
    // a safety net into a trap. `CREATE TABLE ... PARTITION OF` fails outright
    // when the default already holds a row belonging to the new range, so the
    // first late payment would break every subsequent partition-maintenance run
    // — and it would break it forever, silently, as a cron job that stopped
    // creating partitions rather than as anything to do with the payment.
    const late = new Date(NOW.getTime() - 150 * 24 * 3600e3);
    const paymentId = nextId('pay');
    await post(
      h.db,
      paymentPosting({
        tenantId: 't1', subjectId: 'late-payment', paymentId,
        amount: usd('7.50'), occurredAt: late,
      }),
      NOW,
    );
    assert.equal(await rowsIn('ledger_entries_default', 'late-payment'), 2, 'starts in the default');

    // Widen the window backwards so the month covering `late` gets a partition.
    // This is the call that used to be impossible once the default was dirty.
    await h.db.query('SELECT billing.ensure_core_partitions(2, $1)', [late]);

    assert.equal(await rowsIn('ledger_entries_default', 'late-payment'), 0, 'moved out of the default');
    const month = `ledger_entries_${late.getUTCFullYear()}m${String(late.getUTCMonth() + 1).padStart(2, '0')}`;
    assert.equal(await rowsIn(month, 'late-payment'), 2, `moved into ${month}`);

    // The money did not change on the way, and the entries are still reachable
    // through the parent rather than stranded in a partition.
    const cash = await balance(h.db, {
      tenantId: 't1', subjectId: 'late-payment', account: 'cash', currency: 'USD',
    });
    assert.equal(cash.toDecimalString(), '7.50');
    const rows = await entries(h.db, { tenantId: 't1', subjectId: 'late-payment' });
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.sourceId, paymentId);

    // Rows for months that still have no partition stay put rather than being
    // dragged along, and the default is still append-only afterwards: the move
    // disables that trigger for the duration and must put it back.
    assert.equal(await rowsIn('ledger_entries_default', 'far-past'), 2);
    await assert.rejects(
      () => h.db.query(`DELETE FROM billing.ledger_entries_default WHERE subject_id = 'far-past'`),
      /append-only/,
    );
  });

  it('gives every month partition exactly one UTC calendar month', async () => {
    // Adding a month to a timestamptz resolves the calendar in the session's
    // TimeZone, so a UTC-anchored start of 2026-07-01T00:00Z (2026-06-30 19:00
    // in America/Chicago) plus one month landed on 2026-07-30 19:00 local =
    // 2026-07-31T00:00Z — a day before the August partition began. Everything
    // posted during that day belonged to no partition at all, and with a
    // DEFAULT partition in place it would have gone there quietly instead of
    // erroring, which is worse.
    //
    // Asserted per partition rather than by comparing neighbours, because
    // ensure_core_partitions may legitimately have been called for two
    // disjoint windows and the space between them is not a bug. Each partition
    // starting on a UTC month boundary and ending on the next one is the whole
    // property, and it holds whatever else has been created.
    const rows = await h.db.query<{ bad: string }>(`
      WITH b AS (
        SELECT p.relname,
               (regexp_match(pg_get_expr(p.relpartbound, p.oid), 'FROM \\(''([^'']+)''\\)'))[1]::timestamptz AS lo,
               (regexp_match(pg_get_expr(p.relpartbound, p.oid), 'TO \\(''([^'']+)''\\)'))[1]::timestamptz AS hi
          FROM pg_class c
          JOIN pg_inherits i ON i.inhparent = c.oid
          JOIN pg_class p ON p.oid = i.inhrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'billing' AND c.relname = 'ledger_entries'
           AND pg_get_expr(p.relpartbound, p.oid) <> 'DEFAULT'
      )
      SELECT count(*)::text AS bad FROM b
       WHERE lo <> (date_trunc('month', lo AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
          OR hi <> ((date_trunc('month', lo AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC')`);
    assert.equal(rows[0]!.bad, '0', 'a month partition must span exactly one UTC calendar month');
  });
});

describe('credit notes', () => {
  it('reverses a charge: balanced legs, opposite sign to the accrual', () => {
    const note = creditNotePosting({ tenantId: 't1', subjectId: 's1', creditNoteId: 'cn_1', amount: usd('19.99') });
    assertBalanced(note.legs);
    const bySide = Object.fromEntries(note.legs.map((l) => [l.account, l.amount.minor]));
    // accrual is customer_balance +, revenue_accrued −; a credit note is the mirror
    assert.equal(bySide['customer_balance'], -1999n);
    assert.equal(bySide['revenue_accrued'], 1999n);
  });

  it('refuses a negative amount', () => {
    assert.throws(
      () => creditNotePosting({ tenantId: 't1', subjectId: 's1', creditNoteId: 'cn_x', amount: usd('-1.00') }),
      (e: unknown) => BillingError.hasCode(e, 'invalid_allocation'),
    );
  });
});

describe('credit notes and wallets — Postgres', { skip: harness === null ? SKIP_REASON : false }, () => {
  const h = harness as Harness;

  it('a credit note lowers a customer balance without editing the charge', async () => {
    const subjectId = nextId('sub');
    await post(h.db, accrualPosting({ tenantId: 't1', subjectId, chargeId: nextId('charge'), amount: usd('50.00') }), NOW);
    await post(h.db, creditNotePosting({ tenantId: 't1', subjectId, creditNoteId: nextId('cn'), amount: usd('20.00') }), NOW);

    const bal = await balance(h.db, { tenantId: 't1', subjectId, account: 'customer_balance', currency: 'USD' });
    assert.equal(bal.minor, 3000n, '50 charged − 20 credited');
    // both rows still exist — nothing was edited
    const rows = await entries(h.db, { tenantId: 't1', subjectId });
    assert.equal(rows.length, 4);
  });

  it('a wallet is topped up from a payment and drawn down against a charge', async () => {
    const subjectId = nextId('wal');
    // prepaid top-up: cash in, credit liability up
    await post(h.db, walletTopupPosting({ tenantId: 't1', subjectId, paymentId: nextId('pay'), amount: usd('50.00'), occurredAt: NOW }), NOW);
    assert.equal((await walletBalance(h.db, { tenantId: 't1', subjectId, currency: 'USD' })).minor, 5000n);

    // charge 30, then redeem it from the wallet
    await post(h.db, accrualPosting({ tenantId: 't1', subjectId, chargeId: nextId('charge'), amount: usd('30.00') }), NOW);
    await post(h.db, walletRedeemPosting({ tenantId: 't1', subjectId, redemptionId: nextId('rdm'), amount: usd('30.00') }), NOW);

    // wallet down to 20, and the charge is settled by the credit
    assert.equal((await walletBalance(h.db, { tenantId: 't1', subjectId, currency: 'USD' })).minor, 2000n);
    const owed = await balance(h.db, { tenantId: 't1', subjectId, account: 'customer_balance', currency: 'USD' });
    assert.equal(owed.minor, 0n, '30 charged − 30 redeemed');
  });

  it('redeeming is idempotent on its id', async () => {
    const subjectId = nextId('wal');
    await post(h.db, walletTopupPosting({ tenantId: 't1', subjectId, paymentId: nextId('pay'), amount: usd('10.00'), occurredAt: NOW }), NOW);
    const redeem = walletRedeemPosting({ tenantId: 't1', subjectId, redemptionId: 'rdm_fixed', amount: usd('4.00') });
    const first = await post(h.db, redeem, NOW);
    const again = await post(h.db, redeem, NOW);
    assert.equal(first.deduplicated, false);
    assert.equal(again.deduplicated, true);
    assert.equal((await walletBalance(h.db, { tenantId: 't1', subjectId, currency: 'USD' })).minor, 600n);
  });
});
