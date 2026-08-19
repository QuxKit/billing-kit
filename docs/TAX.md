# Tax

billing-kit does not compute tax. It has a place for a computed tax to attach,
and this is that place.

## Why there is no engine in here

Rates move constantly. Thresholds move, nexus rules move, a temporary reduction
lands in one country and expires in another, and an e-invoicing mandate arrives
with nine months' notice and a schema. A library that shipped a rate table would
ship one that is wrong for every adopter who has not upgraded, and the upgrade
cadence a correct table needs is weekly.

There are companies whose entire business is keeping that table right — Avalara,
Stripe Tax, TaxJar, Anrok, Vertex — and competing with them is not a thing to do
by accident, on the side, inside a billing library.

So the split is:

| | Who |
|---|---|
| The shape of the question, and where the answer goes | billing-kit, free, Apache-2.0 |
| Rates, nexus, jurisdictions, filing | the calculator vendor |
| The adapter between the two | `@quxkit/billing-kit-adapters` |

## The contract

`billing-kit/tax` exports a `TaxCalculator` the host supplies:

```ts
interface TaxCalculator {
  readonly name: string;
  quote(request: TaxQuoteRequest): Promise<TaxQuote>;
  commit?(input: TaxCommitInput): Promise<void>;
  void?(input: { quoteRef: string; documentRef: string }): Promise<void>;
}
```

Only `quote` is required. `commit` and `void` exist for vendors that also file
returns, and are how a finalized document reaches them.

## The call order

This is the whole of the integration, and step 5 is the one that cannot be
reordered:

```ts
import { finalize, addLine, createInvoice } from '@quxkit/billing-kit/invoices';
import { taxIsOurs } from '@quxkit/billing-kit/providers';
import { taxLinesFrom, taxableLinesOf } from '@quxkit/billing-kit/tax';

const draft = await createInvoice(db, { tenantId, subjectId, currency, lines }, now);

if (taxIsOurs(provider.capabilities)) {
  const request = {
    tenantId, subjectId, currency,
    pricing: 'exclusive',
    seller:   { address: sellerAddress },
    customer: { address: customerAddress, registration: vatNumber },
    lines: taxableLinesOf(draft),
    taxedAt: issuedAt,
    idempotencyKey: `tax:${draft.id}`,
  } as const;

  const quote = await calculator.quote(request);
  await addLine(db, { tenantId, invoiceId: draft.id }, taxLinesFrom(request, quote), now);
}

const invoice = await finalize(db, { tenantId, invoiceId: draft.id }, now);
await calculator.commit?.({ quoteRef: quote.ref!, documentRef: invoice.number!, issuedAt });
```

**Quote before finalize.** The invoice number is gap-free and assigned exactly
once. A tax line added after finalize would mean voiding the document and
issuing a second number for the same sale — which is a credit note and a
re-issue, not an edit.

**Check `taxIsOurs` first.** Under a merchant of record — Paddle — the provider
is the legal seller. It computes and remits its own tax and issues its own
document. A second calculation against the same sale creates a liability you do
not owe, and a ledger that reconciles against a document you did not write.

## What the seam refuses

`assertQuoteCovers` runs on every quote, not only in an adapter's test suite,
because what it catches is a vendor's response shape changing under an
integration that passed its own tests yesterday. It rejects a tax amount in the
wrong currency, an amount against a line that was never sent, a negative amount
(a reversal is a credit note), and the same jurisdiction returned twice for one
line. Two *different* jurisdictions on one line are fine — that is what a US
sale is.

## Two decisions worth knowing about

**Discounts are in the taxable base.** `taxableLinesOf` sends every line
including the negative ones. Sending only the positive lines over-taxes every
invoice that carries a discount, and the invoice still adds up afterwards, so
nothing catches it.

**The quote is per line; the document is per rate.** A calculator returns one
amount per (line, jurisdiction) — that is what vendors return and what a filing
needs. `taxLinesFrom` then merges amounts sharing a jurisdiction, a rate and a
treatment into one invoice line, with the source line numbers in metadata,
because an invoice reading `VAT 20% (Pro) / VAT 20% (Seats) / VAT 20% (Overage)`
is not one anybody wants to receive. Different rates stay apart even within one
jurisdiction, and a reverse charge is never merged into a taxed line — the
zero-amount row exists to carry a sentence, and merging would delete it.

**Tax is outside the subtotal.** `Invoice.subtotal` is the taxable base;
`Invoice.total` is every line. A subtotal that contained tax would be a figure
nothing on the document adds up to, and would read as revenue against a number
that is a liability. `sql/033_tax_lines.sql` widens the line-kind constraint to
admit `tax`.

## Known gap: tax-inclusive pricing

`taxLinesFrom` refuses `pricing: 'inclusive'`.

Inclusive pricing is the norm for EU consumer sales: the €10 on the page is what
the customer pays, and VAT is extracted from it rather than added to it. That
extraction *reduces the revenue lines it came out of* — it is an operation on a
different part of the document, not an extra line — so it cannot share this code
path. Adding these lines on top of prices that already contained tax would
overcharge by exactly the tax, and the invoice would still add up.

Refusing is the honest answer until the reducing path is built.

## Where implementations go

`@quxkit/billing-kit-adapters`, beside the provider adapters and under the same
conformance suite. A fixed-rate calculator and an in-memory one belong there
too, for tests and for the single-jurisdiction seller who genuinely has one
rate.

## What a hosted add-on could add

Not rates — those come from the vendor either way. What a vendor's API does not
give you, and what a service could:

- **Nexus and threshold monitoring.** Knowing you crossed $100k of sales into
  Texas four months ago is not a rate lookup; it is a running total against a
  moving rule, and it is the failure that produces a back-assessment.
- **Registration and filing status.** Which jurisdictions you are registered in,
  which returns are due, which are late.
- **E-invoicing mandates.** Peppol, Italy's SdI, India's IRN, Germany's 2028
  mandate — each a connector with its own schema and its own clock.
- **Keeping the adapters current** when a vendor's API generation rolls.

Note what is *not* on that list: the rate table. If the pitch for a paid tax
add-on is "the rules keep changing", a customer will check, find that Avalara is
the one absorbing that change, and ask what they are paying us for. The four
items above are answers to that question.
