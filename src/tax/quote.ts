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
 *   - a negative amount against a line that was not itself negative. A
 *     discount is a negative line and its tax is negative too — that is how
 *     netting works when the quote is per line — but a negative tax on a sale
 *     is a reversal, and a reversal is a credit note.
 *   - a jurisdiction whose amounts sum to less than zero. This is the invariant
 *     the per-line rule cannot express: individual lines net against each
 *     other, and what has to be non-negative is what reaches the invoice.
 */
export function assertQuoteCovers(request: TaxQuoteRequest, quote: TaxQuote): void {
  const refs = new Set(request.lines.map((line) => line.ref));
  const negativeLines = new Set(request.lines.filter((line) => line.amount.isNegative()).map((line) => line.ref));
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
    if (amount.amount.isNegative() && !negativeLines.has(amount.ref)) {
      throw new BillingError({
        code: 'invalid_tax',
        reason:
          `negative tax on line ${amount.ref} (${amount.jurisdiction}), which is not itself negative; ` +
          'a reversal is a credit note',
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

  for (const [jurisdiction, total] of totalsByJurisdiction(quote, request.currency)) {
    if (total.isNegative()) {
      throw new BillingError({
        code: 'invalid_tax',
        reason: `${jurisdiction} sums to ${total.toDecimalString()} across the invoice; tax owed cannot be negative`,
      });
    }
  }
}

function totalsByJurisdiction(quote: TaxQuote, currency: string): Map<string, Money> {
  const totals = new Map<string, Money>();
  for (const amount of quote.amounts) {
    const running = totals.get(amount.jurisdiction) ?? Money.zero(currency);
    totals.set(amount.jurisdiction, running.plus(amount.amount));
  }
  return totals;
}

/** Whether an amount has to appear on the document even though it is zero. */
const mustBeStated = (amount: TaxAmount): boolean => amount.reverseCharge === true || amount.exempt === true;

/**
 * The invoice lines a quote becomes. Add them to the draft, then finalize.
 *
 * The quote is per line, because that is what a calculator returns and what a
 * filing needs — which jurisdiction taxed which sale. The *document* is per
 * rate, because that is how an invoice reads. So amounts sharing a
 * jurisdiction, a rate and a treatment are merged into one line, and the source
 * line numbers travel in metadata.
 *
 * Not merging produces an invoice like this, which is the thing to avoid:
 *
 *   Subtotal          135.00
 *   VAT 20% (Pro)      20.00
 *   VAT 20% (Seats)     6.00
 *   VAT 20% (Overage)   1.00
 *
 * Different rates stay apart even in one jurisdiction — a reduced-rate line
 * beside a standard-rate one is two lines, because a customer checking the
 * arithmetic has to be able to. So is a reverse charge beside a taxed line: the
 * zero-amount row exists to carry a sentence, and merging it into a nonzero row
 * would delete the sentence.
 *
 * A zero amount is otherwise dropped. A reverse charge and an exemption are not
 * the absence of tax — they are statements the invoice is legally required to
 * make, and dropping them produces a document that is invalid in the
 * jurisdiction it was issued for.
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

  // Grouped before anything is dropped: a jurisdiction whose lines net to a
  // nonzero total must reach the document even if one of its lines was zero,
  // and one that nets to zero must not, however many nonzero lines it had.
  const groups = new Map<string, { amount: TaxAmount; total: Money; refs: string[] }>();
  for (const amount of quote.amounts) {
    const key = [
      amount.jurisdiction,
      amount.rate.toDecimalString(),
      amount.reverseCharge === true ? 'rc' : '',
      amount.exempt === true ? 'ex' : '',
    ].join('|');
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { amount, total: amount.amount, refs: [amount.ref] });
    else {
      group.total = group.total.plus(amount.amount);
      group.refs.push(amount.ref);
    }
  }

  return [...groups.values()]
    .filter(({ amount, total }) => !total.isZero() || mustBeStated(amount))
    .map(({ amount, total, refs }) => ({
      kind: 'tax' as const,
      description: amount.description,
      amount: total,
      metadata: {
        jurisdiction: amount.jurisdiction,
        rate: amount.rate.toDecimalString(),
        taxedLineNos: refs,
        ...(quote.ref === null ? {} : { quoteRef: quote.ref }),
        ...(amount.reverseCharge === true ? { reverseCharge: true } : {}),
        ...(amount.exempt === true ? { exempt: true } : {}),
      },
    }));
}
