// From a charged subscription period to an invoice.
//
// `chargeSubscriptionPeriod` persists the charge breakdown it computed —
// `subscription_periods.charge_lines`, added by sql/031 — and this reads it
// back into invoice lines. It does not recompute anything: the plan object may
// have been edited since, the usage may have been re-aggregated, and the
// invoice has to say what was actually billed, which is what the ledger
// accrual says too. Building from a fresh computation would be the second
// source of truth this library keeps refusing to have.

import { BillingError } from '../errors.ts';
import { Money, Quantity } from '../money.ts';
import type { SqlExecutor, TenantId } from '../types.ts';
import { createInvoice, getInvoice } from './store.ts';
import type { Invoice, InvoiceLineKind, NewInvoiceLine } from './types.ts';

/** The persisted shape of one ChargeLine (see subscriptions/settle.ts). */
export interface StoredChargeLine {
  kind: 'flat' | 'seats' | 'usage' | 'discount';
  description: string;
  amount: { amount: string; currency: string };
  metric?: string;
  quantity?: string;
  residueMinor?: string;
}

const KIND: Record<StoredChargeLine['kind'], InvoiceLineKind> = {
  flat: 'base',
  seats: 'seats',
  usage: 'overage',
  discount: 'discount',
};

/** ChargeLine JSON → invoice lines. Exported so a host that stores charge
 *  breakdowns elsewhere can reuse the mapping. */
export function linesFromCharge(stored: readonly StoredChargeLine[]): NewInvoiceLine[] {
  return stored.map((l) => ({
    kind: KIND[l.kind],
    description: l.description,
    amount: Money.fromMinor(l.amount.amount, l.amount.currency),
    metric: l.metric,
    quantity: l.quantity === undefined ? undefined : Quantity.fromDecimalString(l.quantity),
    metadata: l.residueMinor === undefined ? undefined : { residueMinor: l.residueMinor },
  }));
}

export interface InvoiceForPeriodInput {
  tenantId: TenantId;
  subscriptionPeriodId: string;
  /**
   * Prepaid credit applied to this invoice, as a positive amount; becomes a
   * negative `credit` line. The caller redeems it (`walletRedeemPosting`) — the
   * invoice records that it was applied, it does not move it.
   */
  credit?: Money;
  dueAt?: Date;
  metadata?: Record<string, unknown>;
}

interface PeriodRow {
  id: string;
  tenant_id: string;
  subject_id: string;
  period_start: Date;
  period_end: Date;
  currency: string;
  charge_id: string;
  charge_lines: StoredChargeLine[] | null;
  invoice_id: string | null;
}

/**
 * The invoice for a charged period: the one that exists, or a new draft built
 * from the period's charge breakdown.
 *
 * Idempotent on the period. Two callers racing produce one invoice: the second
 * insert hits UNIQUE (tenant_id, subscription_period_id) and the existing one
 * is returned. Refuses a period charged before sql/031 (no breakdown stored)
 * with `invalid_invoice` rather than inventing lines from the total.
 */
export async function invoiceForPeriod(db: SqlExecutor, input: InvoiceForPeriodInput, now: Date): Promise<Invoice> {
  const rows = await db.query<PeriodRow>(
    `SELECT p.id, p.tenant_id, p.subject_id, p.period_start, p.period_end, p.currency, p.charge_id,
            p.charge_lines, i.id AS invoice_id
       FROM billing.subscription_periods p
       LEFT JOIN billing.invoices i ON i.tenant_id = p.tenant_id AND i.subscription_period_id = p.id
      WHERE p.tenant_id = $1 AND p.id = $2`,
    [input.tenantId, input.subscriptionPeriodId],
  );
  const period = rows[0];
  if (period === undefined) {
    throw new BillingError({ code: 'not_found', what: 'subscription_period', id: input.subscriptionPeriodId });
  }
  if (period.invoice_id !== null) {
    const existing = await getInvoice(db, { tenantId: input.tenantId, invoiceId: period.invoice_id });
    if (existing) return existing;
  }
  if (period.charge_lines === null) {
    throw new BillingError({
      code: 'invalid_invoice',
      reason: `period ${period.id} has no charge breakdown (charged before sql/031_invoices.sql was applied)`,
    });
  }

  const currency = period.currency.trim();
  const lines = linesFromCharge(period.charge_lines);
  if (input.credit) {
    if (input.credit.currency !== currency) {
      throw new BillingError({ code: 'currency_mismatch', left: currency, right: input.credit.currency });
    }
    if (input.credit.isNegative()) {
      throw new BillingError({ code: 'invalid_invoice', reason: 'credit must be a positive amount' });
    }
    if (input.credit.isPositive()) {
      lines.push({ kind: 'credit', description: 'credit applied', amount: input.credit.negate() });
    }
  }

  try {
    return await createInvoice(
      db,
      {
        tenantId: period.tenant_id,
        subjectId: period.subject_id,
        currency,
        lines,
        subscriptionPeriodId: period.id,
        period: { start: period.period_start, end: period.period_end },
        dueAt: input.dueAt,
        metadata: { chargeId: period.charge_id, ...(input.metadata ?? {}) },
      },
      now,
    );
  } catch (error) {
    // Lost the race to another caller: return theirs.
    if (BillingError.hasCode(error, 'invalid_invoice')) {
      const again = await db.query<{ id: string }>(
        `SELECT id FROM billing.invoices WHERE tenant_id = $1 AND subscription_period_id = $2`,
        [input.tenantId, period.id],
      );
      const id = again[0]?.id;
      if (id !== undefined) {
        const found = await getInvoice(db, { tenantId: input.tenantId, invoiceId: id });
        if (found) return found;
      }
    }
    throw error;
  }
}
