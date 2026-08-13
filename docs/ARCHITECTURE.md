# billing-kit — Architecture

Usage-based billing as a library, over a provider you choose.

```
  your app ──record(usage)──▶ usage_events ──aggregate──▶ usage_aggregates
                                                               │ price
                                                               ▼
   provider  ◀────settle(period)──── ledger_entries ◀──post── charges
      │                                    ▲
      └────webhook (payment, refund)───────┘
```

billing-kit owns everything left of `settle`. The provider owns everything right
of it. That line is the whole design, and it is drawn where it is because it is
the only place all three of Stripe, Paddle and Lago agree.

---

## 1. Scope

**billing-kit does, always, itself:**

| | Why it cannot be delegated |
|---|---|
| Metering — accepting and deduplicating usage events | The event rate is your traffic's rate, not a provider's API budget. |
| Aggregation — events to billable quantities | Two of the three providers cannot do it; the one that can is not always the one you ship with. |
| Pricing — quantities to amounts | You must be able to answer "why is this number" from your own tables, offline, at any time. |
| The ledger — an append-only double-entry record | It is the financial record. It has to survive changing providers. |
| Idempotency | Every provider's idempotency window is finite and shorter than your incident. |

**The provider does:**

customers, subscriptions, settlement of a closed period, payment capture,
refunds, webhook signature verification. Nothing else.

**billing-kit is not:** a tax engine, a dunning system, a pricing UI, an
accounting system, or a payment processor. It has interfaces where those attach
and no opinions inside them.

---

## 2. The provider interface

### 2.1 The problem with the obvious interface

The interface everyone writes first is Stripe's object model with the word
`Stripe` deleted:

```ts
// Wrong. Do not ship this.
interface Provider {
  createInvoice(customerId: string): Promise<Invoice>;
  addLineItem(invoiceId: string, line: Line): Promise<void>;
  finalizeInvoice(invoiceId: string): Promise<Invoice>;
}
```

Paddle cannot implement it. Paddle is the merchant of record: it is the legal
seller, it computes and remits the tax, and it issues the document. There is no
API that says "put this line on this invoice for this amount." You tell Paddle a
*quantity* against a price it already holds, and Paddle decides what the invoice
says. An adapter that fakes `addLineItem` by accumulating lines in memory and
guessing the total will disagree with the real invoice the first time tax,
rounding or a currency conversion enters, and the disagreement surfaces as a
ledger that does not reconcile.

Lago cannot implement it faithfully either, for a different reason: Lago issues
invoices but does not capture money. It hands off to a PSP. `finalizeInvoice`
returning something you treat as "paid" is a lie on Lago.

So the interface must be built from what the three actually have in common,
which is less than it first appears.

### 2.2 What the three actually do

| Stage | Stripe | Paddle | Lago |
|---|---|---|---|
| Merchant of record | you | **Paddle** | you |
| Usage ingest | optional (Billing Meters) | none | **native** (events) |
| Aggregation | optional | none | **native** (billable metrics) |
| Arbitrary invoice lines | yes (`InvoiceItem`) | **no** | yes (add-ons / one-off) |
| Quantity against a held price | yes | **yes, only this** | yes |
| Payment capture | yes | yes | **no — delegates to a PSP** |
| Tax | opt-in (Stripe Tax) | mandatory, theirs | pluggable |
| Refund | immediate API call | **request, subject to approval** | credit note |
| Request idempotency key | yes (`Idempotency-Key`) | yes | **no general key** |
| Event dedupe key | — | — | yes (`transaction_id`) |
| Webhook signature | HMAC-SHA256, `t=…,v1=…` | HMAC-SHA256, `ts=…;h1=…` | **JWT RS256, key fetched** |

Five things fall out of that table, and all five are load-bearing:

1. **Settlement has two shapes, not one.** Some providers take priced lines,
   some take only a quantity. Both must be first-class.
2. **Under quantity settlement the provider's number is authoritative and ours
   is an estimate.** The ledger has to record which.
3. **Payment is not the same event as invoicing.** On Lago they are different
   systems entirely.
4. **Refunds are not always synchronous.** On Paddle a refund is a request that
   a human may decline.
5. **Webhook verification may need I/O.** Lago fetches a public key, so the
   verifier is `async` even though Stripe's and Paddle's are pure. Making the
   signature the shape of the strictest member is not a Lago concession; it is
   what stops a future provider from forcing a breaking change.

### 2.3 The interface

```ts
/** What a provider can do. billing-kit branches on this, never on a name. */
export interface ProviderCapabilities {
  /** How this provider will be asked to settle a period. */
  settlement: readonly SettlementMode[];
  /** True when the provider is the legal seller. Suppresses our tax hooks and
   *  makes our computed amounts advisory — the failure this prevents is a
   *  ledger that reconciles against a document we did not issue. */
  merchantOfRecord: boolean;
  /** False when settling does not collect money (Lago). Callers must not treat
   *  a settled invoice as a paid one. */
  capturesPayment: boolean;
  /** True when a refund is a request that may be declined (Paddle). The ledger
   *  posts on the webhook, never on the call's return. */
  refundsAreAsynchronous: boolean;
  /** Provider-side request idempotency, if any. Always an optimisation on top
   *  of our own record, never a substitute — every provider's retention window
   *  is finite and shorter than a bad weekend. */
  idempotency: { header: string; retentionHours: number } | null;
}

export type SettlementMode =
  /** Provider accepts priced lines we compose. Stripe, Lago. */
  | 'lines'
  /** Provider holds the price; we send only a quantity. Paddle, and Stripe or
   *  Lago when the operator chose to keep prices provider-side. */
  | 'quantity';
```

