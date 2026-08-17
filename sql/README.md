# sql/ — the metering engine

Raw SQL, applied in order. Prisma owns columns and relations; this owns what
Prisma cannot express — `PARTITION BY`, composite primary keys that include a
partition key, BRIN indexes, and the batch function itself (ARCHITECTURE.md
§6.2).

`npx billing-kit migrate` applies a directory of these in order, once each,
tracked in `billing.schema_migrations` and checksummed so an already-applied
file that was edited is refused rather than skipped. Point it at the whole of
`sql/` — every file applies in one run.

They did not, until recently. `001_core.sql` and `010_metering.sql` each
declared `billing.ledger_entries`, in shapes that could not both be right, and
because both used `CREATE TABLE IF NOT EXISTS` the second simply did nothing and
reported success. `010` raised instead of allowing that, so `migrate` halted
after the first file. `001_core`'s shape won — it names an account inline with
`(subject_id, account, currency)`, which is what `LedgerEntry` in `src/types.ts`
describes — and `012_meter_batch.sql` was migrated onto it. `ledger_accounts`
went with it: its only job was to be joined for an `account_id` that no longer
exists, and its cached `balance_minor` was maintained by `meter_batch` alone, so
every payment posted through `src/ledger.ts` desynchronised it silently.

By hand it is one psql per file, in this order, and nothing records that you
did:

```
psql -v ON_ERROR_STOP=1 -d "$DATABASE" -f sql/001_core.sql
psql -v ON_ERROR_STOP=1 -d "$DATABASE" -f sql/010_metering.sql
psql -v ON_ERROR_STOP=1 -d "$DATABASE" -f sql/011_partitions.sql
psql -v ON_ERROR_STOP=1 -d "$DATABASE" -f sql/012_meter_batch.sql
psql -v ON_ERROR_STOP=1 -d "$DATABASE" -f sql/013_runs.sql
psql -v ON_ERROR_STOP=1 -d "$DATABASE" -f sql/020_subscriptions.sql
psql -v ON_ERROR_STOP=1 -d "$DATABASE" -f sql/030_provider_events.sql
psql -v ON_ERROR_STOP=1 -d "$DATABASE" -f sql/031_invoices.sql
psql -d "$DATABASE" -c 'SELECT billing.ensure_partitions()'
```

`001_core.sql` was missing from that list, which is its own small version of the
same problem: the core tables are what everything else references. It calls
`billing.ensure_core_partitions()` itself at the end, so the core tables can
take a row immediately; `ensure_partitions()` above covers the metering tables
`011` adds.

Every file is re-runnable. Run all of them after every `prisma db push` or
`prisma migrate deploy`, for the reason `ai_member/scripts/index-db.ts`
documents for its own generated columns: a push makes the database match the
schema, and none of this is in the schema.

| File | Contents |
|---|---|
| `001_core.sql` | The `billing` schema, `usage_events`, `usage_event_keys`, `ledger_transactions`, `ledger_entries` (partitioned), the balance and append-only triggers, `ensure_core_partitions()`. Everything else references it. |
| `010_metering.sql` | Tables and indexes. `billable_items`, `charges`, `meter_runs`. Not `ledger_entries` and not `ledger_accounts` — see below. |
| `011_partitions.sql` | `ensure_partitions()`, `partition_report()`, `metering_health()`. |
| `012_meter_batch.sql` | `round_half_even()` and `meter_batch()` — the engine. |
| `013_runs.sql` | `claim_meter_run()`, `heartbeat_meter_run()`, `settle_meter_run()` — the drain lease. |
| `020_subscriptions.sql` | `subscriptions` and `subscription_periods` — the recurring-plan half (`billing-kit/subscriptions`). Not partitioned: bounded by customers, not traffic. Needs `001_core` only; the sweep posts each period's charge into its ledger. |
| `031_invoices.sql` | `invoices`, `invoice_lines`, `invoice_counters` (`billing-kit/invoices`), plus `subscription_periods.charge_lines` — the persisted charge breakdown an invoice is built from. Needs `001_core` and `020_subscriptions`. |
| `030_provider_events.sql` | `provider_events` — the webhook replay guard, keyed `(provider, provider_event_id)`. `applyVerifiedEvent` claims a row here and posts into `001_core`'s ledger in the same transaction. Needs `001_core` only. |

**Order matters.** `011` must run before the first charge: `010` declares
`charges` and `ledger_entries` as partitioned with no partitions, and an insert
into a partitioned table with no matching partition fails. That failure is
deliberate and immediate, in preference to a table that is silently not
partitioned and works fine until a hundred million rows.

