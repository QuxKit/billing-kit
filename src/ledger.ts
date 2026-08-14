// The double-entry ledger.
//
// This is the financial record. It outlives the provider, the pricing model and
// probably the application, which is why it is here rather than delegated: a
// provider's invoice list is their view of your money, and it stops being
// available on the day you stop paying them.
//
// Three properties, and every one of them is enforced rather than documented:
//
//   append-only    no UPDATE, no DELETE, no API for either, and a trigger on
//                  every partition that raises if someone tries in psql.
//   balanced       the legs of a transaction sum to zero per currency, checked
//                  here before the write and again by a deferred constraint
//                  trigger at COMMIT.
//   idempotent     (tenant, source_kind, source_id) is the natural key, so
//                  replaying a posting writes nothing the second time.
//
// Sign convention, stated once: positive is a debit, negative is a credit.
// Leaving that implicit is how two halves of a codebase end up disagreeing
// about the sign of a credit, with a balance that is right for charges and
// inverted for refunds.
//
// Note what does not exist here: there is no `credit(subject, amount)`. Cash
// posts to the ledger from a verified payment webhook and from nowhere else.
// An HTTP handler that adds to a balance from a request body, with no processor
// call behind it, is a defect that has actually shipped in a real application;
// the fix is that the function it would have called is not exported.

import { randomUUID } from 'node:crypto';
import { BillingError } from './errors';
import { Money } from './money';
import type {
  AccountKind,
  LedgerEntry,
  LedgerLeg,
  LedgerPosting,
  LedgerSourceKind,
  PostedTransaction,
  SqlExecutor,
  SubjectId,
  TenantId,
} from './types';

/**
 * Check that the legs sum to zero, per currency.
 *
 * Per currency and not overall: a transaction with +100 USD and -100 EUR sums
 * to zero as a number and is not a balanced transaction, it is a hole with a
 * cancelling hole next to it. Cross-currency movement needs an explicit
 * conversion account and a rate, and until that exists the correct behaviour is
 * to refuse.
 *
 * Exported because it is worth testing on its own and worth calling from a
 * caller that composes legs before deciding to post them.
 */
export function assertBalanced(legs: readonly LedgerLeg[]): void {
  if (legs.length < 2) {
    throw new BillingError({
      code: 'unbalanced_transaction',
      currency: legs[0]?.amount.currency ?? 'none',
      residualMinor: 'a transaction needs at least two legs',
    });
  }

  const totals = new Map<string, bigint>();
  for (const leg of legs) {
    const current = totals.get(leg.amount.currency) ?? 0n;
    totals.set(leg.amount.currency, current + leg.amount.minor);
  }

  for (const [currency, residual] of totals) {
    if (residual !== 0n) {
      throw new BillingError({
        code: 'unbalanced_transaction',
        currency,
        residualMinor: residual.toString(),
      });
    }
  }
}

interface EntryRow {
  id: string;
  transaction_id: string;
  tenant_id: string;
  subject_id: string;
  account: AccountKind;
  currency: string;
  amount_minor: string;
  leg_no: number;
  source_kind: LedgerSourceKind;
  source_id: string;
  posted_at: Date;
  memo: string | null;
}

function toEntry(row: EntryRow): LedgerEntry {
  return {
    id: row.id,
    transactionId: row.transaction_id,
    tenantId: row.tenant_id,
    subjectId: row.subject_id,
    account: row.account,
    // BIGINT arrives as a string from node-postgres, which refuses to risk the
    // lossy cast to number on your behalf. Keep the refusal.
    amount: Money.fromMinor(row.amount_minor, row.currency.trim()),
    legNo: Number(row.leg_no),
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    postedAt: row.posted_at,
    memo: row.memo,
  };
}

async function entriesOfTransaction(tx: SqlExecutor, transactionId: string): Promise<LedgerEntry[]> {
  const rows = await tx.query<EntryRow>(
    `SELECT id, transaction_id, tenant_id, subject_id, account, currency,
            amount_minor::text AS amount_minor, leg_no, source_kind, source_id, posted_at, memo
       FROM billing.ledger_entries
      WHERE transaction_id = $1
      ORDER BY leg_no`,
    [transactionId],
  );
  return rows.map(toEntry);
}