```ts
export interface BillingProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;

  // --- identity -----------------------------------------------------------

  /**
   * Idempotent by `ref.key`, which is ours, not theirs.
   *
   * Must treat "a customer with this email already exists" as success and
   * return the existing id. Paddle dedupes customers on email server-side and
   * answers a create with a conflict; an adapter that propagates that as an
   * error makes every retry after a timeout permanently fatal.
   */
  ensureCustomer(ref: CustomerRef): Promise<ProviderCustomer>;

  /**
   * Look up by our reference. Required, not optional.
   *
   * This is the recovery path for providers with no request idempotency key:
   * after a timeout we cannot safely retry a create, so we must be able to ask
   * whether the first attempt landed.
   */
  findCustomer(key: string): Promise<ProviderCustomer | null>;

  // --- subscription -------------------------------------------------------

  ensureSubscription(input: SubscriptionInput): Promise<ProviderSubscription>;
  cancelSubscription(id: string, at: CancelAt): Promise<ProviderSubscription>;

  /**
   * The item a quantity is pushed against, resolved from our metric key.
   * Returns null on providers where prices live on our side.
   */
  resolveItem(subscriptionId: string, metric: string): Promise<ProviderItem | null>;

  // --- settlement ---------------------------------------------------------

  /**
   * Settle one sealed period. The single operation the whole library exists
   * to reach.
   *
   * `request.mode` is always one the provider declared. The caller picked it;
   * the adapter does not choose and does not fall back — a silent fallback
   * from `lines` to `quantity` changes who owns the price without telling the
   * ledger, and the discrepancy shows up a month later as unexplained drift.
   */
  settle(request: SettlementRequest): Promise<SettlementResult>;

  /** Recovery counterpart to `settle`, by our idempotency key. */
  findSettlement(key: string): Promise<SettlementResult | null>;

  // --- money out ----------------------------------------------------------

  /**
   * On providers where `refundsAreAsynchronous`, a resolved promise means the
   * request was accepted, not that money moved. The ledger posts on the
   * webhook in both cases, so the two paths stay identical.
   */
  refund(input: RefundInput): Promise<RefundAcknowledgement>;

  // --- inbound ------------------------------------------------------------

  /**
   * Verify and normalise. Takes bytes, because a signature is over bytes:
   * JSON.parse then re-serialise changes key order and whitespace and the HMAC
   * fails. This is the single most common integration bug and the interface is
   * shaped to make it impossible.
   *
   * Async because Lago verifies an RS256 JWT against a key it must fetch.
   */
  verifyWebhook(input: RawRequest): Promise<VerifiedEvent>;
}
```

```ts
export interface SettlementRequest {
  mode: SettlementMode;
  idempotencyKey: string;
  customerId: string;
  subscriptionId: string | null;
  period: { start: Date; end: Date };
  currency: string;
  /** Present when mode === 'lines'. Amounts are ours and authoritative. */
  lines?: readonly SettlementLine[];
  /** Present when mode === 'quantity'. No amounts — the provider prices it. */
  quantities?: readonly { itemId: string; quantity: string }[];
}

export interface SettlementResult {
  providerRef: string;
  status: 'draft' | 'open' | 'settled' | 'void' | 'failed';
  /** What the provider says the period costs. Under `quantity` this is the
   *  first time we learn the real number. Null when the provider has not
   *  priced it yet (Paddle drafts). */
  providerTotal: Money | null;
  /** Tax the provider computed and owns. Never folded into providerTotal by
   *  us — a merchant-of-record's tax is not our revenue. */
  providerTax: Money | null;
  raw: unknown;
}
```

### 2.4 Normalised events

`verifyWebhook` returns a small union. It is deliberately smaller than any
provider's event catalogue:

```ts
export type VerifiedEvent = {
  providerEventId: string;
  /** The provider's own ordering signal. Webhooks arrive out of order; the
   *  state machine uses this and never wall-clock arrival. */
  occurredAt: Date;
  raw: unknown;
} & (
  | { kind: 'payment.succeeded';      settlementRef: string; amount: Money }
  | { kind: 'payment.failed';         settlementRef: string; reason: string }
  | { kind: 'settlement.finalized';   settlementRef: string; total: Money; tax: Money | null }
  | { kind: 'settlement.voided';      settlementRef: string }
  | { kind: 'refund.settled';         refundRef: string; amount: Money }
  | { kind: 'refund.declined';        refundRef: string; reason: string }
  | { kind: 'subscription.changed';   subscriptionRef: string; status: SubscriptionStatus }
  /** Signature valid, meaning not modelled. Stored and acknowledged. */
  | { kind: 'unknown'; providerKind: string }
);
```

`unknown` is not a gap — it is the contract. A kit that invents a normalised
kind for every provider event ends up with a union that is Stripe's catalogue
with two others crammed in. Anything not in the list above is persisted raw,
acknowledged with 200 so the provider stops retrying, and made available to the
host application. Silently dropping it, or 500-ing on it, both end in a
disabled webhook endpoint.

