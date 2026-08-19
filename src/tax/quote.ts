// Turning a draft into a question, and an answer into lines.
//
// Pure. Every function here is a value in, a value out, and none of them touch
// the database or the network — the same split `tenant-kit` draws between
// extraction and authorization, and for the same reason: the interesting
// mistakes are in the mapping, and a mapping that needs a Postgres instance to
// test is a mapping nobody tests exhaustively.
//
// The arithmetic that is deliberately absent: nothing here multiplies an amount
// by a rate. `Money.sum` over what the calculator returned is the only addition
// in the file.

import { BillingError } from '../errors.ts';
import type { Invoice, NewInvoiceLine } from '../invoices/types.ts';
import { Money } from '../money.ts';
import type { TaxAmount, TaxableLine, TaxQuote, TaxQuoteRequest } from './types.ts';

/**
 * The lines of a draft, as the calculator should see them.
 *
 * Existing `tax` lines are dropped: re-quoting an invoice that already carries
 * tax must not tax the tax, and a re-quote is the ordinary path when an address
 * is corrected before finalize.
 *
 * Everything else goes, sign included. A discount is negative and belongs in
 * the base; sending only the positive lines is the commonest way to
 * over-collect, and it is invisible because the invoice still adds up.
 */
export function taxableLinesOf(invoice: Invoice): TaxableLine[] {
  return invoice.lines
    .filter((line) => line.kind !== 'tax')
    .map((line) => ({
      ref: String(line.lineNo),
      description: line.description,
      amount: line.amount,
    }));
}

/** Sum of the `tax` lines already on an invoice. Zero when there are none. */
export function taxTotal(invoice: Invoice): Money {
  return Money.sum(
    invoice.lines.filter((line) => line.kind === 'tax').map((line) => line.amount),
    invoice.currency,
  );
}

/**
 * Check an answer against its question before any of it reaches an invoice.
 *
 * This is the conformance boundary for a calculator adapter, and it runs on
 * every quote rather than only in the adapter's test suite — the failure it
 * catches is a vendor response shape changing under a live integration, which
 * no amount of adapter testing sees.
 *
 * What it refuses:
 *
 *   - an amount in a currency the invoice is not in. Silently converting is how
 *     a EUR tax line lands on a USD invoice and the total stops balancing.
 *   - an amount naming a line that was not sent. It taxes something we did not
 *     ask about, so we cannot say what.
 *   - two amounts for the same line from the same jurisdiction, which is a
 *     duplicated response rather than a genuine second one. A US sale really is
 *     taxed by a state and a county at once, and those differ in
 *     `jurisdiction`.
 *   - a negative tax amount. A reversal is a credit note, not a negative tax.
 */
export function assertQuoteCovers(request: TaxQuoteRequest, quote: TaxQuote): void {
  const refs = new Set(request.lines.map((line) => line.ref));
  const seen = new Set<string>();
  for (const amount of quote.amounts) {
    if (amount.amount.currency !== request.currency) {
      throw new BillingError({
        code: 'invalid_tax',
        reason:
          `calculator returned ${amount.amount.currency} for a ${request.currency} invoice ` +
          `(line ${amount.ref}, ${amount.jurisdiction})`,
      });
    }
    if (!refs.has(amount.ref)) {
      throw new BillingError({
        code: 'invalid_tax',
        reason: `calculator taxed line ${amount.ref}, which was not in the request`,
      });
    }
    if (amount.amount.isNegative()) {
      throw new BillingError({
        code: 'invalid_tax',
        reason: `negative tax on line ${amount.ref} (${amount.jurisdiction}); a reversal is a credit note`,
      });
    }
    const key = `${amount.ref} ${amount.jurisdiction}`;
    if (seen.has(key)) {
      throw new BillingError({
        code: 'invalid_tax',
        reason: `calculator returned ${amount.jurisdiction} twice for line ${amount.ref}`,
      });
    }
    seen.add(key);
  }
}

/** Whether an amount has to appear on the document even though it is zero. */
const mustBeStated = (amount: TaxAmount): boolean => amount.reverseCharge === true || amount.exempt === true;

/**
 * The invoice lines a quote becomes. Add them to the draft, then finalize.
 *
 * One line per returned amount rather than one merged line per invoice, because
 * a US sale is taxed by a state and a county at once and a merged line cannot
 * be filed against either. `metadata` carries the machine-readable
 * jurisdiction, rate and source line; `description` carries what a human reads.
 *
 * A zero amount is dropped unless it is a reverse charge or an exemption. Those
 * two are not the absence of tax — they are a statement the invoice is legally
 * required to make, and dropping them produces a document that is invalid in
 * the jurisdiction it was issued for.
 *
 * Refuses `pricing: 'inclusive'`. Extracting tax from a tax-inclusive price
 * reduces the revenue lines it came out of, which is a different operation on a
 * different part of the document; adding these lines on top of prices that
 * already contained tax overcharges by exactly the tax. Refusing is the honest
 * answer until that path is built — see docs/TAX.md.
 */
export function taxLinesFrom(request: TaxQuoteRequest, quote: TaxQuote): NewInvoiceLine[] {
  if (request.pricing === 'inclusive') {
    throw new BillingError({
      code: 'invalid_tax',
      reason: 'tax-inclusive pricing is not supported yet: the base lines would have to be reduced, not added to',
    });
  }
  assertQuoteCovers(request, quote);

  const lines: NewInvoiceLine[] = [];
  for (const amount of quote.amounts) {
    if (amount.amount.isZero() && !mustBeStated(amount)) continue;
    lines.push({
      kind: 'tax',
      description: amount.description,
      amount: amount.amount,
      metadata: {
        jurisdiction: amount.jurisdiction,
        rate: amount.rate.toDecimalString(),
        taxedLineNo: amount.ref,
        ...(quote.ref === null ? {} : { quoteRef: quote.ref }),
        ...(amount.reverseCharge === true ? { reverseCharge: true } : {}),
        ...(amount.exempt === true ? { exempt: true } : {}),
      },
    });
  }
  return lines;
}