/**
 * Refuse a replay whose legs are not the legs that were posted.
 *
 * The idempotency key is (tenantId, sourceKind, sourceId) and says nothing
 * about the amounts. So posting `charge-7` for $5.00 and then posting
 * `charge-7` for $500.00 hits the claim, returns the $5.00 transaction with
 * `deduplicated: true`, and writes nothing. The caller is told it succeeded.
 * The $500.00 is gone — not rejected, not logged, not anywhere.
 *
 * This is worse here than in ingest, because a ledger is the record other
 * things are reconciled against. The discrepancy has no trace to follow: there
 * is no failed row, no error, and the transaction that exists looks perfectly
 * well formed. It surfaces as a balance that disagrees with a provider's, and
 * whoever chases it starts from a ledger that says nothing happened.
 *
 * Correcting a posted transaction is not a second `post` under the same key in
 * any case. A ledger is append-only: a correction is a reversing entry and a
 * new posting, both of which stay visible. Overwriting would destroy the audit
 * trail that is the reason to keep a double-entry ledger at all. So the
 * mismatch is refused, and `idempotency_conflict` is the code errors.ts already
 * reserved for it.
 *
 * What is compared is the whole of what the legs mean: the account, the
 * subject, the amount and its currency, in order. `memo` is not — it is prose
 * for a human reading a statement, and a retry that improves the wording has
 * not changed what was posted.
 */
function assertSameLegs(posting: LedgerPosting, existing: readonly LedgerEntry[]): void {
  const key = `${posting.sourceKind}/${posting.sourceId}`;
  const conflict = (detail: string): never => {
    throw new BillingError({ code: 'idempotency_conflict', operation: 'post', key, detail });
  };

  if (existing.length !== posting.legs.length) {
    conflict(`the posted transaction has ${existing.length} legs, this call sent ${posting.legs.length}`);
  }

  // By leg_no, which entriesOfTransaction already orders by and which the
  // insert assigns from the array index — so position is meaningful and two
  // legs cannot be matched to each other by accident.
  for (const [i, leg] of posting.legs.entries()) {
    const was = existing[i]!;
    if (was.subjectId !== leg.subjectId) {
      conflict(`leg ${i} was for subject ${was.subjectId}, this call sent ${leg.subjectId}`);
    }
    if (was.account !== leg.account) {
      conflict(`leg ${i} was ${was.account}, this call sent ${leg.account}`);
    }
    if (was.amount.currency !== leg.amount.currency) {
      conflict(`leg ${i} was in ${was.amount.currency}, this call sent ${leg.amount.currency}`);
    }
    if (was.amount.minor !== leg.amount.minor) {
      conflict(
        `leg ${i} (${leg.account}) was ${was.amount.toDecimalString()}, ` +
          `this call sent ${leg.amount.toDecimalString()}`,
      );
    }
  }
}

/**
 * Post one transaction. The only write path into the ledger.
 *
 * Idempotent on (tenantId, sourceKind, sourceId). Replaying the posting for a
 * charge returns the transaction that already exists, with
 * `deduplicated: true`, and writes nothing — the same contract as usage ingest,
 * for the same reason: the retry has to be boring.
 *
 * The claim uses `ON CONFLICT DO UPDATE` rather than `DO NOTHING` for the
 * reason spelled out in events.ts — `DO NOTHING` neither returns the existing
 * row nor waits for a concurrent uncommitted insert of the same key, so the
 * racing retry has no branch that is correct.
 */
export async function post(db: SqlExecutor, posting: LedgerPosting, now: Date): Promise<PostedTransaction> {
  assertBalanced(posting.legs);

  return db.transaction(async (tx) => {
    const transactionId = randomUUID();
    const postedAt = posting.postedAt ?? now;

    const claim = await tx.query<{ id: string; inserted: boolean }>(
      `INSERT INTO billing.ledger_transactions
         (id, tenant_id, source_kind, source_id, posted_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (tenant_id, source_kind, source_id)
       DO UPDATE SET source_id = billing.ledger_transactions.source_id
       RETURNING id, (xmax = 0) AS inserted`,
      [
        transactionId,
        posting.tenantId,
        posting.sourceKind,
        posting.sourceId,
        postedAt,
        posting.metadata === undefined ? null : JSON.stringify(posting.metadata),
      ],
    );

    const row = claim[0];
    if (row === undefined) {
      throw new BillingError({ code: 'not_found', what: 'ledger_transaction', id: posting.sourceId });
    }

    if (!row.inserted) {
      const existing = await entriesOfTransaction(tx, row.id);
      assertSameLegs(posting, existing);
      return {
        transactionId: row.id,
        entries: existing,
        deduplicated: true,
      };
    }

    const legs = posting.legs;
    await tx.query(
      `INSERT INTO billing.ledger_entries
         (id, transaction_id, tenant_id, subject_id, account, currency,
          amount_minor, leg_no, source_kind, source_id, posted_at, memo)
       SELECT * FROM unnest(
         $1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::text[], $6::char(3)[],
         $7::bigint[], $8::smallint[], $9::text[], $10::text[], $11::timestamptz[], $12::text[]
       )`,
      [
        legs.map(() => randomUUID()),
        legs.map(() => transactionId),
        legs.map(() => posting.tenantId),
        legs.map((l) => l.subjectId),
        legs.map((l) => l.account),
        legs.map((l) => l.amount.currency),
        // Minor units as strings. A bigint handed to node-postgres is
        // stringified anyway; doing it here makes it explicit that nothing on
        // this path was ever a JS number.
        legs.map((l) => l.amount.minor.toString()),
        legs.map((_l, i) => i),
        legs.map(() => posting.sourceKind),
        legs.map(() => posting.sourceId),
        legs.map(() => postedAt),
        legs.map((l) => l.memo ?? null),
      ],
    );

    return {
      transactionId,
      entries: await entriesOfTransaction(tx, transactionId),
      deduplicated: false,
    };
  });
}

