// Persistence for invoices: create, add lines, and walk the state machine.
//
// Two invariants live in this file and nowhere else:
//
//   - the number is gap-free per (tenant, prefix, year). `finalize` locks the
//     counter row FOR UPDATE, reads it, increments it, and writes the number
//     onto the invoice, all in one transaction. Eight finalizes at once queue
//     on the row lock and come out 000001..000008 with no hole, and a finalize
//     that fails after taking the lock rolls the increment back with it.
//   - the state machine has one refusal, `invoice_state`, and every transition
//     is a guarded UPDATE (`WHERE state IN (...)`) so two concurrent callers
//     cannot both succeed: the second finds no row and reads the state it lost
//     to. There is no read-then-write anywhere in here.

import { randomUUID } from 'node:crypto';
import { BillingError } from '../errors.ts';
import { Money, Quantity } from '../money.ts';
import type { SqlExecutor, SubjectId, TenantId } from '../types.ts';
import type { Invoice, InvoiceLine, InvoiceLineKind, InvoiceState, NewInvoiceLine } from './types.ts';

interface InvoiceRow {
  id: string;
  tenant_id: string;
  subject_id: string;
  number: string | null;
  state: InvoiceState;
  currency: string;
  subtotal_minor: string;
  total_minor: string;
  subscription_period_id: string | null;
  period_start: Date | null;
  period_end: Date | null;
  provider: string | null;
  provider_ref: string | null;
  issued_at: Date | null;
  due_at: Date | null;
  paid_at: Date | null;
  voided_at: Date | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

interface LineRow {
  id: string;
  line_no: number;
  kind: InvoiceLineKind;
  description: string;
  metric: string | null;
  quantity: string | null;
  amount_minor: string;
  currency: string;
  metadata: Record<string, unknown> | null;
}

const INVOICE_COLUMNS = `id, tenant_id, subject_id, number, state, currency,
       subtotal_minor::text AS subtotal_minor, total_minor::text AS total_minor,
       subscription_period_id, period_start, period_end, provider, provider_ref,
       issued_at, due_at, paid_at, voided_at, metadata, created_at`;

const LINE_COLUMNS = `id, line_no, kind, description, metric, quantity::text AS quantity,
       amount_minor::text AS amount_minor, currency, metadata`;

function toLine(row: LineRow): InvoiceLine {
  return {
    id: row.id,
    lineNo: Number(row.line_no),
    kind: row.kind,
    description: row.description,
    metric: row.metric,
    quantity: row.quantity === null ? null : Quantity.fromDecimalString(row.quantity),
    amount: Money.fromMinor(row.amount_minor, row.currency.trim()),
    metadata: row.metadata,
  };
}

function toInvoice(row: InvoiceRow, lines: readonly InvoiceLine[]): Invoice {
  const currency = row.currency.trim();
  return {
    id: row.id,
    tenantId: row.tenant_id,
    subjectId: row.subject_id,
    number: row.number,
    state: row.state,
    currency,
    subtotal: Money.fromMinor(row.subtotal_minor, currency),
    total: Money.fromMinor(row.total_minor, currency),
    subscriptionPeriodId: row.subscription_period_id,
    period: row.period_start && row.period_end ? { start: row.period_start, end: row.period_end } : null,
    provider: row.provider,
    providerRef: row.provider_ref,
    issuedAt: row.issued_at,
    dueAt: row.due_at,
    paidAt: row.paid_at,
    voidedAt: row.voided_at,
    metadata: row.metadata,
    createdAt: row.created_at,
    lines,
  };
}

async function linesOf(db: SqlExecutor, invoiceId: string): Promise<InvoiceLine[]> {
  const rows = await db.query<LineRow>(
    `SELECT ${LINE_COLUMNS} FROM billing.invoice_lines WHERE invoice_id = $1 ORDER BY line_no`,
    [invoiceId],
  );
  return rows.map(toLine);
}

async function load(db: SqlExecutor, tenantId: TenantId, invoiceId: string): Promise<Invoice> {
  const rows = await db.query<InvoiceRow>(
    `SELECT ${INVOICE_COLUMNS} FROM billing.invoices WHERE tenant_id = $1 AND id = $2`,
    [tenantId, invoiceId],
  );
  const row = rows[0];
  if (row === undefined) throw new BillingError({ code: 'not_found', what: 'invoice', id: invoiceId });
  return toInvoice(row, await linesOf(db, row.id));
}

export interface InvoiceRef {
  tenantId: TenantId;
  invoiceId: string;
}

/** Read one invoice with its lines, or null. */
export async function getInvoice(db: SqlExecutor, ref: InvoiceRef): Promise<Invoice | null> {
  try {
    return await load(db, ref.tenantId, ref.invoiceId);
  } catch (error) {
    if (BillingError.hasCode(error, 'not_found')) return null;
    throw error;
  }
}

export interface ListInvoicesQuery {
  tenantId: TenantId;
  subjectId?: SubjectId;
  state?: InvoiceState;
  /** Default 100, max 1000. */
  limit?: number;
}

/** Invoices for a tenant (and optionally a subject / state), newest first. */
export async function listInvoices(db: SqlExecutor, q: ListInvoicesQuery): Promise<Invoice[]> {
  const limit = q.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new BillingError({ code: 'result_too_large', what: 'invoices', max: 1000, requested: limit });
  }
  const rows = await db.query<InvoiceRow>(
    `SELECT ${INVOICE_COLUMNS} FROM billing.invoices
      WHERE tenant_id = $1
        AND ($2::text IS NULL OR subject_id = $2)
        AND ($3::text IS NULL OR state = $3)
      ORDER BY created_at DESC, id DESC
      LIMIT $4`,
    [q.tenantId, q.subjectId ?? null, q.state ?? null, limit],
  );
  const out: Invoice[] = [];
  for (const row of rows) out.push(toInvoice(row, await linesOf(db, row.id)));
  return out;
}

