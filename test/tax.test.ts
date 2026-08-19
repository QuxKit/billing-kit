// The tax seam, which is pure and therefore fully testable without a database.
//
// The cases that matter are the ones where a wrong answer still looks like a
// right one: a discount left out of the taxable base, a zero-rate line dropped
// when it was the legally required statement, tax folded into the subtotal.
// None of those throw at runtime and all of them produce a document that adds
// up and is wrong.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BillingError } from '../src/errors';
import type { Invoice, InvoiceLine } from '../src/invoices/types';
import { Money, Rate } from '../src/money';
import type { TaxQuote, TaxQuoteRequest } from '../src/tax';
import { assertQuoteCovers, taxableLinesOf, taxLinesFrom, taxTotal } from '../src/tax';

const NOW = new Date('2026-08-19T12:00:00Z');
const usd = (minor: bigint) => Money.fromMinor(minor, 'USD');

const line = (lineNo: number, kind: InvoiceLine['kind'], description: string, amount: Money): InvoiceLine => ({
  id: `line-${lineNo}`,
  lineNo,
  kind,
  description,
  metric: null,
  quantity: null,
  amount,
  metadata: null,
});

const invoiceWith = (lines: readonly InvoiceLine[]): Invoice => ({
  id: 'inv-1',
  tenantId: 't1',
  subjectId: 's1',
  number: null,
  state: 'draft',
  currency: 'USD',
  subtotal: usd(0n),
  total: usd(0n),
  subscriptionPeriodId: null,
  period: null,
  provider: null,
  providerRef: null,
  issuedAt: null,
  dueAt: null,
  paidAt: null,
  voidedAt: null,
  metadata: null,
  createdAt: NOW,
  lines,
});

const request = (over: Partial<TaxQuoteRequest> = {}): TaxQuoteRequest => ({
  tenantId: 't1',
  subjectId: 's1',
  currency: 'USD',
  pricing: 'exclusive',
  seller: { address: { country: 'US', region: 'CA' } },
  customer: { address: { country: 'US', region: 'NY', postalCode: '10001' } },
  lines: [{ ref: '1', description: 'Pro plan', amount: usd(10_000n) }],
  taxedAt: NOW,
  idempotencyKey: 'quote-1',
  ...over,
});

const NY_STATE: TaxQuote['amounts'][number] = {
  ref: '1',
  amount: usd(400n),
  rate: Rate.fromDecimalString('0.04'),
  description: 'NY State Sales Tax 4%',
  jurisdiction: 'US-NY',
};

const quote = (over: Partial<TaxQuote> = {}): TaxQuote => ({
  ref: 'calc-1',
  amounts: [NY_STATE],
  raw: {},
  ...over,
});

describe('taxableLinesOf', () => {
  it('sends discounts, negative and all, because a discount reduces the base', () => {
    const lines = taxableLinesOf(
      invoiceWith([line(1, 'base', 'Pro plan', usd(10_000n)), line(2, 'discount', 'Launch offer', usd(-2_000n))]),
    );
    assert.equal(lines.length, 2);
    assert.equal(lines[1]?.amount.minor, -2_000n);
  });

  it('drops tax lines, so a re-quote does not tax the tax', () => {
    const lines = taxableLinesOf(
      invoiceWith([line(1, 'base', 'Pro plan', usd(10_000n)), line(2, 'tax', 'NY 4%', usd(400n))]),
    );
    assert.deepEqual(
      lines.map((l) => l.ref),
      ['1'],
    );
  });
});

