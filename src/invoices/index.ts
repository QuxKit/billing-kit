// billing-kit/invoices — the document a charged period becomes.
//
// A separate entry point, like the other three, so an application that never
// issues a document of its own (a merchant-of-record provider issues theirs)
// does not compile the numbering and rendering. Needs sql/031_invoices.sql.
//
// What this does NOT do: capture money, or credit a balance. An invoice moves
// to `paid` from `applyVerifiedEvent` (a verified payment webhook whose
// settlement ref is attached to the invoice) or from an explicit `markPaid` the
// host chose to call. There is no PDF renderer; `renderInvoice` gives JSON or a
// print-styled HTML document.

export type { Invoices, InvoicesOptions } from './instance.ts';
export { createInvoices } from './instance.ts';
export type { InvoiceForPeriodInput, StoredChargeLine } from './period.ts';
export { invoiceForPeriod, linesFromCharge } from './period.ts';
export type { InvoiceJSON, RenderOptions } from './render.ts';
export { invoiceToHTML, invoiceToJSON, renderInvoice } from './render.ts';
export type { CreateInvoiceInput, FinalizeInput, InvoiceRef, ListInvoicesQuery } from './store.ts';
export {
  addLine,
  attachSettlement,
  createInvoice,
  finalize,
  getInvoice,
  invoiceBySettlement,
  listInvoices,
  markPaid,
  markUncollectible,
  nextInvoiceNumber,
  voidInvoice,
} from './store.ts';
export type { Invoice, InvoiceLine, InvoiceLineKind, InvoiceState, NewInvoiceLine } from './types.ts';
