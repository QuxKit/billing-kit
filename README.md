# @quxkit/billing-kit

<img src="https://raw.githubusercontent.com/QuxKit/quxkit-brand/main/billing-kit/sizes/billing-kit-128.png" width="76" align="right" alt="">

**QuxKit** · blue stone · usage-based billing

![status](https://img.shields.io/badge/status-shipped-2ea043) ![licence](https://img.shields.io/badge/licence-Apache--2.0-4f83f6) ![npm](https://img.shields.io/badge/npm-%40quxkit%2Fbilling--kit-cb3837)

Usage-based billing as a library, over a provider you choose.

```
   your app
      │ record usage
      ▼
 ┌─────────────────────────────────────────────────────────────┐
 │  usage_events ──aggregate──▶ aggregates ──price──▶ charges  │
 │                                                        │    │
 │                                                      post   │
 │                                                        ▼    │
 │                        ledger — append-only, double-entry   │
 └─────────────────────────────────────────────────────────────┘
   @quxkit/billing-kit — Apache-2.0        │            ▲
                                    settle │            │ payment
                                    period ▼            │ or refund
                                  ┌──────────────────────────┐
                                  │  invoice + capture       │
                                  │  webhook                 │
                                  │  Stripe · Paddle · Lago  │
                                  └──────────────────────────┘

 billing-kit owns everything left of `settle`. The provider owns
 everything right of it.
```

_Rendered diagrams (mermaid): [docs/DIAGRAMS.md](https://github.com/QuxKit/billing-kit/blob/main/docs/DIAGRAMS.md)._

billing-kit owns everything left of `settle` — the framed boxes. The provider owns
everything right of it. That line is the whole design, and it sits there because
it is the only place Stripe, Paddle and Lago agree on what an operation means.

Apache-2.0, so that both an AGPL open core and a commercial hosted service can
depend on it.

## The problem it solves

Usage-based billing usually arrives in one of two shapes, and both put the logic
somewhere you don't control:

- **A hosted platform** — Metronome, Orb, Stripe Billing — that meters and
  invoices for you, and takes a **percentage of revenue you already earned**.
- **A service you deploy** — Lago, OpenMeter, Kill Bill — that you stand up and
  operate as a **separate system**, with its own database, API and failure modes.

billing-kit is a third shape: **a library you embed.** You `import` metering,
pricing and a double-entry ledger into the app you already run, riding on the
payment provider you already use (Stripe, Paddle). No cut of your revenue, and no
second service to operate.

|  | What it costs you | Where your billing logic lives |
|---|---|---|
| Hosted platform | a % of billed revenue, forever | their servers |
| OSS platform | ops: a service to run | a separate system you operate |
| **billing-kit** | **a dependency** | **in-process, your tables** |

What owning it in-process buys you:

- **No platform tax.** The pricing tables and the financial record are *your*
  tables — nobody takes a cut to compute a number.
- **Answerable numbers.** Integer minor units, the ISO 4217 exponent table and an
  append-only double-entry ledger make every amount re-derivable: you can answer
  *"why is this number"* offline, from your own data, at any time.
- **A dependency, not infrastructure.** No container, no second Postgres+API to
  stand up. It compiles into your service.

It is not the first open-source billing project, and it does not try to be a
platform. It is billing as a small, correct, embeddable dependency — the thing
missing between *rent it and pay a percentage* and *deploy and operate a second
system*. Everything below is how it earns the word "correct."

## Status

| Module | Entry point | State |
|---|---|---|
| Money types, shared vocabulary | `billing-kit` | ✅ implemented, tested |
| Usage ingest + idempotency | `billing-kit` | ✅ implemented, tested |
| Double-entry ledger | `billing-kit` | ✅ implemented, tested |
| Metering engine | `billing-kit/metering` | ✅ implemented, tested |
| Usage aggregation — sum / count / max / unique | `billing-kit` | ✅ implemented, tested |
| Tiered pricing — volume / graduated | `billing-kit` | ✅ implemented, tested |
| Subscriptions — plans, seats, overage, proration, trials | `billing-kit/subscriptions` | ✅ implemented, tested |
| Coupons / discounts | `billing-kit/subscriptions` | ✅ implemented, tested |
| Credit notes, prepaid wallets | `billing-kit` | ✅ implemented, tested |
| Provider adapters — Stripe, Paddle | `billing-kit/providers` | ✅ implemented, tested |

Metering, subscriptions and providers are **separate entry points**, not
re-exports from the root, so an application using one does not compile the
others. Import `billing-kit/metering` for the batch driver,
`billing-kit/subscriptions` for recurring plans, and `billing-kit/providers` for
the adapter interface and its two implementations.

The ledger and money tests run against a real Postgres. `pnpm run test:unit` is
green, and so is `pnpm run test:adversarial` — the suite of probes that used to
name four open defects. They are kept, and what each one probes is worth reading
before building anything that depends on a replay being safe:

| | What it caught | Where the fix lives |
|---|---|---|
| **A2** | A replay carrying a *different* quantity was reported as a duplicate: 10 billed where 1,000,000 was sent, reported as success | `record()` refuses with `idempotency_conflict` |
| **A4** | A ledger replay with different legs returned the old transaction and discarded the correction, with no error and nothing to follow | `post()` refuses the same way |
| **A5** | A late payment webhook could not be posted at all — no partition, no default | partition routing, see below |
| **A8** | `allocate()` was documented as largest-remainder and handed leftovers out from index 0, so a 1% share could take a penny from a 97% share | largest remainder, ties by index |

A2 and A4 were the ones that mattered for money, and the fix for both is to
**refuse rather than choose**. Keeping the stored value discards a correction;
overwriting it lets a stale retry clobber one. Nothing inside the call can tell
those apart, so the caller is told. `idempotency_conflict` was already in the
error union, described and never raised — the contract had been written and not
implemented.

## What it does itself, and will not delegate

| | Why it cannot be delegated |
|---|---|
| Metering — accepting and deduplicating usage events | The event rate is your traffic's rate, not a provider's API budget. |
| Aggregation — events to billable quantities | Two of the three providers cannot do it, and the one that can is not always the one you ship with. |
| Pricing — quantities to amounts | You have to be able to answer "why is this number" from your own tables, offline, at any time. |
| The ledger — append-only, double-entry | It is the financial record. It has to survive changing providers. |
| Idempotency | Every provider's idempotency window is finite and shorter than your incident. |

The provider does customers, settlement of a closed period, payment capture,
refunds, and webhook signature verification. Recurring plans — what a period
costs, from a base fee, seats, an included allowance and metered overage — are
billing-kit's own (`billing-kit/subscriptions`), because that is billing logic
you must be able to answer for; the provider still captures the money.

billing-kit is not a tax engine, a dunning system, a pricing UI, an accounting
system, or a payment processor. It has interfaces where those attach and no
opinions inside them.

It is also not a tenancy system. Every ingest row carries a `tenantId`, and
this library never verifies one — by design, it cannot. What billing-kit
assumes about that field, and the sibling library
([tenant-kit](https://github.com/QuxKit/tenant-kit)) that makes the
assumption true — request→tenant resolution, memberships, row-level-security
isolation over these very tables — is
[docs/MULTI_TENANCY.md](docs/MULTI_TENANCY.md).

## Money

The rule, which the type system enforces rather than the documentation:

> Amounts are integer minor units in a `bigint`.
> Rates and quantities are exact decimals with a declared scale.
> **A rate is in minor units per unit** — cents, not dollars.
> Neither is ever a JavaScript `number`.

```ts
import { Money, Quantity, Rate, price } from '@quxkit/billing-kit';

const q = Quantity.fromDecimalString('1234567');      // tokens
const r = Rate.fromDecimalString('0.00012');          // cents per token ($0.0000012)
const { amount, exactMinor, residueMinor } = price(q, r, 'USD');

amount.toDecimalString();  // "1.48"
exactMinor;                // "148.148040000000000000000000"  — minor units, unrounded
residueMinor;              // "0.148040000000000000000000"    — what rounding dropped
```

The rate is in minor units on purpose, and both layers read it that way: the
SQL metering charge is `round(quantity * rate)` with no major→minor scaling, and
`price()` matches it exactly. A rate in dollars would price 100× high in USD in
one layer and not the other — the same literal meaning two different amounts.

There is no constructor taking a `number`, no `fromFloat`, and no convenience
overload. Once a value has been through a double there is no way to tell an
exact 19.99 from a 19.99 that has already drifted, so the type refuses the
ambiguity instead of documenting it.

The argument against float is not magnitude. Doubles hold integers exactly up to
about ninety trillion dollars in cents. It is that **`SUM(double precision)` in
Postgres is not associative** — the planner may reorder a parallel aggregate, so
the same rows can produce different totals on different plans. A balance that
depends on the query plan cannot be re-derived, and re-derivability is the only
thing that makes an audit possible.

The currency exponent is never assumed. `* 100` is wrong for JPY (0), KWD (3)
and CLF (4), among others; billing-kit ships the ISO 4217 table and refuses a
currency not in it.

Rounding happens in exactly one place: `price`, half-to-even, with the
pre-rounding value kept. Not at the event, where the error grows with row count.
Not at the invoice, where the ledger and the invoice then disagree by the
residue with no row explaining the gap.

Wire format everywhere is `{ "amount": "1999", "currency": "USD" }` — a string,
in minor units. A decimal string would re-raise the question of how many places
the currency has, which the currency tag already answers.

## Ingest

```ts
import { createBilling, Quantity } from '@quxkit/billing-kit';

const billing = createBilling({ db });   // once, at startup

const result = await billing.record({
  tenantId: 'acme',
  subjectId: 'user_123',
  source: 'api',
  externalId: req.id,          // yours, not ours: a value we generate cannot
  metric: 'tokens.input',      // deduplicate a retry, because the retry would
  quantity: Quantity.fromBigInt(1234n),   // generate a second one
  occurredAt: new Date(),
});

result.deduplicated;  // true on a replay. Answer 200, never 409.
```

`createBilling` binds the executor and the clock so neither is repeated per
call. It is a factory rather than a module-level singleton: two instances in one
process is the case that matters — a test suite with a rolled-back executor per
case, a worker spanning regions, a tenant on its own database — and a module
holding the connection serves exactly one of them. Configuration stays an
argument; nothing here reads `process.env`.

The free functions are still exported and still take `(db, …, now)`, for code
that holds a transaction or dispatches across shards per call:

```ts
import { record } from '@quxkit/billing-kit';
await record(db, event, new Date());
```

Writes that must not disagree go in one transaction. The instance handed to the
callback is bound to it, so nothing inside can escape onto another connection:

```ts
await billing.transaction(async (tx) => {
  await tx.record(event);        // usage
  await tx.post(accrual);        // and the ledger entry for it
});                              // both, or neither
```

A duplicate is success. A retrying client treats 409 as fatal and either drops
the event or pages someone; the point of an idempotent endpoint is that the
retry is boring.

**A retry is the same request.** The same `externalId` carrying a *different*
quantity or `occurredAt` is refused, with `idempotency_conflict` — the same for
`post()` when the legs differ. It is the one place the rule above is inverted,
and for the reason the rule exists: a different request under a used key is not
a retry, it is a bug in the caller, and answering it "already recorded" reports
success for something that never happened. Keeping the stored value discards a
correction; overwriting it lets a stale retry clobber one. Neither is
recoverable and neither leaves a trace, so the caller is told instead.

`metadata` is not compared — a trace id legitimately differs across a retry.
Only what determines the bill is.

`occurredAt` is the caller's and is the partition key. `receivedAt` is the
database's. Both are kept, because the gap between them is how lateness is
measured, and lateness is what decides when a window can be sealed.

## Aggregation

Events collapse to one billable quantity per window, four ways — the same set a
metered plan chooses from:

```ts
import { aggregateUsage } from '@quxkit/billing-kit';

const { quantity } = await aggregateUsage(db, {
  tenantId: 'acme', subjectId: 'user_123', metric: 'api.calls',
  window: { start, end }, method: 'sum',   // 'sum' | 'count' | 'max' | 'unique'
  // uniqueBy: 'user',                      // for 'unique': the metadata dimension
});
```

- **sum** — total of the quantities (tokens, GB). **count** — how many events,
  quantity ignored (requests, messages). **max** — the peak in the window (seats,
  concurrent workers). **unique** — distinct values of a metadata field (unique
  users), where two events with the same value count once.
- It aggregates **in Postgres**, not by paging rows into the process: a window can
  hold millions of events, and `SUM`/`MAX`/`COUNT(DISTINCT)` over `NUMERIC` are
  exact there. The result is a `Quantity`, never a JS number, so it drops straight
  into `price` or a plan's overage — this is what a subscription's `usageFor` wires
  to.

## Ledger

Double-entry, append-only. Positive is a debit, negative is a credit, and the
legs of a transaction sum to zero per currency.

```
 charge chg_1                      two legs, sum to zero
   customer_balance     +19.99     debit
   revenue_accrued      −19.99     credit
                        ────────
                          0.00  ✓

 payment webhook pay_9             two legs, sum to zero
   cash                 +19.99     debit
   customer_balance     −19.99     credit
                        ────────
                          0.00  ✓

 customer_balance = +19.99 − 19.99 = 0
 the charge is settled, and every row is still there
```

Cash reaches the ledger only from a verified payment webhook — there is no
`credit(subject, amount)`. A charge accrues revenue and raises the customer's
balance; the payment clears it. Nothing is ever updated or deleted, so the whole
history is re-derivable at any time.

```ts
import { post, accrualPosting, balance } from '@quxkit/billing-kit';

await post(db, accrualPosting({
  tenantId: 'acme',
  subjectId: 'user_123',
  chargeId: 'chg_1',
  amount: Money.fromDecimalString('19.99', 'USD'),
}), new Date());

await balance(db, {
  tenantId: 'acme', subjectId: 'user_123',
  account: 'customer_balance', currency: 'USD',
});
```

Three properties, each enforced rather than documented:

- **Append-only.** No update, no delete, no API for either, and a trigger on
  every partition that raises if someone tries it in psql.
- **Balanced.** Checked before the write, and again by a deferred constraint
  trigger at `COMMIT` — deferred because the legs go in one statement at a time
  and the transaction is unbalanced in between by construction.
- **Idempotent.** `(tenantId, sourceKind, sourceId)` is the natural key, so
  replaying a posting writes nothing the second time.

There is deliberately no `credit(subject, amount)`. Cash reaches the ledger from
a verified payment webhook and from nowhere else.

Settlement carries the estimate/authority split: under `quantity` settlement, or
with a merchant-of-record provider, the provider's number is authoritative and
ours was an estimate. The difference posts to `settlement_variance`, where a
non-zero balance is an alert. It is never absorbed into revenue.

## Subscriptions

Recurring plans, priced on our side of the settle line. A plan is defined in
code — a base fee, optional seats, an included allowance and metered overage
(flat or tiered) — and `chargeForPeriod` turns a period's usage into a set of
lines that sum to a total. It is pure: no database, so it can be tested and
shown to a customer as a preview.

```ts
import { Money, Quantity, Rate } from '@quxkit/billing-kit';
import { definePlan, chargeForPeriod } from '@quxkit/billing-kit/subscriptions';

const pro = definePlan({
  id: 'pro', currency: 'USD', interval: 'month',
  flat: Money.fromDecimalString('49.00', 'USD'),
  seats: { unit: Money.fromDecimalString('10.00', 'USD'), min: 1 },
  usage: [{
    metric: 'tokens.input',
    included: Quantity.fromBigInt(1_000_000n),
    price: { kind: 'flat', rate: Rate.fromDecimalString('0.00012') },
  }],
  trialDays: 14,
});

chargeForPeriod(pro, { seats: 3, usage: { 'tokens.input': Quantity.fromBigInt(1_500_000n) } }).total;
// 49.00 base + 30.00 seats + 0.60 overage = 79.60 USD
```

`chargeSubscriptionPeriod(db, …)` is the stateful half: it posts the total to
the ledger as an accrual, records the period, and advances the subscription —
all idempotent, so a replayed webhook charges once. The base and seat fees
prorate for a partial period; usage never does. During a trial the base and
seats are waived and usage is still priced. Capture stays with the provider:
nothing here credits a balance except a verified payment.

Overage can be **tiered** — `priceTiered(quantity, tiers, 'volume' | 'graduated',
currency)` — and it rounds in the one place `price` does: the exact total across
every tier is accumulated first and rounded once, never tier by tier.

**Triggering it on time.** billing-kit ships the sweep — `chargeDueSubscriptions`,
which finds every subscription whose period has ended and charges each — but no
scheduler and no endpoint, for the same reason metering's `drain` is a function:
*when* to fire, and how to authenticate the firing, belong to the host. Point a
cron (in this stack, `ezy_cron`) at an authenticated endpoint that calls the
sweep. It is idempotent, so an overlapping or over-frequent fire charges each
period exactly once.

```ts
import { chargeDueSubscriptions } from '@quxkit/billing-kit/subscriptions';

// inside an authenticated POST /cron/charge-due:
const report = await chargeDueSubscriptions(db, {
  plan: (id) => PLANS[id],                              // your code catalogue
  usageFor: (sub, period) => meterUsage(db, sub, period), // omit for flat plans
});                                                     // { swept, charged, skipped, errors }
```

## Discounts, credit notes and wallets

Three modifiers that stay true to the ledger — a discount lowers a charge before
it is posted, a credit note and a wallet are postings in their own right.

- **Discounts / coupons** (`billing-kit/subscriptions`) — `applyDiscount(amount,
  rule)` takes a percentage (basis points, never a float) or a fixed amount off,
  clamped so a coupon can never make a bill negative. Pass one to
  `chargeForPeriod` and it becomes a negative line that nets the total.
  `discountForPeriod(coupon, n)` turns a "20% off for three months" coupon into
  the rule for period *n*, or nothing once it has run out.
- **Credit notes** — `creditNotePosting(...)` is the mirror of an accrual: it
  lowers the customer's balance and reverses the revenue, as a *new* posting.
  A mistake becomes a second row, never an edit of the first, so the statement
  reads "charged X, credited Y" and both are auditable.
- **Prepaid wallets** — `customer_credit` is a liability account: `walletTopupPosting`
  turns a verified payment into credit (never a `topUp()` callable from a request
  body), `walletRedeemPosting` draws it down against a charge, and `walletBalance`
  reports what is left, positive. Prepaid money is money you may owe back, so it
  is never counted as revenue.

## Database

```ts
export interface SqlExecutor {
  query<T>(text: string, params?: readonly unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}
```

That is the whole database dependency. Prisma is the house tool for schema and
migrations, but the engine is raw SQL, so the runtime takes a narrow executor
and a bare `pg.Pool` satisfies it. `test/pg-executor.ts` is that adapter, and it
is about thirty lines including the transaction pinning.

Apply `sql/001_core.sql`, then create partitions ahead:

```sql
SELECT billing.ensure_core_partitions(3);
```

Everything lives in a `billing` schema so it cannot collide with a host
application's tables. Partitions are created ahead, never lazily on an insert
failure: a missing partition makes every insert into that range fail, which for
`usage_events` means billable usage on the floor.

Two things in that file exist because Prisma cannot express them, and `db push`
produces a plausible wrong answer for both — a partitioned parent's primary key
must include the partition key, and `PARTITION BY` has no Prisma equivalent at
all. Nothing fails and nothing warns; you find out at a hundred million rows.

## CLI

Applying the SQL by hand means finding five files and running them in the right
order, again after every upgrade. `npx billing-kit` does it and records what it
did.

```
npx billing-kit init       # write billing.config.ts (or .js) here
npx billing-kit migrate    # apply pending files, in order, once each
npx billing-kit status     # what is applied, what is pending
```

```
database    postgresql://localhost:5432/app
migrations  /app/node_modules/billing-kit/sql (5)

  applied   001_core.sql     2026-08-13T01:04:42.236Z
  pending   010_metering.sql

1 applied, 1 pending
```

`migrate` records each file in `billing.schema_migrations` with a sha256 of its
bytes, and each file is applied inside its own transaction, so a failure leaves
neither half a schema nor a row claiming otherwise. Re-running applies nothing.

If a file that has already been applied has *changed* on disk, `migrate` refuses
and names it. Every migration tool without a checksum silently skips that file
instead, which is how a database and the repository that produced it stop
agreeing with nobody finding out. Resolving it is a decision — record the new
checksum, or revert the file and write a new migration — and the tool will not
make it for you. `status` reports the same condition and exits non-zero, so it
can gate a deploy.

`--dry-run` prints the plan and writes nothing, not even the tracking table.
`--config <path>`, `--database-url <url>` and `--migrations <dir>` override the
config file for one invocation.

Three things worth knowing:

- **`init` runs only when you type it.** There is no install hook, and there
  will not be one. An existing config is never overwritten.
- **The config file is read by the CLI and by nothing else.** The library still
  takes configuration as arguments and still reads no environment — the config
  lives in `cli/`, which nothing under `src/` imports and no `exports` entry
  reaches. The config file reads `process.env.DATABASE_URL` on your behalf,
  because it is your module and it runs when you run it.
- **`pg` is an optional peer dependency.** The library stays driver-agnostic and
  installs no driver; the CLI needs one to open a socket, loads it dynamically,
  and tells you what to install if it is absent.

All five shipped files apply in one run. `001_core.sql` and `010_metering.sql`
used to declare `billing.ledger_entries` in two incompatible shapes, and `010`
raised rather than let the second definition be silently ignored, so `migrate`
over the shipped set halted after the first file. `001_core`'s shape won — it is
the one `LedgerEntry` in `src/types.ts` describes — and the metering engine was
migrated onto it.

`001_core.sql` also calls `billing.ensure_core_partitions()` at the end, so the
schema can take a row the moment it exists. Without that the file defined the
function and never ran it, and a freshly migrated database had no partitions at
all: every insert failed with *no partition of relation* until somebody knew to
call it by hand.

## Design rules

1. No middleware is exported. Middleware is a framework's shape and there are
   two frameworks to serve. Functions in, plain data out.
2. No global singleton and no `process.env` read inside the library. A library
   that reads the environment cannot be instantiated twice in one process, which
   is what a test suite and a multi-region worker both need.
3. No Prisma at runtime.
4. Typed errors. `BillingError` carries a discriminated union; the message is
   generated from it and is never parsed.
5. No branch reads `provider.name`. Every branch reads `capabilities`. That rule
   is what keeps a fourth provider from being a rewrite, and it is checkable in
   review by grepping for the string.

## Development

```
pnpm install
pnpm typecheck
pnpm run test:unit         # the shipped suite
pnpm run test:adversarial  # the probes that found A2/A4/A5/A8 — keep them green
pnpm build                 # dist/, ESM + CJS + declarations
pnpm run test:pack         # packs, installs the tarball, drives it with plain node
```

`test:pack` is the only check that says anything about what a consumer gets. It
runs `npm pack`, installs the tarball into a temporary directory sharing no
`node_modules` with this repo, and imports it from both ESM and CJS with no
loader — because an `exports` map is not code anyone runs, and the only way to
know it is right is to resolve against it from outside.

The money tests are pure and always run. The ingest and ledger tests need a
Postgres, and skip with a message when there is not one:

```
createdb billing_kit_test
pnpm test
```

Point them elsewhere with `BILLING_KIT_TEST_DATABASE_URL`. They run against a
real database rather than a mock because the behaviour worth testing — what
`ON CONFLICT DO UPDATE` does under a concurrent transaction, whether a deferred
trigger fires at the right moment, whether a partitioned table routes a row — is
in Postgres, not in the TypeScript. A mock would only confirm that we send the
SQL we decided to send.


## The QuxKit family

Libraries you embed, not services you operate. Each kit owns one narrow thing
and composes with the rest over shared shapes — one executor interface, one
opaque tenant id, one Money type.

| Package | Stone | What it owns |
|---|---|---|
| [`@quxkit/identity-kit`](https://github.com/QuxKit/identity-kit) | gold | Accounts, argon2id credentials, revocable sessions — produces a `UserId`. |
| [`@quxkit/tenant-kit`](https://github.com/QuxKit/tenant-kit) | green | Tenant directory, request→tenant resolution, row-level-security isolation. |
| [`@quxkit/billing-kit`](https://github.com/QuxKit/billing-kit) | blue | Metering, exact pricing, a double-entry ledger, provider settlement. |
| [`@quxkit/billing-kit-adapters`](https://github.com/QuxKit/billing-kit-adapters) | blue | Payment providers beyond Stripe and Paddle. |
| [`tenant-kit-adapters`](https://github.com/QuxKit/tenant-kit-adapters) | green | Enterprise SSO, SCIM provisioning, RBAC-engine bridges. |
| [`billing-kit-components`](https://github.com/QuxKit/billing-kit-components) | blue | shadcn-compatible billing UI, per seat. |
| [`@quxkit/billing-kit-mcp`](https://github.com/QuxKit/billing-kit-mcp) | blue | Exact money math for AI assistants over MCP. |

## Licence

Apache-2.0. See `LICENSE` for the full text and `NOTICE` for attribution.

`PROVENANCE.md` records that this is a fresh implementation and what it was
informed by. Read it before importing anything into this repository.
