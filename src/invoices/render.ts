// Rendering: an invoice as JSON or as a self-contained HTML document.
//
// No PDF. Deliberately: a PDF renderer is a native dependency or a headless
// browser, and either one is the heaviest thing in the tree by an order of
// magnitude. The HTML here is print-styled and prints to PDF from any browser
// or from a host's own renderer of choice; the JSON is the wire form for a
// host that has one already.

import type { Invoice, InvoiceLine } from './types.ts';

export interface RenderOptions {
  format: 'json' | 'html';
  /** Shown at the top of the HTML document. */
  issuer?: { name: string; address?: string };
  /** Shown as the bill-to block. */
  billTo?: { name: string; address?: string; email?: string };
  /** `Intl` locale for money in the HTML. Default `en-US`. */
  locale?: string;
}

/** The JSON shape: what `renderInvoice(inv, { format: 'json' })` returns. */
export interface InvoiceJSON {
  id: string;
  number: string | null;
  state: Invoice['state'];
  tenantId: string;
  subjectId: string;
  currency: string;
  subtotal: string;
  total: string;
  period: { start: string; end: string } | null;
  issuedAt: string | null;
  dueAt: string | null;
  paidAt: string | null;
  lines: {
    lineNo: number;
    kind: InvoiceLine['kind'];
    description: string;
    metric: string | null;
    quantity: string | null;
    amount: string;
  }[];
}

export function invoiceToJSON(inv: Invoice): InvoiceJSON {
  return {
    id: inv.id,
    number: inv.number,
    state: inv.state,
    tenantId: inv.tenantId,
    subjectId: inv.subjectId,
    currency: inv.currency,
    subtotal: inv.subtotal.toDecimalString(),
    total: inv.total.toDecimalString(),
    period: inv.period ? { start: inv.period.start.toISOString(), end: inv.period.end.toISOString() } : null,
    issuedAt: inv.issuedAt?.toISOString() ?? null,
    dueAt: inv.dueAt?.toISOString() ?? null,
    paidAt: inv.paidAt?.toISOString() ?? null,
    lines: inv.lines.map((l) => ({
      lineNo: l.lineNo,
      kind: l.kind,
      description: l.description,
      metric: l.metric,
      quantity: l.quantity?.toDecimalString() ?? null,
      amount: l.amount.toDecimalString(),
    })),
  };
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

function money(locale: string, currency: string, decimal: string): string {
  // Number() on a currency decimal string is safe for display: the value has at
  // most `currencyExponent` fractional digits and Intl formats it back exactly
  // for any amount an invoice plausibly carries. The exact string is in the
  // JSON form; this is presentation.
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(Number(decimal));
  } catch {
    return `${decimal} ${currency}`;
  }
}

const date = (d: Date | null): string => (d ? d.toISOString().slice(0, 10) : '—');

export function invoiceToHTML(inv: Invoice, opts: RenderOptions): string {
  const locale = opts.locale ?? 'en-US';
  const fmt = (m: { toDecimalString(): string }) => money(locale, inv.currency, m.toDecimalString());
  const title = inv.number ?? `Draft ${inv.id.slice(0, 8)}`;
  const block = (label: string, party?: { name: string; address?: string; email?: string }) =>
    party
      ? `<div class="party"><div class="label">${esc(label)}</div><div>${esc(party.name)}</div>` +
        (party.address ? `<div>${esc(party.address).replace(/\n/g, '<br>')}</div>` : '') +
        (party.email ? `<div>${esc(party.email)}</div>` : '') +
        '</div>'
      : '';
  const rows = inv.lines
    .map(
      (l) =>
        `<tr class="line ${l.kind}"><td>${esc(l.description)}</td>` +
        `<td class="num">${l.quantity ? esc(l.quantity.toDecimalString().replace(/\.?0+$/, '')) : ''}</td>` +
        `<td class="num">${fmt(l.amount)}</td></tr>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Invoice ${esc(title)}</title>
<style>
body{font:14px/1.4 system-ui,sans-serif;color:#111;margin:2rem auto;max-width:48rem;padding:0 1rem}
h1{font-size:1.5rem;margin:0 0 .25rem}.state{text-transform:uppercase;font-size:.75rem;letter-spacing:.05em;color:#555}
.meta{display:flex;gap:2rem;flex-wrap:wrap;margin:1rem 0}.party .label{font-size:.75rem;color:#555;text-transform:uppercase}
table{width:100%;border-collapse:collapse;margin-top:1rem}th,td{padding:.4rem .5rem;border-bottom:1px solid #ddd;text-align:left}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}tr.discount td,tr.credit td{color:#2a6}
tfoot td{border:0;font-weight:600}@media print{body{margin:0}}
</style></head><body>
<h1>Invoice ${esc(title)}</h1><div class="state">${esc(inv.state)}</div>
<div class="meta">${block('From', opts.issuer)}${block('Bill to', opts.billTo)}
<div class="party"><div class="label">Dates</div><div>Issued ${date(inv.issuedAt)}</div><div>Due ${date(inv.dueAt)}</div>${
    inv.period ? `<div>Period ${date(inv.period.start)} to ${date(inv.period.end)}</div>` : ''
  }</div></div>
<table><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Amount</th></tr></thead>
<tbody>
${rows}
</tbody>
<tfoot><tr><td>Subtotal</td><td></td><td class="num">${fmt(inv.subtotal)}</td></tr>
<tr><td>Total</td><td></td><td class="num">${fmt(inv.total)}</td></tr></tfoot></table>
</body></html>
`;
}

/**
 * Render an invoice. `json` returns the wire object; `html` a self-contained,
 * print-styled document. There is no PDF format — print the HTML.
 */
export function renderInvoice(inv: Invoice, opts: RenderOptions & { format: 'json' }): InvoiceJSON;
export function renderInvoice(inv: Invoice, opts: RenderOptions & { format: 'html' }): string;
export function renderInvoice(inv: Invoice, opts: RenderOptions): InvoiceJSON | string {
  return opts.format === 'json' ? invoiceToJSON(inv) : invoiceToHTML(inv, opts);
}
