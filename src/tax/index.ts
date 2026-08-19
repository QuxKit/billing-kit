// billing-kit/tax — the seam a tax engine attaches to.
//
// A separate entry point, like invoices and entitlements, so an application
// selling through a merchant of record never compiles any of it.
//
// There is no calculator in here and there will not be one. billing-kit does
// not own a rate table, a nexus rule or a filing calendar; it owns the shape of
// the question, the validation of the answer, and the invoice line the answer
// becomes. Calculators live in `@quxkit/billing-kit-adapters`.
//
// The call order is the whole of the integration contract:
//
//   1. createInvoice(...)                       draft: no number, lines open
//   2. taxIsOurs(provider.capabilities)         false on Paddle: stop here
//   3. calculator.quote(request)                the vendor's number
//   4. addLine(taxLinesFrom(request, quote))    still a draft
//   5. finalize(...)                            number assigned, lines frozen
//   6. calculator.commit?({ documentRef: invoice.number, ... })
//
// Quoting after step 5 is the one ordering that cannot be recovered from. The
// number is gap-free and assigned once, so a late tax line means voiding the
// document and issuing a second one for the same sale.

export { assertQuoteCovers, taxableLinesOf, taxLinesFrom, taxTotal } from './quote.ts';
export type {
  TaxAddress,
  TaxAmount,
  TaxableLine,
  TaxCalculator,
  TaxCommitInput,
  TaxParty,
  TaxPricing,
  TaxQuote,
  TaxQuoteRequest,
  TaxRegistration,
} from './types.ts';
