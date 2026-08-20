// Persistence for dunning cases: opening one, closing one, and finding what is
// due. The decision itself is in policy.ts and stays pure.
//
// Everything here is idempotent on `(tenantId, settlementRef)`. That is not
// politeness — a `payment.failed` webhook is delivered more than once as a
// matter of course, and a provider running its own retry produces a second
// failure against the same settlement a day later. Both must land on the case
// that already exists. Opening a second ladder for one debt means the customer
// gets the first email twice and the cut-off twice as fast.

import { randomUUID } from 'node:crypto';
import { BillingError } from '../errors.ts';
import { Money } from '../money.ts';
import type { SqlExecutor, SubjectId, TenantId } from '../types.ts';
import { firstActionAt } from './policy.ts';
import type { DunningCase, DunningPolicy, DunningState } from './types.ts';

export interface DunningCaseRow {
  id: string;
  tenant_id: string;
  subject_id: string;
  settlement_ref: string;
  invoice_id: string | null;
  provider: string;
  state: DunningState;
  amount_minor: string;
  currency: string;
  attempts: number;
  last_reason: string;
  opened_at: Date;
  next_action_at: Date | null;
  closed_at: Date | null;
}

export function toDunningCase(row: DunningCaseRow): DunningCase {
  const currency = row.currency.trim();
  return {
    id: row.id,
    tenantId: row.tenant_id,
    subjectId: row.subject_id,
    settlementRef: row.settlement_ref,
    invoiceId: row.invoice_id,
    provider: row.provider,
    state: row.state,
    amount: Money.fromMinor(row.amount_minor, currency),
    attempts: Number(row.attempts),
    lastReason: row.last_reason,
    openedAt: row.opened_at,
    nextActionAt: row.next_action_at,
    closedAt: row.closed_at,
  };
}

/** Every column `toDunningCase` reads. One list, imported by the sweep. */
export const DUNNING_COLUMNS = `id, tenant_id, subject_id, settlement_ref, invoice_id, provider, state,
       amount_minor::text, currency, attempts, last_reason, opened_at, next_action_at, closed_at`;

const SELECT = `SELECT ${DUNNING_COLUMNS} FROM billing.dunning_cases`;

export interface OpenCaseInput {
  tenantId: TenantId;
  subjectId: SubjectId;
  /** The failed settlement. Half the natural key. */
  settlementRef: string;
  provider: string;
  amount: Money;
  /** The provider's words for the failure. Kept for the operator. */
  reason: string;
  /** The invoice, when we issued one. */
  invoiceId?: string;
}

export interface OpenedCase {
  case: DunningCase;
  /**
   * False when a case for this settlement already existed. Same contract as
   * ingest: replaying is a no-op that reports itself, not an error. A caller
   * that treats a repeat as failure will 500 on a webhook the provider is
   * merely redelivering, and the provider will disable the endpoint.
   */
  opened: boolean;
}

/**
 * Open a case for a failed settlement, or find the one already open for it.
 *
 * On a repeat the reason is refreshed and nothing else is: the ladder does not
 * restart, `attempts` does not reset, and `nextActionAt` stands. A provider's
 * own retry failing again is more information about the same debt, not a new
 * one, and treating it as new is how a customer on a genuinely dead card
 * receives the first notice every day forever.
 *
 * A repeat against a *closed* case updates nothing at all. A recovered debt
 * that fails again is a new settlement with a new ref; a written-off one is
 * finished. Reopening in place would lose the closure.
 */
