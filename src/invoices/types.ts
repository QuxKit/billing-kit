// Invoices: the document a charged period becomes.
//
// Everything here is a type. The store (`store.ts`) writes them; `period.ts`
// builds one from a charged subscription period; `render.ts` turns one into
// JSON or HTML. None of it captures money — an invoice is a statement of what
// is owed and, later, of the fact that it was paid; the payment itself still
// arrives only as a verified webhook.

import type { Money, Quantity } from '../money.ts';
import type { SubjectId, TenantId } from '../types.ts';

/**
 * The state machine.
 *
 *   draft ──finalize──▶ open ──markPaid──▶ paid
 *     │                  │
 *     │                  ├──void──▶ void
 *     └──void──▶ void    └──markUncollectible──▶ uncollectible
 *
 * A draft has no number and its lines can change. Finalizing assigns the
 * gap-free number and freezes the lines. `paid`, `void` and `uncollectible`
 * are terminal.
 */
export type InvoiceState = 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';

export type InvoiceLineKind = 'base' | 'seats' | 'overage' | 'discount' | 'credit' | 'custom';

export interface InvoiceLine {
  id: string;
  lineNo: number;
  kind: InvoiceLineKind;
  description: string;
  /** Present on overage lines. */
  metric: string | null;
  quantity: Quantity | null;
  /** Signed: discounts and credits are negative. Lines sum to the total. */
  amount: Money;
  metadata: Record<string, unknown> | null;
}

export interface Invoice {
  id: string;
  tenantId: TenantId;
  subjectId: SubjectId;
  /** `{prefix}-{YYYY}-{seq:06}`. Null while draft. */
  number: string | null;
  state: InvoiceState;
  currency: string;
  /** Sum of the positive lines (base, seats, overage, custom). */
  subtotal: Money;
  /** Sum of every line. What is owed. */
  total: Money;
  subscriptionPeriodId: string | null;
  period: { start: Date; end: Date } | null;
  /** The provider settlement this invoice was sent to, once it was. */
  provider: string | null;
  providerRef: string | null;
  issuedAt: Date | null;
  dueAt: Date | null;
  paidAt: Date | null;
  voidedAt: Date | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  lines: readonly InvoiceLine[];
}

export interface NewInvoiceLine {
  kind: InvoiceLineKind;
  description: string;
  amount: Money;
  metric?: string;
  quantity?: Quantity;
  metadata?: Record<string, unknown>;
}