export interface CreateInvoiceInput {
  tenantId: TenantId;
  subjectId: SubjectId;
  currency: string;
  lines?: readonly NewInvoiceLine[];
  /** The period this invoices, if any. One invoice per period per tenant. */
  subscriptionPeriodId?: string;
  period?: { start: Date; end: Date };
  dueAt?: Date;
  metadata?: Record<string, unknown>;
}

function assertLine(line: NewInvoiceLine, currency: string): void {
  if (line.amount.currency !== currency) {
    throw new BillingError({ code: 'currency_mismatch', left: currency, right: line.amount.currency });
  }
  if (!line.description) throw new BillingError({ code: 'invalid_invoice', reason: 'a line needs a description' });
  const negativeKind = line.kind === 'discount' || line.kind === 'credit';
  if (negativeKind && line.amount.isPositive()) {
    throw new BillingError({ code: 'invalid_invoice', reason: `a ${line.kind} line must be zero or negative` });
  }
  if (!negativeKind && line.amount.isNegative()) {
    throw new BillingError({ code: 'invalid_invoice', reason: `a ${line.kind} line must be zero or positive` });
  }
}

/**
 * Sum the lines: subtotal is the taxable base, total is everything.
 *
 * Three kinds are out of the subtotal and each for its own reason. `discount`
 * and `credit` are negative, so including them would make "the positive lines"
 * false. `tax` is positive and still excluded: a subtotal carrying it is a
 * number that appears nowhere on the document, and one that overstates the
 * revenue half of the invoice by exactly a liability.
 */
const OUTSIDE_SUBTOTAL: readonly InvoiceLineKind[] = ['discount', 'credit', 'tax'];

function totals(lines: readonly { amount: Money; kind: InvoiceLineKind }[], currency: string) {
  const zero = Money.zero(currency);
  let subtotal = zero;
  let total = zero;
  for (const l of lines) {
    total = total.plus(l.amount);
    if (!OUTSIDE_SUBTOTAL.includes(l.kind)) subtotal = subtotal.plus(l.amount);
  }
  return { subtotal, total };
}

async function insertLines(
  tx: SqlExecutor,
  invoiceId: string,
  tenantId: TenantId,
  from: number,
  lines: readonly NewInvoiceLine[],
): Promise<void> {
  if (lines.length === 0) return;
  await tx.query(
    `INSERT INTO billing.invoice_lines
       (id, invoice_id, tenant_id, line_no, kind, description, metric, quantity, amount_minor, currency, metadata)
     SELECT * FROM unnest(
       $1::uuid[], $2::uuid[], $3::text[], $4::int[], $5::text[], $6::text[], $7::text[],
       $8::numeric[], $9::bigint[], $10::char(3)[], $11::jsonb[]
     )`,
    [
      lines.map(() => randomUUID()),
      lines.map(() => invoiceId),
      lines.map(() => tenantId),
      lines.map((_l, i) => from + i),
      lines.map((l) => l.kind),
      lines.map((l) => l.description),
      lines.map((l) => l.metric ?? null),
      lines.map((l) => l.quantity?.toDecimalString() ?? null),
      lines.map((l) => l.amount.minor.toString()),
      lines.map((l) => l.amount.currency),
      lines.map((l) => (l.metadata === undefined ? null : JSON.stringify(l.metadata))),
    ],
  );
}