describe('assertQuoteCovers', () => {
  it('refuses a currency the invoice is not in', () => {
    const bad = quote({ amounts: [{ ...NY_STATE, amount: Money.fromMinor(400n, 'EUR') }] });
    assert.throws(
      () => assertQuoteCovers(request(), bad),
      (e: unknown) => BillingError.hasCode(e, 'invalid_tax'),
    );
  });

  it('refuses a line that was never sent', () => {
    const bad = quote({ amounts: [{ ...NY_STATE, ref: '9' }] });
    assert.throws(
      () => assertQuoteCovers(request(), bad),
      (e: unknown) => BillingError.hasCode(e, 'invalid_tax'),
    );
  });

  it('refuses a negative amount on a line that was not itself negative', () => {
    const bad = quote({ amounts: [{ ...NY_STATE, amount: usd(-400n) }] });
    assert.throws(
      () => assertQuoteCovers(request(), bad),
      (e: unknown) => BillingError.hasCode(e, 'invalid_tax'),
    );
  });

  it('allows a negative amount on a discount line, which is how netting works', () => {
    // The quote is per line, so a discount's contribution to the tax has to be
    // able to be negative. What must not go negative is the jurisdiction total.
    const withDiscount = request({
      lines: [
        { ref: '1', description: 'Pro plan', amount: usd(10_000n) },
        { ref: '2', description: 'Coupon', amount: usd(-2_000n) },
      ],
    });
    const netted = quote({
      amounts: [
        { ...NY_STATE, ref: '1', amount: usd(400n) },
        { ...NY_STATE, ref: '2', amount: usd(-80n) },
      ],
    });
    assert.doesNotThrow(() => assertQuoteCovers(withDiscount, netted));
    const lines = taxLinesFrom(withDiscount, netted);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.amount.minor, 320n);
  });

  it('refuses a jurisdiction that sums to less than zero across the invoice', () => {
    const withDiscount = request({
      lines: [
        { ref: '1', description: 'Pro plan', amount: usd(1_000n) },
        { ref: '2', description: 'Coupon', amount: usd(-2_000n) },
      ],
    });
    const upsideDown = quote({
      amounts: [
        { ...NY_STATE, ref: '1', amount: usd(40n) },
        { ...NY_STATE, ref: '2', amount: usd(-80n) },
      ],
    });
    assert.throws(
      () => assertQuoteCovers(withDiscount, upsideDown),
      (e: unknown) => BillingError.hasCode(e, 'invalid_tax'),
    );
  });

  it('drops a jurisdiction whose lines net to zero, however many there were', () => {
    const both = request({
      lines: [
        { ref: '1', description: 'Pro plan', amount: usd(2_000n) },
        { ref: '2', description: 'Full refund line', amount: usd(-2_000n) },
      ],
    });
    const nets = quote({
      amounts: [
        { ...NY_STATE, ref: '1', amount: usd(80n) },
        { ...NY_STATE, ref: '2', amount: usd(-80n) },
      ],
    });
    assert.deepEqual(taxLinesFrom(both, nets), []);
  });

  it('refuses the same jurisdiction twice on one line', () => {
    const one = NY_STATE;
    assert.throws(
      () => assertQuoteCovers(request(), quote({ amounts: [one, one] })),
      (e: unknown) => BillingError.hasCode(e, 'invalid_tax'),
    );
  });

  it('allows two jurisdictions on one line, which is what a US sale is', () => {
    const state = NY_STATE;
    const county = { ...state, jurisdiction: 'US-NY-NEW-YORK', description: 'NYC Local 4.5%', amount: usd(450n) };
    assert.doesNotThrow(() => assertQuoteCovers(request(), quote({ amounts: [state, county] })));
  });
});