### 2.5 Honesty check, per provider

**Stripe** — `lines` and `quantity`. `merchantOfRecord: false`,
`capturesPayment: true`, `refundsAreAsynchronous: false`,
`idempotency: { header: 'Idempotency-Key', retentionHours: 24 }`.
`settle` in `lines` mode creates invoice items then an invoice; in `quantity`
mode reports against a metered price. `verifyWebhook` is HMAC-SHA256 over
`` `${t}.${rawBody}` `` compared to `v1`, with a timestamp tolerance.

**Paddle** — `quantity` only. `merchantOfRecord: true`, `capturesPayment: true`,
`refundsAreAsynchronous: true`. `settle` pushes quantities to subscription
items; `providerTotal` is null until Paddle prices the transaction, and arrives
on `settlement.finalized`. `resolveItem` maps our metric to a Paddle price id.
`verifyWebhook` is HMAC-SHA256 over `` `${ts}:${rawBody}` `` compared to `h1`.

**Lago** — `lines` and `quantity`. `merchantOfRecord: false`,
`capturesPayment: **false**`, `idempotency: null`. Because `capturesPayment` is
false, `settle` returning `status: 'settled'` means *invoiced*, and no ledger
entry for cash is posted until a payment webhook arrives from the PSP Lago
delegates to. Because `idempotency` is null, `findSettlement` is the recovery
path and is therefore mandatory on the interface rather than optional.
`verifyWebhook` verifies an RS256 JWT against Lago's published key, cached with
a TTL — the reason the method is `async`.

No branch anywhere in billing-kit reads `provider.name`. Every branch reads
`capabilities`. That rule is what keeps a fourth provider from being a rewrite,
and it is enforceable in review by grepping for the string.

---

## 3. Money

### 3.1 The rule

> Amounts are integer minor units in a signed 64-bit integer.
> Rates are exact decimals with a declared scale.
> Neither is ever a JavaScript `number`.

Two types, because they are two different things and conflating them is how
kits end up rounding in the wrong place.

### 3.2 Why not float

Not because of magnitude. IEEE-754 doubles hold integers exactly up to
2^53 − 1 = 9,007,199,254,740,991, which in cents is about ninety trillion
dollars — no balance you hold will overflow it.

The reason is that decimal fractions are not representable and the errors
compound:

- `0.1 + 0.2 === 0.30000000000000004`. A per-minute rate of `0.000019` billed
  43,200 times a month is 43,200 additions of an inexact value.
- **Postgres `SUM(double precision)` is not associative.** Floating-point
  addition depends on order, and the planner is free to change order — a
  parallel aggregate, a different index, a new row count, and the same rows
  produce a different total. A ledger whose total depends on the query plan
  cannot be re-derived, and re-derivability is the only thing that makes an
  audit possible.
- The error is silent. There is no exception, no flag, just a number that is
  slightly wrong in a direction that correlates with volume.

`NUMERIC` in Postgres and `BigInt` in JS both give exact integer arithmetic and
exact addition in any order.

### 3.3 Storage

| Thing | Postgres | Prisma | Why |
|---|---|---|---|
| Amount | `BIGINT` | `BigInt` | 8 bytes, indexable, and `SUM(bigint)` widens to `numeric` so aggregation cannot overflow. |
| Rate / unit price | `NUMERIC(38,12)` | `Decimal` | A unit price is not expressible in minor units — $0.0000012 per token is real. Twelve fractional digits covers per-token pricing with headroom. |
| Quantity | `NUMERIC(38,12)` | `Decimal` | Gigabyte-hours and fractional seconds are not integers. |
| Currency | `CHAR(3)` | `String` | ISO 4217 alpha code. Never nullable, never defaulted. |

The exponent is never assumed. `* 100` is wrong for JPY (0), KWD (3), CLF (4),
and for MGA and MRU, whose subunit is one fifth rather than one hundredth.
billing-kit ships an ISO 4217 exponent table and `Money` refuses a currency not
in it.

### 3.4 Crossing the JavaScript boundary

The boundary is where precision is actually lost in practice, so it is closed by
construction rather than by discipline.

```ts
/**
 * An exact amount. Immutable, currency-tagged.
 *
 * There is deliberately no constructor taking `number`. Once a value has been
 * through a JS float there is no way to tell an exact 19.99 from a 19.99 that
 * has already drifted, so the type refuses to accept the ambiguity rather than
 * documenting it.
 */
export class Money {
  private constructor(
    readonly minor: bigint,
    readonly currency: string,
  ) {}

  static fromMinor(minor: bigint | string, currency: string): Money;
  /** Parses lexically. Never parseFloat, never Number(). */
  static fromDecimalString(value: string, currency: string): Money;

  plus(other: Money): Money;   // throws on currency mismatch
  minus(other: Money): Money;
  negate(): Money;

  /**
   * JSON.stringify throws on a bare bigint. Without this, a Money that reaches
   * a response body crashes the request instead of losing precision — which is
   * better, but still an outage. With it, the wire form is a string and is
   * exact.
   */
  toJSON(): { amount: string; currency: string };

  /** Display only. Not for arithmetic and not for comparison. */
  toDecimalString(): string;
}
```