export async function openCase(
  db: SqlExecutor,
  input: OpenCaseInput,
  policy: DunningPolicy,
  now: Date,
): Promise<OpenedCase> {
  const id = randomUUID();
  const nextActionAt = firstActionAt(policy, now);

  return db.transaction(async (tx) => {
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO billing.dunning_cases
         (id, tenant_id, subject_id, settlement_ref, invoice_id, provider, state,
          amount_minor, currency, attempts, last_reason, opened_at, next_action_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8, 0, $9, $10, $11)
       ON CONFLICT (tenant_id, settlement_ref) DO NOTHING
       RETURNING id`,
      [
        id,
        input.tenantId,
        input.subjectId,
        input.settlementRef,
        input.invoiceId ?? null,
        input.provider,
        input.amount.minor.toString(),
        input.amount.currency,
        input.reason,
        now,
        nextActionAt,
      ],
    );

    if (inserted.length > 0) {
      return { case: await load(tx, input.tenantId, input.settlementRef), opened: true };
    }

    // Refresh the reason on an open case, and leave a closed one untouched.
    await tx.query(
      `UPDATE billing.dunning_cases SET last_reason = $3, updated_at = $4
        WHERE tenant_id = $1 AND settlement_ref = $2 AND state = 'open'`,
      [input.tenantId, input.settlementRef, input.reason, now],
    );
    return { case: await load(tx, input.tenantId, input.settlementRef), opened: false };
  });
}

async function load(db: SqlExecutor, tenantId: TenantId, settlementRef: string): Promise<DunningCase> {
  const rows = await db.query<DunningCaseRow>(`${SELECT} WHERE tenant_id = $1 AND settlement_ref = $2`, [
    tenantId,
    settlementRef,
  ]);
  const row = rows[0];
  if (row === undefined) throw new BillingError({ code: 'not_found', what: 'dunning case', id: settlementRef });
  return toDunningCase(row);
}

export interface CaseRef {
  tenantId: TenantId;
  settlementRef: string;
}

/** The case for a settlement, or null. */
export async function getCase(db: SqlExecutor, ref: CaseRef): Promise<DunningCase | null> {
  const rows = await db.query<DunningCaseRow>(`${SELECT} WHERE tenant_id = $1 AND settlement_ref = $2`, [
    ref.tenantId,
    ref.settlementRef,
  ]);
  const row = rows[0];
  return row === undefined ? null : toDunningCase(row);
}

/**
 * Close an open case.
 *
 * `recovered` is the one a verified `payment.succeeded` drives, and wiring it
 * is not optional: a case left open after the money arrives keeps its
 * `nextActionAt`, and the next sweep suspends a customer who has paid. That is
 * the worst bug this module can have, and it is a missing call rather than a
 * wrong one, so it will not announce itself.
 *
 * `cancelled` is for a debt that stopped existing — the invoice was voided, the
 * subscription was refunded, an operator wrote it off by hand.
 *
 * Returns null when there was no open case, which is the ordinary answer for a
 * payment that never failed in the first place. Not an error: the caller is a
 * webhook handler that sees every success, not only the recoveries.
 */
export async function closeCase(
  db: SqlExecutor,
  ref: CaseRef,
  outcome: Exclude<DunningState, 'open'>,
  now: Date,
): Promise<DunningCase | null> {
  const rows = await db.query<DunningCaseRow>(
    `UPDATE billing.dunning_cases
        SET state = $3, closed_at = $4, next_action_at = NULL, updated_at = $4
      WHERE tenant_id = $1 AND settlement_ref = $2 AND state = 'open'
  RETURNING ${DUNNING_COLUMNS}`,
    [ref.tenantId, ref.settlementRef, outcome, now],
  );
  const row = rows[0];
  return row === undefined ? null : toDunningCase(row);
}

export interface DueCaseQuery {
  /** Everything due at or before this. Defaults to now. */
  now?: Date;
  /** Restrict to one tenant. Omit to sweep all. */
  tenantId?: TenantId;
  /** Cap the batch. Defaults to 200; a larger backlog drains over later sweeps. */
  limit?: number;
}

/**
 * Open cases whose next step has come due, oldest first so the longest overdue
 * is handled before a laggard pushes it past the batch limit.
 */
export async function dueCases(db: SqlExecutor, q: DueCaseQuery = {}): Promise<DunningCase[]> {
  const now = q.now ?? new Date();
  const limit = q.limit ?? 200;
  const rows = q.tenantId
    ? await db.query<DunningCaseRow>(
        `${SELECT} WHERE state = 'open' AND next_action_at IS NOT NULL AND next_action_at <= $1
           AND tenant_id = $2 ORDER BY next_action_at LIMIT $3`,
        [now, q.tenantId, limit],
      )
    : await db.query<DunningCaseRow>(
        `${SELECT} WHERE state = 'open' AND next_action_at IS NOT NULL AND next_action_at <= $1
         ORDER BY next_action_at LIMIT $2`,
        [now, limit],
      );
  return rows.map(toDunningCase);
}

export interface ListCasesQuery {
  tenantId: TenantId;
  subjectId?: SubjectId;
  state?: DunningState;
  limit?: number;
}

/** What is outstanding — the support screen's question. */
export async function listCases(db: SqlExecutor, q: ListCasesQuery): Promise<DunningCase[]> {
  const limit = Math.min(Math.max(1, q.limit ?? 100), 500);
  const where = ['tenant_id = $1'];
  const params: unknown[] = [q.tenantId];
  if (q.subjectId !== undefined) {
    params.push(q.subjectId);
    where.push(`subject_id = $${params.length}`);
  }
  if (q.state !== undefined) {
    params.push(q.state);
    where.push(`state = $${params.length}`);
  }
  params.push(limit);
  const rows = await db.query<DunningCaseRow>(
    `${SELECT} WHERE ${where.join(' AND ')} ORDER BY opened_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map(toDunningCase);
}