---

## Partitioning

| Table | Key | Granularity | Retention |
|---|---|---|---|
| `charges` | RANGE `window_start` | monthly + DEFAULT | never — financial record |
| `ledger_entries` | RANGE `posted_at` | monthly + DEFAULT | never — financial record |
| `billable_items` | not partitioned | — | bounded by the active estate |
| `meter_runs` | not partitioned | — | operational; prune freely |

`usage_events` is not here. It belongs to the event-based half of the library
(§6.1); this engine's usage record *is* the charge, because the event being
metered is that a minute passed and there is nothing else to store.

Three decisions worth stating:

**Boundaries are anchored to UTC**, never to the session's `TimeZone`.
`date_trunc('month', now())` evaluates in whatever timezone the connection
carries, so the same statement from two differently-configured pools produces
boundaries an hour or a day apart. Postgres reports that as a `CREATE` failure
months later, on a machine that did nothing wrong.

**Partitions are created ahead and behind.** Behind, because of catch-up: an
item last billed six months ago settles a window whose `window_start` is six
months in the past. A forward-only implementation works perfectly until the
first long outage and then fails on the recovery.

**There is a DEFAULT partition, and it is a trade, not an oversight.** While a
default partition is non-empty, creating the next month's partition must scan it
under `ACCESS EXCLUSIVE`. The trade is only acceptable because it is expected to
stay empty — `billing.metering_health()` reports a non-empty default as a fault,
so it is an alert weeks early rather than a locked table at month end. The
alternative is refusing to record money already owed, which is worse.

There is no expiry function. Retention for both partitioned tables is `never`,
so shipping one would be shipping the mistake. Erasure is served by redacting
subject PII in the subject table, which these reference by id.

---

## Indexes, and the query each one serves

Every index below is justified by a query that exists. An index without one is
write amplification with a comment.

### `billable_items`

| Index | Serves |
|---|---|
| `billable_items_due` on `(last_billed_at) WHERE status='active'` | The due-scan in `meter_batch`: `WHERE status='active' AND last_billed_at <= now() - interval '1 minute' ORDER BY last_billed_at LIMIT n FOR UPDATE SKIP LOCKED`. Partial, so it holds the active set rather than the whole table — a cancelled estate that outgrows the active one is the normal end state of a subscription product. `last_billed_at` leads so the index satisfies the `ORDER BY` and `LIMIT` stops early instead of sorting every due row. |
| `billable_items_subject` on `(tenant_id, subject_id)` | The overdraft guard's per-subject lookup, and "what is this subject paying for". It used to reach the subject through `ledger_accounts`; the guard now sums `ledger_entries` for the subject directly. |

The predicate is written `last_billed_at <= now() - interval '1 minute'` and not
`last_billed_at + interval '1 minute' <= now()`. Same predicate; only the first
can use the index, because an expression on the indexed column is not an index
scan. Verified:

```
Limit -> LockRows -> Index Scan using billable_items_due
           Index Cond: (last_billed_at <= (now() - '00:01:00'::interval))
```

### `charges`

| Index | Serves |
|---|---|
| `charges_item_window` UNIQUE on `(item_id, window_start)` | The anti-double-billing barrier. Row locking stops two workers getting this far; this makes it impossible rather than unlikely, and enforced by the database rather than by the correctness of the function above it. |
| `charges_subject_window` on `(tenant_id, subject_id, window_start)` | Per-subject period aggregation for an invoice. |
| `charges_window_brin` BRIN on `(window_start)` | Whole-month scans: revenue roll-up and reconciliation. BRIN because the table is append-only and therefore naturally clustered by time — kilobytes where a BTREE is gigabytes, and no write amplification on a scan that reads a whole month anyway. |

### `ledger_entries`

| Index | Serves |
|---|---|
This table is declared in `001_core.sql` and nowhere else. The rows below used
to describe `010_metering.sql`'s competing definition — `account_id` into a
`ledger_accounts` row, `leg` constrained to debit/credit — which is the shape
that lost. What exists now:

| Index | Serves |
|---|---|
| `ledger_entries_transaction_idx` on `(transaction_id)` | Reading a transaction's legs back: `entriesOfTransaction` in `src/ledger.ts`, which is also what `post()` compares against when an idempotency key is replayed. |
| `ledger_entries_balance_idx` on `(tenant_id, subject_id, account, currency, posted_at)` INCLUDE `(amount_minor)` | `balance()` and the overdraft guard in `012_meter_batch.sql`, which are the same query: `SUM(amount_minor)` over one account. `amount_minor` is INCLUDEd so the aggregate can be index-only rather than fetching every heap tuple. |