Wire format, everywhere — HTTP bodies, queue messages, logs:

```json
{ "amount": "1999", "currency": "USD" }
```

A string, in minor units. `1999` and not `19.99`, because a decimal string
re-introduces the question of how many places the currency has, and the answer
has to be looked up somewhere; minor units carry it in the currency tag alone.

Prisma returns `Decimal` (decimal.js) for `NUMERIC` and `bigint` for `BIGINT`.
Neither is JSON-safe and neither should escape the data layer: repository
functions return `Money` and `Rate`, never a raw driver type. The `pg` driver by
default returns `NUMERIC` as a **string** and `BIGINT` as a **string** — both
correct and both must stay strings until they reach `Money.fromMinor`.

### 3.5 Where rounding happens

Exactly one place, stated once:

> `quantity × rate` is computed exactly and rounded to minor units **once, at
> the charge**, using banker's rounding (half-to-even), and the pre-rounding
> exact value is stored alongside.

Not at the event (too many roundings, error grows with row count). Not at the
invoice (the ledger and the invoice then disagree by the residue). At the
charge, once, with the residue kept so the rounding is auditable and so a later
re-pricing can be checked against it.

---

## 4. The event model

```
 record()          seal()            price()          post()          settle()
    │                 │                 │                │                │
    ▼                 ▼                 ▼                ▼                ▼
usage_events ─▶ usage_aggregates ─▶ charges ─▶ ledger_entries ─▶ settlements
    │                 │                 │                │                │
 unique on:      unique on:        unique on:       unique on:       unique on:
 (tenant,        (subject,         (aggregate_id,   (source_kind,    idempotency
  source,         metric,           price_ver)       source_id,       _key
  external_id)    window)                            leg)
```

Every hop has a natural key that is a function of its inputs. That is what makes
replay safe: re-running any hop with the same inputs writes the same rows or no
rows, never different rows.

### 4.1 Ingest

`usage_events` is append-only. Nothing updates it, ever.

The caller supplies `external_id` — their request id, their job id, whatever is
already unique on their side. Duplicate ingest returns **200 with
`deduplicated: true`**, never 409. A retrying client treats 409 as fatal and
either loses the event or pages someone; the whole point of an idempotent
endpoint is that the retry is boring.

`occurred_at` is supplied by the caller and is the partition key.
`received_at` is the database's `now()`. Both are kept: the gap between them is
how late data is measured, and lateness is what decides the seal delay in §4.2.

### 4.2 Aggregation and sealing

A window is `(subject_id, metric, window_start, window_end)` and that tuple is
the idempotency key. Windows are half-open, `[start, end)`, so consecutive
windows can neither gap nor overlap.

A window has two states:

- **open** — recomputation is an upsert. Re-running aggregation is free and
  idempotent.
- **sealed** — immutable. `sealed_at` is set and a trigger rejects updates.

Sealing happens after a configured lateness grace period (default 30 minutes
past `window_end`, tunable per metric from the observed `received_at −
occurred_at` distribution).

An event that arrives for a **sealed** window is not dropped and does not
rewrite the window. It is aggregated into the *current* window as an
`adjustment` row carrying `adjusts_window_start`, so the money is correct and
the audit trail says which period it belongs to.

> The failure this prevents: rewriting a sealed window silently changes an
> invoice that has already been sent to a customer. The customer's PDF and your
> database then disagree, and there is no record that they ever agreed.

### 4.3 Charges

A charge is `(aggregate_id, price_version)`. Prices are versioned rows, never
mutated — a price change writes a new version with a validity range.

Charges are immutable. Repricing does not `UPDATE`; it writes a reversing charge
(the negation, referencing the original) and a new charge at the new version.
The sum is the truth and the history is intact.

### 4.4 The ledger

Double-entry, append-only, two rows per event, and the two rows share a
`transaction_id` with a deferred constraint that their amounts sum to zero.
Nothing is ever updated or deleted. There is no API to delete a ledger entry and
there will not be one.

Account kinds: `customer_balance`, `revenue_accrued`, `revenue_settled`,
`cash`, `tax_payable`, `rounding`, `write_off`.

The **estimate/authority split** from §2.2 lives here:

- Charging accrues: `revenue_accrued` ← `customer_balance`, always our number.
- Settling posts: `revenue_settled` ← `revenue_accrued`, at the **provider's**
  number when `capabilities.merchantOfRecord` or the mode was `quantity`.
- Any difference posts to a `settlement_variance` account. It is never absorbed
  silently. A non-zero variance balance is an alert, not a rounding curiosity.

Cash posts only on `payment.succeeded`. On Lago, where `capturesPayment` is
false, that webhook comes from the PSP and may be days after settlement — which
is why invoicing and payment are separate ledger events rather than one.

### 4.5 Provider calls

```
claim (row: in_flight, key, request hash)
  │                 crash here ─────────┐
  ▼                                     │
call provider (with provider's own key) │
  │                                     │
  ▼                                     ▼
store response (row: settled)      recovery: re-issue with the SAME key if the
                                   provider has one; otherwise findSettlement()
```

`idempotency_records` is `(operation, key)` unique, storing the request hash and
the response. Claim first, then call. A row stuck `in_flight` past a timeout is
the recovery case, and it is handled by *asking the provider* rather than
guessing — which is exactly why `findCustomer` and `findSettlement` are on the
interface as requirements.