async function storeTotals(tx: SqlExecutor, tenantId: TenantId, invoiceId: string, currency: string, now: Date) {
  const lines = await linesOf(tx, invoiceId);
  const t = totals(lines, currency);
  await tx.query(
    `UPDATE billing.invoices SET subtotal_minor = $3, total_minor = $4, updated_at = $5
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, invoiceId, t.subtotal.minor.toString(), t.total.minor.toString(), now],
  );
}

/**
 * Create a draft invoice, optionally with its first lines.
 *
 * A draft: no number, lines may still be added, and it can be voided without
 * ever having been issued. Refuses a second invoice for the same subscription
 * period (UNIQUE) with `invalid_invoice` — `invoiceForPeriod` is the
 * idempotent entry point for periods; this is the raw one.
 */
export async function createInvoice(db: SqlExecutor, input: CreateInvoiceInput, now: Date): Promise<Invoice> {
  const currency = input.currency;
  Money.zero(currency); // throws unknown_currency
  const lines = input.lines ?? [];
  for (const line of lines) assertLine(line, currency);
  const t = totals(lines, currency);
  const id = randomUUID();

  return db.transaction(async (tx) => {
    const rows = await tx.query<{ id: string }>(
      `INSERT INTO billing.invoices
         (id, tenant_id, subject_id, state, currency, subtotal_minor, total_minor,
          subscription_period_id, period_start, period_end, due_at, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, 'draft', $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $12)
       ON CONFLICT (tenant_id, subscription_period_id) DO NOTHING
       RETURNING id`,
      [
        id,
        input.tenantId,
        input.subjectId,
        currency,
        t.subtotal.minor.toString(),
        t.total.minor.toString(),
        input.subscriptionPeriodId ?? null,
        input.period?.start ?? null,
        input.period?.end ?? null,
        input.dueAt ?? null,
        input.metadata === undefined ? null : JSON.stringify(input.metadata),
        now,
      ],
    );
    if (rows.length === 0) {
      throw new BillingError({
        code: 'invalid_invoice',
        reason: `subscription period ${input.subscriptionPeriodId} already has an invoice`,
      });
    }
    await insertLines(tx, id, input.tenantId, 1, lines);
    return load(tx, input.tenantId, id);
  });
}

/**
 * Add lines to a draft. Refused once the invoice is open: the number has been
 * assigned and the document is what it says.
 */
export async function addLine(
  db: SqlExecutor,
  ref: InvoiceRef,
  lines: NewInvoiceLine | readonly NewInvoiceLine[],
  now: Date,
): Promise<Invoice> {
  const list = Array.isArray(lines) ? (lines as readonly NewInvoiceLine[]) : [lines as NewInvoiceLine];
  return db.transaction(async (tx) => {
    const locked = await tx.query<{ state: InvoiceState; currency: string; max_no: string | null }>(
      `SELECT i.state, i.currency,
              (SELECT MAX(line_no)::text FROM billing.invoice_lines l WHERE l.invoice_id = i.id) AS max_no
         FROM billing.invoices i WHERE i.tenant_id = $1 AND i.id = $2 FOR UPDATE`,
      [ref.tenantId, ref.invoiceId],
    );
    const row = locked[0];
    if (row === undefined) throw new BillingError({ code: 'not_found', what: 'invoice', id: ref.invoiceId });
    if (row.state !== 'draft') {
      throw new BillingError({
        code: 'invoice_state',
        invoiceId: ref.invoiceId,
        state: row.state,
        operation: 'addLine',
        wanted: ['draft'],
      });
    }
    const currency = row.currency.trim();
    for (const line of list) assertLine(line, currency);
    await insertLines(tx, ref.invoiceId, ref.tenantId, Number(row.max_no ?? 0) + 1, list);
    await storeTotals(tx, ref.tenantId, ref.invoiceId, currency, now);
    return load(tx, ref.tenantId, ref.invoiceId);
  });
}

export interface FinalizeInput extends InvoiceRef {
  /** Number prefix, e.g. `INV` → `INV-2026-000001`. Default `INV`. Letters,
   *  digits and hyphens only. */
  prefix?: string;
  /** Issue date; the number's year comes from it (UTC). Defaults to now. */
  issuedAt?: Date;
  dueAt?: Date;
}

const PREFIX = /^[A-Za-z0-9-]{1,16}$/;

/**
 * Take the next number for (tenant, prefix, year), gap-free.
 *
 * Insert-if-absent, then lock and increment. The lock is what serialises
 * concurrent finalizes; the transaction is what makes a failed one leave no
 * hole. Exported for tests only.
 */
export async function nextInvoiceNumber(
  tx: SqlExecutor,
  input: { tenantId: TenantId; prefix: string; year: number },
): Promise<string> {
  await tx.query(
    `INSERT INTO billing.invoice_counters (tenant_id, prefix, year) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [input.tenantId, input.prefix, input.year],
  );
  const rows = await tx.query<{ next_seq: string }>(
    `SELECT next_seq::text FROM billing.invoice_counters
      WHERE tenant_id = $1 AND prefix = $2 AND year = $3 FOR UPDATE`,
    [input.tenantId, input.prefix, input.year],
  );
  const seq = BigInt(rows[0]?.next_seq ?? '1');
  await tx.query(
    `UPDATE billing.invoice_counters SET next_seq = $4
      WHERE tenant_id = $1 AND prefix = $2 AND year = $3`,
    [input.tenantId, input.prefix, input.year, (seq + 1n).toString()],
  );
  return `${input.prefix}-${input.year}-${seq.toString().padStart(6, '0')}`;
}

