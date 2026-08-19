// The tax seam: what a calculator is asked, and what it may answer.
//
// Everything here is a type. There is no rate in this file, no jurisdiction
// table, and no arithmetic, and that is the design rather than an unfinished
// state of it. Rates move constantly — thresholds, nexus rules, temporary
// reductions, a mandate that lands in one country with nine months' notice —
// and a library that shipped them would ship a table that is wrong for every
// adopter who has not upgraded. The vendors whose whole business is keeping
// that table right are better at it than we would be.
//
// So billing-kit owns the shape of the question and the place the answer goes.
// The answer comes from a `TaxCalculator` the host supplies.
//
// Two rules govern the seam, and both exist because breaking them produces a
// wrong number rather than a loud failure:
//
//   1. We never recompute an amount from a rate. The calculator returns money;
//      `rate` is carried for the invoice to display and for a human to audit.
//      Recomputing turns the vendor's rounding rule into ours, and the two
//      disagree first on the smallest line on the invoice.
//   2. We never quote at all when the provider is the merchant of record.
//      Paddle computes and remits its own tax and issues its own document; a
//      second calculation against the same sale produces a liability we do not
//      owe. `taxIsOurs()` in `providers/capabilities.ts` is that gate.

import type { Money, Rate } from '../money.ts';
import type { SubjectId, TenantId } from '../types.ts';

/**
 * Where a party is, in as much detail as determining the place of supply
 * actually takes.
 *
 * `country` alone is enough for VAT and is what the provider layer carries on
 * `CustomerRef`. It is not enough for the United States, where the rate varies
 * by district within a state and destination sourcing reads the postal code;
 * an adapter handed only a country there has to guess, and a guessed US rate
 * is wrong far more often than it is right.
 */
export interface TaxAddress {
  /** ISO 3166-1 alpha-2, upper case. */
  country: string;
  /** State, province or region code. Required in practice for US and CA. */
  region?: string;
  postalCode?: string;
  city?: string;
  line1?: string;
}

/**
 * A tax registration number, as the vendor expects to receive it.
 *
 * `type` is the vendor's vocabulary (`eu_vat`, `gb_vat`, `us_ein`, …) rather
 * than ours, because normalising it would mean maintaining the mapping for
 * every jurisdiction that invents one — the same table this seam exists to
 * avoid owning.
 */
export interface TaxRegistration {
  type: string;
  value: string;
}

export interface TaxParty {
  address: TaxAddress;
  /**
   * The party's registration, when there is one.
   *
   * Absence is a real answer, not a missing field: a customer with no VAT
   * number is a consumer sale, and in the EU that is precisely the case where
   * tax is charged rather than reverse-charged. An adapter must not treat
   * `undefined` as "look it up".
   */
  registration?: TaxRegistration;
  /**
   * True when the host holds a verified exemption certificate for this party.
   *
   * We assert it; we do not verify it. Certificate collection and expiry are
   * the calculator vendor's job where it does that job, and the host's
   * otherwise. billing-kit stores neither.
   */
  exempt?: boolean;
}

/** One line of the draft, as the calculator sees it. */
export interface TaxableLine {
  /** The draft's `lineNo`, as a string. What the answer is keyed by. */
  ref: string;
  description: string;
  /**
   * Signed, exactly as it sits on the invoice. Discount and credit lines are
   * negative and are included on purpose: a discount reduces the taxable base,
   * and a request that sends only the positive lines over-taxes every invoice
   * that carries one.
   */
  amount: Money;
  /**
   * The host's product tax code for this line — `SW054000`, `txcd_10103000`,
   * whatever the chosen vendor's catalogue calls it. Opaque to us and passed
   * through unread. Omitted lines get the vendor's default, which is usually
   * "standard rate" and is usually right for software.
   */
  taxCode?: string;
}

/**
 * Whether the amounts on the draft already contain tax.
 *
 * A property of the host's price list, not of the calculation, which is why it
 * is an input. Inclusive pricing is the norm for EU consumer sales: the €10 on
 * the page is what the customer pays, and the VAT is extracted from it rather
 * than added to it. That extraction changes the revenue lines themselves, so
 * the two cannot share a code path — see `taxLinesFrom`, which refuses
 * `inclusive` rather than silently adding tax on top of a price that already
 * had it.
 */
export type TaxPricing = 'exclusive' | 'inclusive';

export interface TaxQuoteRequest {
  tenantId: TenantId;
  subjectId: SubjectId;
  currency: string;
  pricing: TaxPricing;
  /** Where we are established as the seller. */
  seller: TaxParty;
  customer: TaxParty;
  lines: readonly TaxableLine[];
  /**
   * The date whose rates apply — the invoice's issue date, not the wall clock.
   * A period invoiced late is taxed at the rate in force when it was supplied,
   * and passing `now` quietly re-rates every backfilled invoice.
   */
  taxedAt: Date;
  /**
   * Ours, stable across retries of the same quote. Vendors that charge per
   * calculation bill twice for a retry that does not carry one.
   */
  idempotencyKey: string;
}

/** What the calculator says about one line. */
export interface TaxAmount {
  /** The `TaxableLine.ref` this taxes. */
  ref: string;
  /** The vendor's number. Ours to record, never to recompute. */
  amount: Money;
  /** Decimal fraction — `0.2` is twenty percent. Display and audit only. */
  rate: Rate;
  /** Human-readable, and what the invoice line will say: `VAT (GB) 20%`. */
  description: string;
  /** The vendor's jurisdiction identifier, for the liability report. */
  jurisdiction: string;
  /**
   * True when the liability shifts to the customer — an EU B2B cross-border
   * sale. `amount` is then zero, and the invoice is legally required to say
   * why, which is what `description` carries.
   */
  reverseCharge?: boolean;
  /** True when the line was exempt or zero-rated. `amount` is zero. */
  exempt?: boolean;
}

export interface TaxQuote {
  /**
   * The vendor's handle for this calculation, carried into `commit` and
   * `void`. Null from a calculator that keeps no server-side record, which is
   * a legitimate implementation — a fixed-rate one, for instance.
   */
  ref: string | null;
  amounts: readonly TaxAmount[];
  /** The vendor's response, unread by us and kept for support. */
  raw: unknown;
}

export interface TaxCommitInput {
  quoteRef: string;
  /** Our invoice number, once it exists. The vendor files against this. */
  documentRef: string;
  issuedAt: Date;
}

/**
 * What the host supplies. One required method; the other two exist only for
 * vendors that also file returns on your behalf.
 *
 * `quote` is called against a **draft**, before `finalize` freezes the lines
 * and takes a gap-free number. That ordering is the whole of the integration
 * contract: a number is assigned once and can never be reissued, so a tax line
 * added after finalize would have to void the document and take a second
 * number for the same sale.
 *
 * Implementations live in `@quxkit/billing-kit-adapters`, next to the provider
 * adapters and covered by the same conformance suite. None ship here.
 */
export interface TaxCalculator {
  readonly name: string;
  quote(request: TaxQuoteRequest): Promise<TaxQuote>;
  /**
   * Report a finalized invoice for filing. Idempotent on `documentRef` — a
   * retry after a timeout must not file the same sale twice.
   */
  commit?(input: TaxCommitInput): Promise<void>;
  /** Reverse a committed document, when the invoice is voided or credited. */
  void?(input: { quoteRef: string; documentRef: string }): Promise<void>;
}