Storing the request hash catches the dangerous mistake: the same key with a
*different* request. That is a bug in the caller, and it fails loudly rather
than returning a stale response for a request that was never made.

### 4.6 Webhooks

Unique on `(provider, provider_event_id)`. Store first, acknowledge, then
process — a 200 you sent before persisting is a lost event when the process dies
between.

Out-of-order delivery is normal, not exceptional. State transitions are guarded
by `occurredAt` from the provider, and a transition backwards is recorded and
ignored. A `settlement.voided` arriving before the `settlement.finalized` it
voids must not resurrect the settlement.

### 4.7 What replay actually means

Given `usage_events` and `price_versions`, the contents of `usage_aggregates`
and `charges` for any **open** window are a pure function. You may delete and
recompute them and get byte-identical rows.

For a **sealed** window you may not, and the schema will not let you. That
asymmetry is the design. "Replay safe" without a seal means "an invoice can
change after you sent it", which is not safety.

---

## 5. The metering engine

For subscriptions billed by elapsed time — a running container, a provisioned
database — where the usage event is the passage of a minute and there is no
client to emit it.

### 5.1 What is kept from the reference implementation

The engine in `brett_ai/prisma/scripts/bill_resources_per_min.sql` got the hard
parts right and they are carried forward as requirements:

- **Set-based.** One statement bills N resources. No row-by-row loop.
- **`FOR UPDATE SKIP LOCKED`.** Concurrent workers cannot double-bill and do not
  queue behind each other.
- **Exact numerics.** No floats in the arithmetic.
- **Run metrics emitted**, so a run is observable rather than inferred.

### 5.2 What changes, and why

**a. A batch bound.** The reference has no `LIMIT`. One run locks and updates
every due resource in a single transaction. At high row counts that is an
unbounded transaction: lock pile-up, WAL growth, replica lag, and a run whose
duration is a function of how long you were down. Replaced by a bounded batch
inside its own transaction, and a driver that loops until drained.

**b. Elapsed-minute settlement.** The reference advances
`lastBilledAt = lastBilledAt + interval '1 minute'` — exactly one minute per
run. Six hours of downtime needs 360 runs to catch up. No money is lost;
recovery is O(downtime) where it should be O(1). Replaced by computing whole
elapsed minutes and settling them in one charge.

**c. A catch-up cap.** Elapsed-minute settlement alone lets a resource untouched
for a year produce one charge for 525,600 minutes, driving a prepaid balance far
negative in a single statement with no opportunity to suspend at the right
minute. Capped (default 1,440 minutes) so recovery is O(downtime / cap) and the
balance guard still gets to run between chunks.

**d. Deterministic lock ordering.** The reference locks `billable_resources` via
`SKIP LOCKED`, then updates `BillingAccount` rows in whatever order the
aggregate emits. Two concurrent workers whose batches touch overlapping accounts
can deadlock. Accounts are locked explicitly, ordered by id, before the update.

**e. The failure metrics row is actually written.** The reference's `EXCEPTION`
handler inserts a row into `billing_run_metrics` and then `RAISE`s. The `RAISE`
aborts the transaction, which rolls back that insert. The error row is never
persisted — the one case you most need a record of is the one case that leaves
none. The failure record is written by the driver, outside the failed
transaction.

**f. A balance guard.** The reference bills a resource forever regardless of
balance. billing-kit suspends in the same transaction as the charge. The trade
is explicit: a resource may overdraft by at most one interval, because refusing
to bill for time already consumed is worse than a bounded overdraft.

**g. Several explicit statements in one transaction, not one CTE monolith.** The
reference's `updated_accounts` and `updated_resources` CTEs are never referenced
by the final `SELECT`. Postgres does execute data-modifying CTEs exactly once
regardless, so it is correct — but a reviewer cannot tell that by reading it,
and it cannot be instrumented per step. Atomicity is unchanged; verifiability
and observability are not.

### 5.3 The batch

