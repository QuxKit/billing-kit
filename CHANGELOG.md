# Changelog

All notable changes to `@quxkit/billing-kit` are recorded here. The format is
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added — multi-product subjects and bundles (#38)

- `activeSubscriptions` (plural), and `check`/`list` now consult EVERY active
  subscription of a subject: features union across plans, and where two plans
  define the same key the more permissive verdict wins. Fixes the eclipse
  where buying a second product silently revoked the first product's
  entitlements (`activeSubscription` was `LIMIT 1`; it remains, answering the
  newest, for compatibility).
- The product dimension, additive end to end: `Plan.productId?`,
  `PlanUsage.productId?`, `ChargeLine.productId?`, carried through
  `chargeLinesJSON` into invoice line `metadata.productId` — a bundle invoice
  can be grouped and sub-totalled per product with no schema change.
- `defineBundle({ id, items: [{ productId, plan }] })`: composes same-currency,
  same-interval member plans into one chargeable, checkable Plan — flats
  summed, usage concatenated with per-product tags, features merged. Metric
  and feature-key collisions are refused with instructions to namespace, as
  are mixed intervals and a second seat definition (those are phase 2:
  subscription items). Bundle discounts are the existing whole-subtotal
  `DiscountRule`.

## [0.2.0] - 2026-08-17

### Added
- `sql/090_rls.sql` (optional): enables + **forces** row-level security on
  every `billing.*` table with a `tenant_id` column, policy
  `tenant_id = current_setting('tenancy.tenant_id', true)` (USING and WITH
  CHECK) — compatible with tenant-kit's `SET LOCAL tenancy.tenant_id`.
  Closed by default; discovers tables by column so a re-run covers new ones.
  Proven by a test running as a non-superuser, non-BYPASSRLS table owner.
- `pricePackage(quantity, { unitsPerPackage, pricePerPackage, roundUp })` in
  the core: per-package pricing (SMS per 500, tokens per 1,000). `roundUp`
  bills whole packages in integer arithmetic (zero residue); without it,
  fractional packages round once half-to-even like every price. Accepted as a
  plan overage strategy: `price: { kind: 'package', package }`.
- `changePlan(db, { tenantId, subscriptionId, from, to, behaviour, at?, seats?,
  usage? })` (`sql/032_plan_changes.sql`): `immediate` closes the current
  period at `at` on the old plan (prorated fees + usage, one balanced posting,
  an invoiceable period row) and restarts the remainder on the new plan,
  prorated by the sweep at period end; `period_end` sets `pending_plan_id`,
  applied at the next advance. Idempotent on `(subscription, effectiveAt)` via
  `billing.plan_changes`. `chargeSubscriptionPeriod` gains `closeAt`/
  `nextPlanId` and auto-prorates short periods (`prorationFor` exported);
  zero-amount fee lines are dropped.
- `@quxkit/billing-kit/entitlements`: `definePlan` gains
  `features: { [key]: true | { limit, meter, method?, overage? } }`;
  `check(db, { tenantId, subjectId, feature, plan, at? })` →
  `{ allowed, kind: 'boolean' | 'metered', limit?, used?, remaining?, overage?,
  reason? }` from the active subscription's plan, `aggregateUsage` over the
  period containing `at`, and the wallet for `overage: 'wallet'`;
  `list(...)`; `createEntitlements` binding; `activeSubscription`,
  `periodContaining` exported.
- `@quxkit/billing-kit/invoices` (`sql/031_invoices.sql`): `invoices`,
  `invoice_lines`, `invoice_counters`; `createInvoice`/`addLine`/`finalize`/
  `markPaid`/`voidInvoice`/`markUncollectible`/`attachSettlement`/`getInvoice`/
  `listInvoices`, `createInvoices` binding; gap-free `{prefix}-{YYYY}-{seq:06}`
  numbering from a counter row locked `FOR UPDATE`; `draft → open → paid | void
  (+ uncollectible)` with the typed `invoice_state` refusal (and
  `invalid_invoice`); `invoiceForPeriod` builds lines from the persisted charge
  breakdown (base, seats, overage per meter, discount, optional credit);
  `renderInvoice(inv, { format: 'json' | 'html' })` — no PDF.
  `applyVerifiedEvent` now falls back to the invoice a settlement ref is
  attached to for the subject, and moves that invoice open → paid.
- `chargeSubscriptionPeriod` accepts `discount` and persists `charge_lines`
  (needs `sql/031`); `chargeLinesJSON` exported.
- `applyVerifiedEvent(db, { provider, event, resolve })` in
  `@quxkit/billing-kit/providers`: posts the ledger transaction a
  `VerifiedEvent` means (`payment.succeeded` → payment, `refund.settled` →
  refund; failures, declines and informational kinds post nothing and return
  `{ applied: false, reason }`), idempotent on `(provider, providerEventId)`
  through the new `billing.provider_events` table
  (`sql/030_provider_events.sql`). A redelivery is answered from the row and
  writes nothing.
- `@quxkit/billing-kit/pg` subpath: `pgExecutor(pool)` — the shipped
  `SqlExecutor` over a `pg.Pool`, with transaction pinning. `pg` stays an
  optional peer dependency; the test suite now runs on this adapter instead
  of a private copy.
- `examples/quickstart`: a runnable end-to-end program (apply SQL, record a
  usage event and its retry, post a payment, read the balance).
- Subscription sweep: a per-run lease (`pg_try_advisory_xact_lock`, keyed by
  tenant or `lease.key`; `lease: false` to disable), per-row
  `FOR UPDATE SKIP LOCKED` inside a per-item transaction, and per-item retry
  with exponential backoff (`retry: { retries, backoffMs, sleep }`).
  `SweepReport` gains `leased` and `locked`; `SweepError` carries `attempts`
  and `code`; `SweepError`/`SweepRetry` exported.
- Typed errors `batch_too_large` (`recordMany` above `RECORD_MANY_MAX` =
  1,000 events) and `result_too_large` (`entries()` asked for, or walking
  past, `ENTRIES_MAX_ROWS` = 100,000 rows). Both constants exported.
- Repo tooling: Biome (`lint`, `format`), c8 (`test:coverage`, thresholds in
  `.c8rc.json`), `REQUIRE_DB=1` to fail rather than skip when the test
  database is unreachable, a harness sanity test.
- GitHub Actions CI (Node 20/22, postgres:16 service), a portable Gitea CI, a
  tag-triggered release workflow (`npm publish --provenance`), dependabot,
  CODEOWNERS, SECURITY.md, CONTRIBUTING.md.

### Changed
- `pnpm test` now runs every test file: `test/`, `test/adversarial/`,
  `src/providers/tests/` (81 cases) and `src/metering/test/` (17 cases) —
  the last two were never run by the old glob.
- The metering test harness reads `BILLING_KIT_TEST_DATABASE_URL` (deriving
  `PG*` for `psql`) and skips cleanly instead of failing in `before()`.
- `sql/README.md` lists `001_core.sql` and `020_subscriptions.sql` in the file
  table and psql sequence.
- README: quickstart imports the shipped `pg` adapter; an Errors section;
  the sweep's concurrency contract; the Lago adapter claim removed from the
  diagram and keywords (no adapter exists; further providers are planned via
  `@quxkit/billing-kit-adapters`).
- `prepublishOnly` runs lint, typecheck, build, test and `test:pack`.

### Removed
- Error codes that were declared and never raised: `window_sealed`,
  `ledger_immutable`, `account_currency_mismatch`; and the `UsageAggregate`
  type (no `usage_aggregates` table exists). Type-level only — no runtime
  path produced them. Window sealing is deferred to a later release.

### Fixed
- `recordMany` no longer dereferences a missing dedupe claim; it raises
  `dedupe_unresolved`.
- `entries()` with no `limit` walked without bound; it now stops with
  `result_too_large` rather than returning a silently short array or running
  forever.
- Sweep errors were recorded after a single attempt and the failed row's
  ledger post could commit while the period/advance did not; each item is now
  charged atomically and retried before it is reported.

### Security
- CI cannot go green without exercising the database (`REQUIRE_DB=1`).
- Input bounds on batch ingest and ledger reads (above).

## [0.1.0] - 2026-08-14

Initial release: exact money, idempotent ingest, append-only double-entry
ledger, the metering engine, subscriptions, Stripe and Paddle providers, and
the `billing-kit` CLI.
