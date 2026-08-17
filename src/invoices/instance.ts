// The invoices surface, bound to one executor and clock. Same argument as
// src/instance.ts: the free functions take (db, ..., now) and are the API;
// this repeats the wiring once.

import type { Clock, SqlExecutor } from '../types.ts';
import type { InvoiceForPeriodInput } from './period.ts';
import { invoiceForPeriod } from './period.ts';
import type { CreateInvoiceInput, FinalizeInput, InvoiceRef, ListInvoicesQuery } from './store.ts';
import {
  addLine,
  attachSettlement,
  createInvoice,
  finalize,
  getInvoice,
  listInvoices,
  markPaid,
  markUncollectible,
  voidInvoice,
} from './store.ts';
import type { Invoice, NewInvoiceLine } from './types.ts';

export interface InvoicesOptions {
  db: SqlExecutor;
  clock?: Clock;
}

export interface Invoices {
  create(input: CreateInvoiceInput): Promise<Invoice>;
  get(ref: InvoiceRef): Promise<Invoice | null>;
  list(q: ListInvoicesQuery): Promise<Invoice[]>;
  forPeriod(input: InvoiceForPeriodInput): Promise<Invoice>;
  addLine(ref: InvoiceRef, lines: NewInvoiceLine | readonly NewInvoiceLine[]): Promise<Invoice>;
  finalize(input: FinalizeInput): Promise<Invoice>;
  markPaid(ref: InvoiceRef & { paidAt?: Date }): Promise<Invoice>;
  void(ref: InvoiceRef): Promise<Invoice>;
  markUncollectible(ref: InvoiceRef): Promise<Invoice>;
  attachSettlement(input: InvoiceRef & { provider: string; providerRef: string }): Promise<Invoice>;
}

export function createInvoices(opts: InvoicesOptions): Invoices {
  const { db } = opts;
  const clock: Clock = opts.clock ?? (() => new Date());
  return {
    create: (input) => createInvoice(db, input, clock()),
    get: (ref) => getInvoice(db, ref),
    list: (q) => listInvoices(db, q),
    forPeriod: (input) => invoiceForPeriod(db, input, clock()),
    addLine: (ref, lines) => addLine(db, ref, lines, clock()),
    finalize: (input) => finalize(db, input, clock()),
    markPaid: (ref) => markPaid(db, ref, clock()),
    void: (ref) => voidInvoice(db, ref, clock()),
    markUncollectible: (ref) => markUncollectible(db, ref, clock()),
    attachSettlement: (input) => attachSettlement(db, input, clock()),
  };
}