```sql
-- One batch. One transaction. Called in a loop by the driver until drained.
CREATE OR REPLACE FUNCTION billing.meter_batch(
  p_batch       integer DEFAULT 500,
  p_max_minutes integer DEFAULT 1440
) RETURNS TABLE (items_billed integer, minutes_billed bigint, amount_minor bigint)
LANGUAGE plpgsql AS $$
BEGIN
  CREATE TEMP TABLE due ON COMMIT DROP AS
  SELECT
    r.id,
    r.subject_id,
    r.rate_minor_per_minute,
    r.currency,
    r.last_billed_at,
    -- Whole elapsed minutes, capped. The cap is why recovery is O(downtime/cap)
    -- and not O(downtime), and why the balance guard still gets a turn.
    least(
      floor(extract(epoch from (now() - r.last_billed_at)) / 60)::bigint,
      p_max_minutes::bigint
    ) AS minutes
  FROM billing.billable_items r
  WHERE r.status = 'active'
    AND r.last_billed_at + interval '1 minute' <= now()
  -- Oldest first. Without it, LIMIT makes progress arbitrary and a resource
  -- can starve indefinitely behind a churning head of the table.
  ORDER BY r.last_billed_at
  LIMIT p_batch
  -- Rows already locked by a sibling worker are skipped and do not consume the
  -- limit, so a full batch is still returned under contention.
  FOR UPDATE SKIP LOCKED;

  -- Lock accounts in id order before touching them. Two workers with
  -- overlapping account sets deadlock otherwise, and a deadlock here rolls
  -- back a batch that had already done real work.
  PERFORM 1 FROM billing.ledger_accounts a
   WHERE a.subject_id IN (SELECT subject_id FROM due)
     AND a.kind = 'customer_balance'
   ORDER BY a.id
   FOR UPDATE;

  -- Charges. minutes * rate is exact: both operands are integers.
  INSERT INTO billing.charges (
    id, subject_id, item_id, metric,
    window_start, window_end, quantity, rate, amount_minor, currency, created_at
  )
  SELECT
    gen_random_uuid(), d.subject_id, d.id, 'elapsed_minutes',
    d.last_billed_at,
    d.last_billed_at + (d.minutes * interval '1 minute'),
    d.minutes,
    d.rate_minor_per_minute,
    d.minutes * d.rate_minor_per_minute,
    d.currency,
    now()
  FROM due d
  WHERE d.minutes > 0
  -- Makes the whole batch replayable: a driver that retries after an ambiguous
  -- failure cannot double-charge a window it already wrote.
  ON CONFLICT (item_id, window_start) DO NOTHING;

  -- Ledger: two legs, summing to zero, referencing the charge.
  INSERT INTO billing.ledger_entries (transaction_id, account_id, amount_minor, source_kind, source_id, leg)
  SELECT c.id, acct.debit_id,  -c.amount_minor, 'charge', c.id, 'debit'  FROM new_charges c JOIN ...
  UNION ALL
  SELECT c.id, acct.credit_id,  c.amount_minor, 'charge', c.id, 'credit' FROM new_charges c JOIN ...;

  -- Advance on the grid, never to now(). Adding the settled minutes keeps
  -- intervals contiguous and preserves the sub-minute remainder; setting
  -- last_billed_at = now() would silently discard it every single run.
  UPDATE billing.billable_items r
     SET last_billed_at = r.last_billed_at + (d.minutes * interval '1 minute')
    FROM due d
   WHERE r.id = d.id AND d.minutes > 0;

  -- Balance guard. A bounded one-interval overdraft is accepted; not billing
  -- for consumed time is not.
  UPDATE billing.billable_items r
     SET status = 'suspended', suspended_at = now()
    FROM billing.ledger_accounts a
   WHERE r.subject_id = a.subject_id
     AND a.kind = 'customer_balance'
     AND a.balance_minor < 0
     AND r.status = 'active'
     AND r.id IN (SELECT id FROM due);

  RETURN QUERY SELECT ...;
END;
$$;
```

### 5.4 The driver

```ts
/**
 * Loop until drained. Each iteration is its own transaction — that is the
 * entire point of the batch bound, and calling meter_batch once per cron tick
 * would reintroduce the O(downtime) recovery the bound exists to remove.
 */
export const drain = async (opts: DrainOptions): Promise<DrainReport> => {
  // Not for correctness — SKIP LOCKED already handles concurrency. This stops
  // a slow run and a five-minute cron from stacking fifty overlapping drains
  // during an incident, which is how a recovery turns into an outage.
  const held = await db.query(`SELECT pg_try_advisory_lock(hashtext('billing-kit:meter'))`);
  if (!held) return { status: 'skipped', reason: 'lock_held' };

  const deadline = Date.now() + opts.deadlineMs;   // bounded wall clock
  let iterations = 0;

  try {
    while (Date.now() < deadline && iterations < opts.maxIterations) {
      const r = await db.transaction((tx) => tx.query(`SELECT * FROM billing.meter_batch($1, $2)`, [...]));
      iterations++;
      // A short batch means the queue drained. Anything else and we go again.
      if (r.itemsBilled < opts.batch) return { status: 'drained', iterations, ... };
    }
    // Hit a bound with work outstanding. Not an error — the next tick continues
    // from exactly where this one stopped, because progress is durable per
    // batch. But it must be reported, because a drain that never drains is the
    // signal that batch size or cron frequency is wrong.
    return { status: 'bounded', iterations, ... };
  } catch (err) {
    // Written from here, outside the aborted transaction. A metrics row
    // inserted inside a PL/pgSQL EXCEPTION handler that then RAISEs is rolled
    // back with everything else, so the one run you needed a record of leaves
    // none.
    await recordFailure(err, iterations);
    throw err;
  } finally {
    await db.query(`SELECT pg_advisory_unlock(hashtext('billing-kit:meter'))`);
  }
};
```

The database clock is authoritative. `now()` in the batch, never the app
server's `Date.now()`, for anything that becomes an interval boundary. Skewed or
drifting app servers otherwise produce overlapping or gapped intervals, and both
are unrecoverable after the fact. The injected `clock` in §7 is for the driver's
own timeouts and for tests, and never for a boundary.

---

## 6. Partitioning and retention

### 6.1 What is partitioned

| Table | Partition | Default granularity |
|---|---|---|
| `usage_events` | RANGE on `occurred_at` | monthly; daily above ~50M rows/month |
| `charges` | RANGE on `window_start` | monthly |
| `ledger_entries` | RANGE on `posted_at` | monthly |
| `usage_aggregates` | not partitioned | bounded by subjects × metrics × windows |
| `provider_events` | RANGE on `received_at` | monthly |