Two indexes from the old shape are **not** carried over, and neither loss is
accidental:

- `ledger_entries_source` UNIQUE on `(source_kind, source_id, leg, …)` was an
  idempotency backstop. `leg` no longer exists, and the guarantee it approximated
  now lives one level up and exactly: `ledger_transactions` is UNIQUE on
  `(tenant_id, source_kind, source_id)`, so a source can claim one transaction,
  and `post()` refuses a replay whose legs differ from the ones recorded.
- `ledger_entries_posted_brin` BRIN on `(posted_at)` served whole-period scans.
  Partition pruning on `posted_at` now does that job — the table is
  `PARTITION BY RANGE (posted_at)`, so a period scan reads the months it needs
  and skips the rest without an index at all.

### `meter_runs`

| Index | Serves |
|---|---|
| `meter_runs_recent` on `(started_at DESC)` | "What have the last N runs done." |
| `meter_runs_in_flight` on `(heartbeat_at) WHERE status='running'` | The drain lease check and the stuck-run alert. Partial, so it stays the size of the running set however long the history grows. |

---

## Where this departs from ARCHITECTURE.md §5

The spec was followed except in four places, each of which is commented at the
site with the reasoning. Recorded here so the differences are reviewable
together rather than discovered one at a time.

1. **No `ON CONFLICT DO NOTHING` on the charge insert** (§5.3 has it). It would
   silently drop the charge while the same transaction has already advanced the
   grid past that window — clock forward, money not billed, and the row that
   would have said so is the row that was skipped. The replay safety it was
   there to provide is already provided by the compare-and-set on
   `last_billed_at`: a replayed batch reads the advanced grid and computes a
   *different* window, so there is nothing to conflict with. A conflict
   therefore means a broken invariant, and the right response is the abort.

2. **The drain lease is a row, not `pg_try_advisory_lock`** (§5.4). A session
   advisory lock belongs to a connection, and the executor the same document
   recommends is a `pg.Pool`, which hands out a different connection per query.
   The lock would be taken on one connection, never seen by the batches, and
   released on a third. It would appear to work and would never exclude
   anything. The advisory lock is still used, scoped to one transaction, to make
   the lease claim atomic.

3. **Rates are `NUMERIC(38,12)`, not integer minor units** (§5.3 sketches
   `rate_minor_per_minute` and asserts `minutes * rate` is integer arithmetic).
   §3.3 of the same document requires exactly this, and for the right reason: a
   container at $0.0019/minute is 0.19 cents, which no integer minor-unit rate
   can express. Rounding the rate instead of the charge is a 5% pricing error at
   that scale. The product is rounded once, at the charge, half-to-even, with
   the pre-rounding value stored in `amount_exact`.

4. **The engine stayed one CTE pipeline** (§5.2(g) proposed splitting it into
   several statements). The criticism was correct — the reference had two
   data-modifying CTEs that nothing referenced, so a reviewer could not tell
   they executed — but the fix taken here is to *chain* them: every CTE is
   consumed by the next or by the final `SELECT`. That keeps the set-based shape
   and the single snapshot, and makes execution order a data dependency rather
   than a promise about Postgres semantics.

---

## Provenance

Nothing here is copied from `brett_ai`. Chain of title there is unresolved, and
this was written from the behaviour described in `docs/ARCHITECTURE.md`, which
was itself written from observation.

Inherited as **ideas**, re-derived here:

| Idea | Where observed | What was taken |
|---|---|---|
| A set-based billing pipeline | `bill_resources_per_min.sql` | The approach only. The statement here shares no text with it. |
| `FOR UPDATE SKIP LOCKED` for concurrent workers | same | The standard Postgres queue pattern. A requirement, not code. |
| Emitting run metrics | same | The requirement — plus the fix that they survive a failure, which is the one thing the original got wrong. |
| Monthly partitioning of charges | `init_billing.sql` index naming (`idx_resource_usage_user_2025_01`) | The intent, which the naming revealed. Generalised. |
| A post-push script for what Prisma cannot express, with `--check` | `ai_member/scripts/index-db.ts` | The pattern, deliberately reused — it is proven in-house and AGPL-3.0 code the owner wrote. |

If any code here is later found to have been carried over rather than
re-derived, it is a defect in this repository and must be removed before
release.
