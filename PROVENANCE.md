# Provenance

This file records where the code in this repository came from, so that the
answer exists in writing before anyone has to ask.

## The short version

Every line in `src/` and `sql/` was written fresh for this repository. Nothing
was copied, adapted, translated or transcribed from `brett_ai`.

## Why this file exists

`brett_ai` contains a working usage-billing implementation, and it would have
been faster to lift it. It was not lifted, because its chain of title is
unresolved:

- `LICENSE.md` in that repository asserts copyright to a company, "Oliego, Inc."
- 104 of its 115 commits, including every billing file, are authored by a git
  identity that is not the owner's.
- The repository is an unattributed derivative of two MIT-licensed templates.

Copying from a codebase whose ownership is unsettled into one intended for an
Apache-2.0 release does not produce a licensing question that can be cleaned up
later. It produces a defect in the release that cannot be fixed after the fact,
because there is no way to prove afterwards which lines came from where. The
only reliable moment to get this right is before the first line is written.

So the method was: read `brett_ai`, describe what it does in prose, and
implement from the description. Ideas are not copyrightable; expression is. What
follows is the list of ideas taken, recorded so that a reviewer can check the
claim rather than take it on faith.

## Inherited as ideas, re-derived as code

| Idea | Where it was observed | What was taken | Where it landed |
|---|---|---|---|
| Set-based billing pipeline, not a row-by-row loop | `prisma/scripts/bill_resources_per_min.sql` | The approach only. The reference is one CTE chain; the design here is explicit statements in one transaction. | `docs/ARCHITECTURE.md` §5 |
| `FOR UPDATE SKIP LOCKED` so concurrent workers cannot double-bill | same | A standard Postgres queue pattern. A requirement, not an expression. | `docs/ARCHITECTURE.md` §5.3 |
| Emitting run metrics so a run is observable | same | The requirement, plus the fix that the metric survives a failed run. | `docs/ARCHITECTURE.md` §5.2(e) |
| Monthly partitioning of usage tables | index names in `prisma/scripts/init_billing.sql` (`idx_resource_usage_user_2025_01`) | The intent, inferred from the naming. Generalised. | `sql/001_core.sql` |
| A post-push script for what Prisma cannot express, with a `--check` mode | `ai_member/scripts/index-db.ts` | The pattern, deliberately reused because it is proven in-house. Note this is the AGPL open core, which the owner does hold. | `sql/001_core.sql`, `docs/ARCHITECTURE.md` §6.2 |

Nothing in the table is a code artefact. Each row is a design decision that was
re-implemented against a different schema, in a different language, with
different names and a different structure.

## Anti-patterns taken as requirements

Three defects were found in `brett_ai`'s route glue — not in its billing engine,
which is sound. They are recorded here because the public API was shaped
specifically so their equivalents cannot be written:

| Defect observed | How this library forecloses it |
|---|---|
| `app/api/billing/add-funds` credits a balance straight from the request body, with no processor call behind it | There is no `credit(amount)` in the API. Cash reaches the ledger only through `paymentPosting`, which is built from a verified webhook. |
| `app/api/billing/run` has its `CRON_SECRET` check commented out | billing-kit exports no HTTP endpoint, so there is no secret check to comment out. Triggering and authenticating a drain belongs to the host. |
| `actions/open-customer-portal.ts` passes a client-supplied Stripe customer id (an IDOR) | No public method takes a provider customer id. Every method takes our own subject id and resolves the provider reference internally. It is a type error, not a review item. |

## Corrections to the source material

Recorded because the owner should know, and because each one changed a decision
in this repository.

1. **The reference schema is not exact-numeric, despite the SQL suggesting it
   is.** `prisma/scripts/init_billing.sql` declares money columns as
   `NUMERIC(12,6)`, but `prisma/schema.prisma` declares the same concepts —
   `BillingAccount.balance`, `totalSpent`, `Transaction.amount`,
   `BillableResource.pricePerMinute`, `ResourceUsageCharge.amount` — as `Float`,
   which is `double precision`. The stored procedure's `NUMERIC` appears only in
   its locals and return type. `BillingAccount.balance` exists solely in the
   Prisma schema and is therefore double precision in any deployment.

2. **The two DDLs are mutually incompatible.** `init_billing.sql` creates
   snake_case columns and a partitioned `resource_usage_charges` with
   `PRIMARY KEY (id, interval_start)`. The Prisma schema and the billing
   function both use quoted camelCase and a single-column id. Only one can be
   the deployed shape: run `init_billing.sql` and the billing function fails on
   a missing column; run `prisma db push` and the partitioning silently
   disappears. This is why `sql/` in this repository, not Prisma, is the source
   of DDL truth for anything Prisma cannot express.

3. **A failure metric written inside a PL/pgSQL `EXCEPTION` handler that then
   re-raises is rolled back with everything else.** The reference inserts a
   `billing_run_metrics` row and then `RAISE`s, so the one run most worth having
   a record of leaves none. Failure recording belongs in the driver, outside the
   aborted transaction.

## Corrections found while implementing this repository

Two claims in `docs/ARCHITECTURE.md` did not survive contact with Postgres. The
document is the earlier phase's and has not been edited here; the code differs
from it deliberately, and the differences are these.

1. **§6.4's `UNIQUE (tenant_id, source, external_id)` on `usage_events` cannot
   exist.** Postgres requires every unique index on a partitioned table to
   include all partition key columns, and `usage_events` is partitioned by
   `occurred_at`. Adding `occurred_at` to the constraint would defeat its
   purpose, since the same `external_id` replayed with a different timestamp
   would then insert twice — exactly the retry that dedupe is for. Resolved by
   `billing.usage_event_keys`, a small unpartitioned claim table holding the
   dedupe key, claimed inside the same transaction that writes the event.

2. **§4's `unique on (source_kind, source_id, leg)` does not survive a
   three-legged transaction.** A settlement whose provider total differs from
   our accrued total posts three legs: accrued, settled and the variance. With
   `leg` as a debit/credit discriminator that key collides. Entries here carry
   an ordinal `leg_no`, and posting idempotency is enforced on the
   unpartitioned `ledger_transactions` table by
   `UNIQUE (tenant_id, source_kind, source_id)` instead.

## Third-party code

None. `src/` has no runtime dependencies at all — no vendored files, no
copied snippets, no lightly-edited gists. `pg`, `tsx`, `typescript` and their
types are development dependencies used by the tests and the typechecker, and
none of them is redistributed.

## Copyright holder

`NOTICE` currently attributes copyright to "the billing-kit authors" rather than
naming a legal entity. That placeholder is deliberate: naming the wrong entity
is the precise failure this document exists to prevent, and the correct answer
depends on decisions the owner has not yet made. Set it before the first public
release.

## Standing instruction

If any code in this repository is later found to have been carried over from
`brett_ai` rather than re-derived, it is a defect. It must be removed and
rewritten before release, not annotated. This applies regardless of how small
the fragment is or how well it works.