### 6.2 The Prisma trap, named

A partitioned parent's primary key **must** include the partition key, so it is
`PRIMARY KEY (id, occurred_at)`, not `id`. Prisma can express neither
`PARTITION BY` nor that composite intent cleanly, and `prisma db push` will
happily produce a plain unpartitioned table with a single-column key. Nothing
fails. Nothing warns. You find out at a hundred million rows.

This is precisely the failure mode `ai_member` documents for its generated
`tsvector` columns and HNSW indexes, and it takes the same remedy, deliberately
copied because it is proven in-house:

- Prisma owns the columns and relations.
- A post-push script owns what Prisma cannot express: `PARTITION BY`, the
  composite keys, BRIN indexes, the seal trigger, `billing.meter_batch`.
- The script has a `--check` mode that reports what actually exists in the
  database, and the health endpoint fails when it disagrees.

It is not optional, for the same reason it is not optional there.

### 6.3 Creating partitions ahead

`billing.ensure_partitions(months_ahead integer)` runs from the same driver as
`drain`, every run. It is idempotent.

Partitions are created **ahead**, never lazily on an insert failure. A missing
partition makes every insert into that range fail, which for `usage_events`
means dropping billable usage on the floor. Verified by the health check, so a
missing partition is an alert three weeks early rather than an incident at
midnight on the first.

### 6.4 Indexes

Within a partition:

- `BRIN` on the time column. The table is append-only and therefore naturally
  clustered by time; BRIN is a few kilobytes where a btree is gigabytes.
- `BTREE (subject_id, occurred_at)` for the aggregation scan.
- `UNIQUE (tenant_id, source, external_id)` for ingest dedupe. This is the
  expensive one and it is the price of idempotency.

Aggregation windows align to partition boundaries where the granularity allows,
so a window's scan prunes to one partition.

### 6.5 Retention

| Table | Default | Rationale |
|---|---|---|
| `usage_events` | 90 days | Raw, high-volume, and fully summarised by aggregates. |
| `provider_events` | 180 days | Long enough to reconstruct a disputed webhook sequence. |
| `usage_aggregates` | 7 years | The evidence behind a line on an invoice. |
| `charges` | **never** | Financial record. |
| `ledger_entries` | **never** | Financial record. |

Expiry is `DETACH PARTITION CONCURRENTLY`, then export, then `DROP`. Never
`DELETE`. A `DELETE` of a hundred million rows writes a hundred million rows of
WAL, bloats the table until autovacuum catches up, and takes a lock for the
duration; dropping a detached partition is a catalog operation that returns
immediately.

Export target is pluggable and defaults to none — billing-kit will not silently
ship your usage data anywhere. If no exporter is configured, expiry **stops** at
detach and leaves the partition on disk with a warning, rather than dropping
data on the assumption it was wanted elsewhere.

There is no retention policy for `charges` or `ledger_entries` because there is
no supported way to delete them. Erasure requests are served by redacting
`subject` PII in the subject table, which the ledger references by id.

---

## 7. Public API surface

### 7.1 Rules

1. **No middleware is exported.** Middleware is a framework's shape, and there
   are two frameworks to serve. Functions in, plain data out.
2. **No global singleton, no `process.env` read inside the library.** A library
   that reads the environment cannot be instantiated twice in one process —
   which is exactly what a test suite and a multi-region worker both need.
   Configuration is an argument.
3. **No Prisma requirement at runtime.** Prisma defines and migrates the schema
   because it is the house tool. The engine is raw SQL, so the runtime accepts a
   narrow executor and a bare `pg.Pool` satisfies it. Forcing Prisma on every
   adopter is a tax the design does not need to charge.
4. **Typed errors.** A discriminated union, never a message string.

### 7.2 Construction

```ts
export interface SqlExecutor {
  query<T>(text: string, params?: readonly unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

const billing = createBilling({
  db,                        // SqlExecutor — pg.Pool adapter or Prisma adapter
  provider,                  // BillingProvider
  currencies: ['USD', 'EUR'],
  clock: () => new Date(),   // driver timeouts and tests only, never a boundary
  logger,
});
```

### 7.3 Namespaces

```ts
billing.usage.record(event)             // one, idempotent on external_id
billing.usage.recordMany(events)        // COPY-backed, same dedupe
billing.usage.query({ subject, metric, window })

billing.meter.batch({ batch, maxMinutes })
billing.meter.drain({ batch, deadlineMs, maxIterations })
billing.meter.ensurePartitions({ monthsAhead })

billing.periods.aggregate({ subject, window })
billing.periods.seal({ subject, window })
billing.periods.settle({ subject, window })   // picks the mode from capabilities
billing.periods.list({ subject })

billing.ledger.balance({ subject, account })
billing.ledger.entries({ subject, since, until, cursor })
billing.ledger.post(entry)                     // append only; no update, no delete

billing.customers.ensure(ref)
billing.subscriptions.ensure(input)
billing.subscriptions.cancel(id, at)

billing.webhooks.handle({ rawBody, headers })  // → { status, body, event }
billing.health()                               // schema, partitions, drift
```

Every method returns plain data. Nothing returns a framework `Response`, a
stream, or a class the caller must import to use.

### 7.4 Webhooks in both frameworks