export interface BalanceQuery {
  tenantId: TenantId;
  subjectId: SubjectId;
  account: AccountKind;
  currency: string;
  /** Balance as of this instant, exclusive. Defaults to everything posted. */
  asOf?: Date;
}

/**
 * The balance of one account, for one subject, in one currency.
 *
 * `SUM(amount_minor)` over BIGINT widens to NUMERIC in Postgres, so this cannot
 * overflow, and it is exact in any evaluation order — which is the property
 * that makes the number reproducible. The same query over `double precision`
 * can return different totals for the same rows depending on whether the
 * planner chose a parallel aggregate.
 */
export async function balance(db: SqlExecutor, q: BalanceQuery): Promise<Money> {
  const rows = await db.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(amount_minor), 0)::text AS total
       FROM billing.ledger_entries
      WHERE tenant_id = $1
        AND subject_id = $2
        AND account = $3
        AND currency = $4
        AND ($5::timestamptz IS NULL OR posted_at < $5)`,
    [q.tenantId, q.subjectId, q.account, q.currency, q.asOf ?? null],
  );

  return Money.fromMinor(rows[0]?.total ?? '0', q.currency);
}

export interface EntriesQuery {
  tenantId: TenantId;
  subjectId: SubjectId;
  account?: AccountKind;
  since?: Date;
  until?: Date;
  limit?: number;
}

/** How many rows one round trip pulls back when paging the unbounded read. */
const ENTRIES_PAGE = 1000;

/**
 * Read entries back, oldest first. Never mutates; there is no path that does.
 *
 * An explicit `limit` is a page the caller asked for, and is returned as-is. No
 * limit means "every matching entry", and that is the case that used to lie: the
 * old default capped silently at 500, so a balance re-derived by summing
 * `entries()` came back short and disagreed with `balance()` — the authoritative
 * SQL sum — with nothing to say why. A ledger that under-reports its own history
 * without erroring is the worst kind of wrong.
 *
 * So the unbounded read pages to the end with a keyset cursor over the sort key
 * (posted_at, transaction_id, leg_no). Keyset, not OFFSET: OFFSET rescans the
 * skipped rows every page and drifts if a row is inserted mid-walk, and the
 * ledger is append-only so the cursor is stable.
 */
export async function entries(db: SqlExecutor, q: EntriesQuery): Promise<LedgerEntry[]> {
  const select = `SELECT id, transaction_id, tenant_id, subject_id, account, currency,
            amount_minor::text AS amount_minor, leg_no, source_kind, source_id, posted_at, memo
       FROM billing.ledger_entries
      WHERE tenant_id = $1
        AND subject_id = $2
        AND ($3::text IS NULL OR account = $3)
        AND ($4::timestamptz IS NULL OR posted_at >= $4)
        AND ($5::timestamptz IS NULL OR posted_at <  $5)`;

  if (q.limit !== undefined) {
    const rows = await db.query<EntryRow>(
      `${select}
       ORDER BY posted_at, transaction_id, leg_no
       LIMIT $6`,
      [q.tenantId, q.subjectId, q.account ?? null, q.since ?? null, q.until ?? null, q.limit],
    );
    return rows.map(toEntry);
  }

  const all: LedgerEntry[] = [];
  let cursor: { postedAt: Date; txId: string; legNo: number } | null = null;
  for (;;) {
    // Annotated: the cursor is derived from a row and then feeds the next
    // query's parameters, and without this the inference runs in a circle.
    const rows: EntryRow[] = await db.query<EntryRow>(
      `${select}
        AND ($6::timestamptz IS NULL
             OR (posted_at, transaction_id, leg_no) > ($6::timestamptz, $7::uuid, $8::int))
       ORDER BY posted_at, transaction_id, leg_no
       LIMIT ${ENTRIES_PAGE}`,
      [
        q.tenantId, q.subjectId, q.account ?? null, q.since ?? null, q.until ?? null,
        cursor?.postedAt ?? null, cursor?.txId ?? null, cursor?.legNo ?? null,
      ],
    );
    for (const row of rows) all.push(toEntry(row));
    if (rows.length < ENTRIES_PAGE) return all;
    const last: EntryRow = rows[rows.length - 1]!;
    cursor = { postedAt: last.posted_at, txId: last.transaction_id, legNo: last.leg_no };
  }
}

// --- standard postings ------------------------------------------------------
//
// Builders, not writers. They return a LedgerPosting for `post` to write, so
// that a caller can inspect and test the legs without a database, and so that
// composing several postings into one transaction stays possible.

/**
 * A charge accrues revenue against the customer's balance.
 *
 * Always our number: this is what our own pricing tables say the period costs,
 * posted when we compute it and not when a provider agrees with it.
 */
export function accrualPosting(input: {
  tenantId: TenantId;
  subjectId: SubjectId;
  chargeId: string;
  amount: Money;
  memo?: string;
}): LedgerPosting {
  return {
    tenantId: input.tenantId,
    sourceKind: 'charge',
    sourceId: input.chargeId,
    legs: [
      { account: 'customer_balance', subjectId: input.subjectId, amount: input.amount, memo: input.memo },
      { account: 'revenue_accrued', subjectId: input.subjectId, amount: input.amount.negate(), memo: input.memo },
    ],
  };
}

/**
 * Settlement moves accrued revenue to settled, at the provider's number.
 *
 * The two numbers are allowed to differ and the difference is the point. Under
 * `quantity` settlement, or with any merchant-of-record provider, the provider
 * holds the price and theirs is authoritative — ours was an estimate. The gap
 * posts to `settlement_variance`, where a non-zero balance is an alert.
 *
 * Absorbing the gap into revenue instead is the tempting one-line version, and
 * it hides a systematic pricing disagreement for as long as nobody reconciles
 * by hand.
 */
export function settlementPosting(input: {
  tenantId: TenantId;
  subjectId: SubjectId;
  settlementId: string;
  accrued: Money;
  settled: Money;
  memo?: string;
}): LedgerPosting {
  const variance = input.settled.minus(input.accrued);

  const legs: LedgerLeg[] = [
    { account: 'revenue_accrued', subjectId: input.subjectId, amount: input.accrued, memo: input.memo },
    { account: 'revenue_settled', subjectId: input.subjectId, amount: input.settled.negate(), memo: input.memo },
  ];

  if (!variance.isZero()) {
    legs.push({
      account: 'settlement_variance',
      subjectId: input.subjectId,
      amount: variance,
      memo: input.memo ?? 'provider total differs from accrued total',
    });
  }

  return { tenantId: input.tenantId, sourceKind: 'settlement', sourceId: input.settlementId, legs };
}

/**
 * Cash arriving.
 *
 * Only ever built from a verified `payment.succeeded` webhook. On a provider
 * whose `capturesPayment` is false, settlement means invoiced and this posting
 * may not arrive for days — which is exactly why invoicing and payment are two
 * ledger events rather than one.
 */
export function paymentPosting(input: {
  tenantId: TenantId;
  subjectId: SubjectId;
  paymentId: string;
  amount: Money;
  occurredAt: Date;
  memo?: string;
}): LedgerPosting {
  return {
    tenantId: input.tenantId,
    sourceKind: 'payment',
    sourceId: input.paymentId,
    postedAt: input.occurredAt,
    legs: [
      { account: 'cash', subjectId: input.subjectId, amount: input.amount, memo: input.memo },
      { account: 'customer_balance', subjectId: input.subjectId, amount: input.amount.negate(), memo: input.memo },
    ],
  };
}

/**
 * Money going back out. The mirror of a payment, never an edit of one.
 *
 * `amount` is positive and the legs invert it. Posting a refund by reversing
 * the original payment's rows in place would be the shorter code and would
 * destroy the record that the payment happened at all.
 */
export function refundPosting(input: {
  tenantId: TenantId;
  subjectId: SubjectId;
  refundId: string;
  amount: Money;
  occurredAt: Date;
  memo?: string;
}): LedgerPosting {
  if (input.amount.isNegative()) {
    throw new BillingError({
      code: 'invalid_allocation',
      reason: 'refund amount must be positive; the legs carry the direction',
    });
  }
  return {
    tenantId: input.tenantId,
    sourceKind: 'refund',
    sourceId: input.refundId,
    postedAt: input.occurredAt,
    legs: [
      { account: 'customer_balance', subjectId: input.subjectId, amount: input.amount, memo: input.memo },
      { account: 'cash', subjectId: input.subjectId, amount: input.amount.negate(), memo: input.memo },
    ],
  };
}