/**
 * draft → open. Assigns the number, freezes the lines, stamps `issuedAt`.
 *
 * Idempotent in the only way that is safe: a second finalize of an already-open
 * invoice is refused with `invoice_state`, not answered with the same number —
 * the caller that retried has to read the invoice back and see it is open,
 * because a finalize that silently succeeds twice is one that could have taken
 * two numbers.
 */
export async function finalize(db: SqlExecutor, input: FinalizeInput, now: Date): Promise<Invoice> {
  const prefix = input.prefix ?? 'INV';
  if (!PREFIX.test(prefix)) {
    throw new BillingError({ code: 'invalid_invoice', reason: 'prefix must be 1-16 letters, digits or hyphens' });
  }
  const issuedAt = input.issuedAt ?? now;
  const year = issuedAt.getUTCFullYear();

  return db.transaction(async (tx) => {
    // Lock the invoice first, then the counter: every finalize takes the two
    // locks in the same order, so two of them cannot deadlock.
    const rows = await tx.query<{ state: InvoiceState }>(
      `SELECT state FROM billing.invoices WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [input.tenantId, input.invoiceId],
    );
    const row = rows[0];
    if (row === undefined) throw new BillingError({ code: 'not_found', what: 'invoice', id: input.invoiceId });
    if (row.state !== 'draft') {
      throw new BillingError({
        code: 'invoice_state',
        invoiceId: input.invoiceId,
        state: row.state,
        operation: 'finalize',
        wanted: ['draft'],
      });
    }
    const number = await nextInvoiceNumber(tx, { tenantId: input.tenantId, prefix, year });
    await tx.query(
      `UPDATE billing.invoices
          SET state = 'open', number = $3, issued_at = $4, due_at = COALESCE($5, due_at), updated_at = $6
        WHERE tenant_id = $1 AND id = $2 AND state = 'draft'`,
      [input.tenantId, input.invoiceId, number, issuedAt, input.dueAt ?? null, now],
    );
    return load(tx, input.tenantId, input.invoiceId);
  });
}

async function transition(
  db: SqlExecutor,
  ref: InvoiceRef,
  operation: string,
  from: readonly InvoiceState[],
  to: InvoiceState,
  set: string,
  params: readonly unknown[],
): Promise<Invoice> {
  return db.transaction(async (tx) => {
    const updated = await tx.query<{ id: string }>(
      `UPDATE billing.invoices SET state = $3, ${set}
        WHERE tenant_id = $1 AND id = $2 AND state = ANY($4::text[])
    RETURNING id`,
      [ref.tenantId, ref.invoiceId, to, from, ...params],
    );
    if (updated.length === 0) {
      const current = await tx.query<{ state: InvoiceState }>(
        `SELECT state FROM billing.invoices WHERE tenant_id = $1 AND id = $2`,
        [ref.tenantId, ref.invoiceId],
      );
      const row = current[0];
      if (row === undefined) throw new BillingError({ code: 'not_found', what: 'invoice', id: ref.invoiceId });
      throw new BillingError({
        code: 'invoice_state',
        invoiceId: ref.invoiceId,
        state: row.state,
        operation,
        wanted: from,
      });
    }
    return load(tx, ref.tenantId, ref.invoiceId);
  });
}

/** open → paid. `paidAt` is the provider's time when a webhook drives this. */
export function markPaid(db: SqlExecutor, ref: InvoiceRef & { paidAt?: Date }, now: Date): Promise<Invoice> {
  return transition(db, ref, 'markPaid', ['open'], 'paid', 'paid_at = $5, updated_at = $6', [ref.paidAt ?? now, now]);
}

/** draft | open → void. A voided draft keeps no number; a voided open one keeps
 *  its number, so the sequence stays gap-free and the void is visible. */
export function voidInvoice(db: SqlExecutor, ref: InvoiceRef, now: Date): Promise<Invoice> {
  return transition(db, ref, 'void', ['draft', 'open'], 'void', 'voided_at = $5, updated_at = $5', [now]);
}

/** open → uncollectible. Written off; the number and the lines stay. */
export function markUncollectible(db: SqlExecutor, ref: InvoiceRef, now: Date): Promise<Invoice> {
  return transition(db, ref, 'markUncollectible', ['open'], 'uncollectible', 'updated_at = $5', [now]);
}

/**
 * Record which provider settlement this invoice was sent to. Open invoices
 * only. This is the seam `applyVerifiedEvent` uses to find the invoice a
 * `payment.succeeded` pays: `(provider, providerRef)` is unique across tenants.
 */
export async function attachSettlement(
  db: SqlExecutor,
  input: InvoiceRef & { provider: string; providerRef: string },
  now: Date,
): Promise<Invoice> {
  return db.transaction(async (tx) => {
    const updated = await tx.query<{ id: string }>(
      `UPDATE billing.invoices SET provider = $3, provider_ref = $4, updated_at = $5
        WHERE tenant_id = $1 AND id = $2 AND state = 'open'
          AND (provider IS NULL OR (provider = $3 AND provider_ref = $4))
    RETURNING id`,
      [input.tenantId, input.invoiceId, input.provider, input.providerRef, now],
    );
    if (updated.length === 0) {
      const current = await tx.query<{ state: InvoiceState; provider: string | null; provider_ref: string | null }>(
        `SELECT state, provider, provider_ref FROM billing.invoices WHERE tenant_id = $1 AND id = $2`,
        [input.tenantId, input.invoiceId],
      );
      const row = current[0];
      if (row === undefined) throw new BillingError({ code: 'not_found', what: 'invoice', id: input.invoiceId });
      if (row.state !== 'open') {
        throw new BillingError({
          code: 'invoice_state',
          invoiceId: input.invoiceId,
          state: row.state,
          operation: 'attachSettlement',
          wanted: ['open'],
        });
      }
      throw new BillingError({
        code: 'invalid_invoice',
        reason: `invoice is already attached to ${row.provider}:${row.provider_ref}`,
      });
    }
    return load(tx, input.tenantId, input.invoiceId);
  });
}

/**
 * The invoice a provider settlement ref belongs to, if any. Used by
 * `applyVerifiedEvent` both to resolve the subject and to mark it paid.
 * Tolerates the invoices table not existing (sql/031 not applied): returns null.
 */
export async function invoiceBySettlement(
  db: SqlExecutor,
  input: { provider: string; providerRef: string },
): Promise<{ invoiceId: string; tenantId: TenantId; subjectId: SubjectId; state: InvoiceState } | null> {
  const present = await db.query<{ ok: boolean }>(`SELECT to_regclass('billing.invoices') IS NOT NULL AS ok`);
  if (!present[0]?.ok) return null;
  const rows = await db.query<{ id: string; tenant_id: string; subject_id: string; state: InvoiceState }>(
    `SELECT id, tenant_id, subject_id, state FROM billing.invoices WHERE provider = $1 AND provider_ref = $2`,
    [input.provider, input.providerRef],
  );
  const row = rows[0];
  return row === undefined
    ? null
    : { invoiceId: row.id, tenantId: row.tenant_id, subjectId: row.subject_id, state: row.state };
}

/**
 * open → paid for the invoice attached to a settlement, or nothing. Guarded
 * on state so a replayed or late webhook cannot flip a voided invoice to paid.
 * Returns the invoice id it marked, or null.
 */
export async function markPaidBySettlement(
  db: SqlExecutor,
  input: { provider: string; providerRef: string; paidAt: Date },
  now: Date,
): Promise<string | null> {
  const found = await invoiceBySettlement(db, input);
  if (found === null) return null;
  const rows = await db.query<{ id: string }>(
    `UPDATE billing.invoices SET state = 'paid', paid_at = $3, updated_at = $4
      WHERE provider = $1 AND provider_ref = $2 AND state = 'open'
  RETURNING id`,
    [input.provider, input.providerRef, input.paidAt, now],
  );
  return rows[0]?.id ?? null;
}