describe('taxLinesFrom', () => {
  it('makes one line per jurisdiction, carrying rate and source lines in metadata', () => {
    const state = NY_STATE;
    const county = { ...state, jurisdiction: 'US-NY-NEW-YORK', description: 'NYC Local 4.5%', amount: usd(450n) };
    const lines = taxLinesFrom(request(), quote({ amounts: [state, county] }));

    assert.equal(lines.length, 2);
    assert.equal(lines[0]?.kind, 'tax');
    assert.equal(lines[0]?.description, 'NY State Sales Tax 4%');
    assert.deepEqual(lines[0]?.metadata, {
      jurisdiction: 'US-NY',
      rate: '0.040000000000',
      taxedLineNos: ['1'],
      quoteRef: 'calc-1',
    });
  });

  it('merges one rate across many items into one line, because that is how an invoice reads', () => {
    const three = request({
      lines: [
        { ref: '1', description: 'Pro plan', amount: usd(10_000n) },
        { ref: '2', description: 'Seats', amount: usd(3_000n) },
        { ref: '3', description: 'Overage', amount: usd(500n) },
      ],
    });
    const perLine = quote({
      amounts: [
        { ...NY_STATE, ref: '1', amount: usd(400n) },
        { ...NY_STATE, ref: '2', amount: usd(120n) },
        { ...NY_STATE, ref: '3', amount: usd(20n) },
      ],
    });
    const lines = taxLinesFrom(three, perLine);
    assert.equal(lines.length, 1, 'three items at one rate is one tax line');
    assert.equal(lines[0]?.amount.minor, 540n);
    assert.deepEqual(lines[0]?.metadata?.taxedLineNos, ['1', '2', '3']);
  });

  it('keeps two rates in one jurisdiction apart, so the arithmetic stays checkable', () => {
    const two = request({
      lines: [
        { ref: '1', description: 'Software', amount: usd(10_000n) },
        { ref: '2', description: 'Printed manual', amount: usd(2_000n) },
      ],
    });
    const mixed = quote({
      amounts: [
        { ...NY_STATE, ref: '1', amount: usd(2_000n), rate: Rate.fromDecimalString('0.2') },
        {
          ...NY_STATE,
          ref: '2',
          amount: usd(100n),
          rate: Rate.fromDecimalString('0.05'),
          description: 'VAT reduced 5%',
        },
      ],
    });
    assert.equal(taxLinesFrom(two, mixed).length, 2);
  });

  it('never merges a reverse charge into a taxed line, because it carries a sentence', () => {
    const two = request({
      lines: [
        { ref: '1', description: 'Software', amount: usd(10_000n) },
        { ref: '2', description: 'Support', amount: usd(2_000n) },
      ],
    });
    const mixed = quote({
      amounts: [
        { ...NY_STATE, ref: '1', amount: usd(400n) },
        {
          ...NY_STATE,
          ref: '2',
          amount: usd(0n),
          reverseCharge: true,
          description: 'Reverse charge \u2014 Article 196',
        },
      ],
    });
    const lines = taxLinesFrom(two, mixed);
    assert.equal(lines.length, 2);
    assert.equal(lines[1]?.metadata?.reverseCharge, true);
  });

  it('drops a plain zero but keeps a reverse charge, which the document must state', () => {
    const zero = { ...NY_STATE, amount: usd(0n), rate: Rate.zero() };
    assert.equal(taxLinesFrom(request(), quote({ amounts: [zero] })).length, 0);

    const reverse = { ...zero, reverseCharge: true, description: 'Reverse charge — Article 196' };
    const lines = taxLinesFrom(request(), quote({ amounts: [reverse] }));
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.amount.isZero(), true);
    assert.equal(lines[0]?.metadata?.reverseCharge, true);
  });

  it('refuses tax-inclusive pricing rather than adding tax to a price that had it', () => {
    assert.throws(
      () => taxLinesFrom(request({ pricing: 'inclusive' }), quote()),
      (e: unknown) => BillingError.hasCode(e, 'invalid_tax'),
    );
  });
});

describe('taxTotal', () => {
  it('sums only the tax lines', () => {
    const total = taxTotal(
      invoiceWith([
        line(1, 'base', 'Pro plan', usd(10_000n)),
        line(2, 'tax', 'NY 4%', usd(400n)),
        line(3, 'tax', 'NYC 4.5%', usd(450n)),
      ]),
    );
    assert.equal(total.minor, 850n);
  });

  it('is zero, not an error, on an invoice with no tax', () => {
    assert.equal(taxTotal(invoiceWith([line(1, 'base', 'Pro plan', usd(10_000n))])).minor, 0n);
  });
});