`handle` takes bytes and returns `{ status: number; body: unknown }`. The bytes
requirement is the whole integration risk, so both adapters exist and both are
about ten lines.

```ts
// Express. express.raw, NOT express.json.
//
// express.json parses and discards the original bytes. Re-serialising to verify
// changes key order and whitespace, the HMAC no longer matches, and every
// webhook fails signature verification with no clue why. This mounts before any
// global json parser.
app.post('/webhooks/billing', express.raw({ type: '*/*' }), async (req, res) => {
  const r = await billing.webhooks.handle({
    rawBody: req.body,                 // Buffer, untouched
    headers: req.headers as Record<string, string>,
  });
  res.status(r.status).json(r.body);
});
```

```ts
// Next.js App Router. arrayBuffer(), not json().
export async function POST(req: Request) {
  const r = await billing.webhooks.handle({
    rawBody: new Uint8Array(await req.arrayBuffer()),
    headers: Object.fromEntries(req.headers),
  });
  return Response.json(r.body, { status: r.status });
}
```

Pages Router additionally needs `export const config = { api: { bodyParser: false } }`.
Both adapters ship with a test that asserts verification fails when the body has
been through `JSON.parse`/`JSON.stringify`, so the mistake is caught in CI
rather than in production.

### 7.5 Anti-patterns the surface makes impossible

Three defects were found in the reference application's route glue — not in its
engine — and the API is shaped so their equivalents do not compile or do not
exist:

- **Crediting a balance from a request body with no processor call.** There is
  no `credit(amount)`. Cash posts to the ledger only from a verified
  `payment.succeeded` webhook, and the posting function is internal to the
  webhook path.
- **A cron endpoint whose shared-secret check is commented out.** billing-kit
  exports no HTTP endpoint at all, so there is nothing to comment out. `drain`
  is a function; how it is triggered and authenticated belongs to the host, and
  the docs say so instead of shipping an endpoint that looks safe.
- **Passing a client-supplied provider customer id into a portal call (IDOR).**
  Every method takes *our* subject id. `providerCustomerId` is resolved
  internally from the subject and never appears in a public parameter. The type
  system is the enforcement.

### 7.6 Schema namespace

Everything lives in a `billing` Postgres schema, so billing-kit's tables cannot
collide with a host application's and a `search_path` change cannot make them
ambiguous. It also gives the open-core/hosted sync seam a clean boundary: the
billing schema is the library's, identical in both, and never a merge conflict.

---

## 8. Provenance

Nothing in this design is copied from `brett_ai`. Chain of title there is
unresolved, and this document was written from **documented behaviour** —
observed, described in prose, and reimplemented from the description.

Specifically inherited as *ideas*, and re-derived here:

| Idea | Where observed | What was taken |
|---|---|---|
| Set-based billing pipeline | `bill_resources_per_min.sql` | The approach. Restructured into explicit statements in §5.3. |
| `FOR UPDATE SKIP LOCKED` for concurrent workers | same | Standard Postgres queue pattern; requirement, not code. |
| Emitting run metrics | same | The requirement, plus the fix that they survive a failure. |
| Monthly partitioning of charges | `init_billing.sql` index naming | Generalised in §6. |
| Post-push script for what Prisma cannot express | `ai_member/scripts/index-db.ts` | The pattern and its `--check` mode, deliberately reused. |

Two discrepancies observed in the reference, recorded because they inform §3 and
§6 and because the owner should know:

1. `prisma/schema.prisma` declares the money columns as `Float` — Postgres
   `double precision` — while `prisma/scripts/init_billing.sql` declares the
   same tables with `NUMERIC(12,6)`. `bill_resources_per_min.sql` casts to
   `NUMERIC` in its locals and return type, but the columns it reads are
   whichever DDL actually ran. `BillingAccount.balance` appears only in the
   Prisma schema and is therefore `double precision` in any deployment.
2. The two DDLs disagree on identifier case: `init_billing.sql` creates
   `user_id`, `price_per_minute`, `last_billed_at`; the Prisma schema and the
   billing function both use quoted `"userId"`, `"pricePerMinute"`,
   `"lastBilledAt"`. Only one of the two can be the deployed shape.

Neither is a criticism of the engine's design, which is sound. Both are reasons
§3 fixes the storage type in one place and §6.2 refuses to let Prisma be the
only source of DDL truth.

If any code is later found to have been carried over rather than re-derived, it
is a defect in this repository and must be removed before release.

---

## 9. Open questions

- **Tier semantics.** Tiers are `regular`, `elite`, `pro`, `enterprise`; prices
  are unset. Whether a tier is an entitlement bundle (billing-kit holds only the
  key) or a priced plan (billing-kit holds the price) determines whether
  entitlements live here or in `ai_member_cloud`. Current lean: entitlements are
  the host's, billing-kit holds only the plan key and the prices attached to it.
- **Multi-currency subjects.** A subject with balances in two currencies needs
  one ledger account per currency and a stated policy on cross-currency
  settlement. Deferred until a real requirement exists; the schema already keys
  accounts by currency so it is additive.
- **Provider migration.** Moving a live customer base between providers is the
  strongest argument for owning the ledger, and it deserves its own document.
- **Proration.** Mid-period plan changes have three defensible answers. Pick one
  before the first paying customer, not after.
