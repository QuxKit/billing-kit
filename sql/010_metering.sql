-- billing-kit — metering schema
--
--   psql -v ON_ERROR_STOP=1 -f sql/010_metering.sql
--
-- Tables and indexes for the elapsed-time metering engine: subscriptions billed
-- by the passage of a minute, where there is no client to emit a usage event
-- because nothing happened except time.
--
-- Everything lives in the `billing` schema (ARCHITECTURE.md §7.6) so these
-- tables cannot collide with a host application's and a `search_path` change
-- cannot make them ambiguous.
--
-- APPLY ORDER: 010 (this), 011 (partitions), 012 (the batch function), 013
-- (the drain lease). Numbered from 010 so the whole metering group sorts after
-- sql/001_core.sql and leaves room for the core files between.
-- 011 must run before any charge is written, because the partitioned tables
-- here are created with no partitions at all and an insert into a partitioned
-- table with no matching partition fails. That is deliberate: a silently
-- unpartitioned table that works fine until a hundred million rows is the
-- failure this file exists to avoid, so the failure is moved to the first
-- insert, where it is loud and immediate.
--
-- Re-runnable. Every statement is guarded.

CREATE SCHEMA IF NOT EXISTS billing;

-- gen_random_uuid() is in core since Postgres 13. Named here so a deployment on
-- an older server fails at install rather than at the first charge.
DO $$
BEGIN
  IF current_setting('server_version_num')::integer < 130000 THEN
    RAISE EXCEPTION 'billing-kit requires PostgreSQL 13 or newer (gen_random_uuid, ON CONFLICT on partitioned tables)';
  END IF;
END;
$$;

-- KNOWN CONFLICT, made loud on purpose. Read this before changing it.
--
-- sql/001_core.sql also declares billing.ledger_entries, in a different and
-- incompatible shape: it names an account with (subject_id, account, currency)
-- columns on the entry itself, where this file references a
-- billing.ledger_accounts row by account_id. Both files use
-- CREATE TABLE IF NOT EXISTS, so without this check whichever applies SECOND
-- does nothing at all, reports success, and the mistake surfaces much later as
-- meter_batch inserting into columns that are not there.
--
-- The two shapes are not both right. 001_core's matches the LedgerEntry
-- interface in src/types.ts, which is the library's declared public vocabulary,
-- so 001_core's is canonical and THIS FILE is the one to migrate. That
-- migration is not done here because it changes how the balance guard reads a
-- balance — this file caches it on ledger_accounts and 001_core derives it by
-- aggregating entries — and that is a decision for whoever owns the ledger, not
-- for the metering engine that posts into it.
--
-- Until it is resolved: fail here, saying why, rather than three layers away.
DO $$
DECLARE
  v_missing text;
BEGIN
  IF to_regclass('billing.ledger_entries') IS NOT NULL THEN
    SELECT string_agg(c, ', ' ORDER BY c) INTO v_missing
      FROM unnest(ARRAY['transaction_id', 'account_id', 'amount_minor', 'currency',
                        'source_kind', 'source_id', 'leg', 'posted_at']) AS c
     WHERE NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'billing' AND table_name = 'ledger_entries' AND column_name = c);

    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION
        'billing.ledger_entries already exists in an incompatible shape (missing: %). %',
        v_missing,
        'sql/001_core.sql and sql/010_metering.sql both declare this table. See the note above '
        'this check in 010_metering.sql: 001_core''s shape is canonical and meter_batch is what '
        'must be migrated onto it.';
    END IF;
  END IF;
END;
$$;


-- ---------------------------------------------------------------------------
-- billable_items — the things that accrue money by existing
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS billing.billable_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  tenant_id       text NOT NULL,
  subject_id      text NOT NULL,

  -- What is being counted. Fixed for this engine, but carried on the row and
  -- onto the charge so a subject's charges from elapsed-time metering and from
  -- event-based metering land in the same table and stay distinguishable.
  metric          text NOT NULL DEFAULT 'elapsed_minutes',

  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'suspended', 'cancelled')),

  -- NUMERIC, not BIGINT, and this is the one place the reference implementation
  -- and ARCHITECTURE.md §5.3's sketch both understate the problem. §3.3 fixes
  -- rates at NUMERIC(38,12) because a rate is in MINOR units per unit — cents,
  -- the same convention money.ts price() uses, so amount_minor = round(quantity
  -- * rate) needs no major->minor scaling. A real rate is often a small fraction
  -- of a minor unit: 0.0000012 cents/token, or a container at 0.19 cents/minute.
  -- An integer minor-unit rate cannot express either, and rounding the rate
  -- instead of the charge is a 5% pricing error at that scale.
  rate_per_minute numeric(38,12) NOT NULL CHECK (rate_per_minute >= 0),

  currency        char(3) NOT NULL,

  -- The billing grid. Always the exact end of the last billed interval, never
  -- `now()` — see 012_meter_batch.sql for why the difference is money.
  last_billed_at  timestamptz NOT NULL,

  suspended_at    timestamptz,
  cancelled_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- A grid point in the future would make the item permanently not-due and
  -- invisible: no error, no charge, no row anywhere saying so. Cheap to assert,
  -- and the assertion is the only thing that would ever catch it.
  CONSTRAINT billable_items_grid_not_future CHECK (last_billed_at <= now() + interval '1 day')
);

-- Serves the due-scan in billing.meter_batch:
--   WHERE status = 'active' AND last_billed_at <= now() - interval '1 minute'
--   ORDER BY last_billed_at LIMIT p_batch FOR UPDATE SKIP LOCKED
--
-- Partial on status because the index then holds the active set rather than the
-- whole table, and a cancelled estate that outgrows the active one is the
-- normal end state of any subscription product.
--
-- The column order matters more than it looks: last_billed_at leading is what
-- lets the index satisfy the ORDER BY, so LIMIT stops after p_batch rows
-- instead of sorting every due row to find the oldest p_batch of them. The
-- ORDER BY is not cosmetic either — without it LIMIT makes progress arbitrary
-- and the oldest item can starve forever behind a churning head of the table.
CREATE INDEX IF NOT EXISTS billable_items_due
  ON billing.billable_items (last_billed_at)
  WHERE status = 'active';

-- Serves the balance guard's join back from ledger_accounts to items, and the
-- host's "what is this subject paying for" query.
CREATE INDEX IF NOT EXISTS billable_items_subject
  ON billing.billable_items (tenant_id, subject_id);


-- ---------------------------------------------------------------------------
-- ledger_accounts — one balance per (subject, kind, currency)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS billing.ledger_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  subject_id    text NOT NULL,
  kind          text NOT NULL,
  currency      char(3) NOT NULL,

  -- A cache of the sum of ledger_entries for this account, maintained in the
  -- same transaction as the entries. The entries are the truth; this column
  -- exists so the balance guard does not aggregate the ledger once per batch.
  -- The concurrency test re-derives it from the entries and fails if they differ.
  balance_minor bigint NOT NULL DEFAULT 0,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- Serves account resolution in the metering pipeline's ledger join, and is
  -- the conflict target for the trigger below.
  CONSTRAINT ledger_accounts_natural_key UNIQUE (tenant_id, subject_id, kind, currency)
);

COMMENT ON COLUMN billing.ledger_accounts.balance_minor IS
  'Signed from the subject''s point of view: positive means funded. A charge '
  'subtracts. See 012_meter_batch.sql for the transaction''s sign convention.';

/*
 * Both accounts a charge needs, created with the item rather than with the
 * charge.
 *
 * The failure this prevents: meter_batch resolves the two accounts with an
 * inner join. A missing account would drop the ledger legs while the charge row
 * and last_billed_at both advanced — money billed, clock moved, no ledger
 * record, and nothing raised. Creating them here means the join cannot miss,
 * and meter_batch asserts the leg count anyway because "cannot" is a claim and
 * an assertion is a fact.
 *
 * They cannot be created inside meter_batch's pipeline instead: rows inserted
 * by a data-modifying CTE are not visible to the other CTEs of the same
 * statement, so the join would still find nothing.
 *
 * The VALUES list is in ascending kind order so two concurrent inserts for the
 * same subject take the two unique-index entries in the same order and wait
 * rather than deadlock.
 */
CREATE OR REPLACE FUNCTION billing.ensure_ledger_accounts() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO billing.ledger_accounts (tenant_id, subject_id, kind, currency)
  VALUES (NEW.tenant_id, NEW.subject_id, 'customer_balance', NEW.currency),
         (NEW.tenant_id, NEW.subject_id, 'revenue_accrued',  NEW.currency)
  ON CONFLICT ON CONSTRAINT ledger_accounts_natural_key DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS billable_items_ensure_accounts ON billing.billable_items;
CREATE TRIGGER billable_items_ensure_accounts
  AFTER INSERT OR UPDATE OF tenant_id, subject_id, currency
  ON billing.billable_items
  FOR EACH ROW EXECUTE FUNCTION billing.ensure_ledger_accounts();


-- ---------------------------------------------------------------------------
-- charges — partitioned by RANGE (window_start), monthly
-- ---------------------------------------------------------------------------
--
-- Immutable and append-only (§4.3). Repricing writes a reversing charge and a
-- new one; there is no UPDATE path and no DELETE path.

CREATE TABLE IF NOT EXISTS billing.charges (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  subject_id    text NOT NULL,
  item_id       uuid NOT NULL,
  metric        text NOT NULL,

  -- Half-open [window_start, window_end), so consecutive windows for one item
  -- can neither gap nor overlap.
  window_start  timestamptz NOT NULL,
  window_end    timestamptz NOT NULL,

  quantity      numeric(38,12) NOT NULL,
  rate          numeric(38,12) NOT NULL,

  -- The rounded, payable amount. Integer minor units (§3.1).
  amount_minor  bigint NOT NULL,

  -- quantity * rate before rounding. §3.5 requires the pre-rounding value be
  -- kept so the residue (amount_exact - amount_minor) is auditable and a later
  -- reprice can be checked against what was actually charged. Without it the
  -- rounding is a claim in a comment rather than a number in a row.
  amount_exact  numeric(38,12) NOT NULL,

  currency      char(3) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  -- A partitioned table's primary key must include the partition key. This is
  -- the composite Prisma cannot express and that `prisma db push` silently
  -- replaces with a plain `id` on an unpartitioned table (§6.2).
  PRIMARY KEY (id, window_start),

  CONSTRAINT charges_window_ordered CHECK (window_end > window_start),
  CONSTRAINT charges_quantity_nonneg CHECK (quantity >= 0)
) PARTITION BY RANGE (window_start);

-- THE anti-double-billing barrier, and the reason the concurrency test can
-- assert a property rather than observe an absence.
--
-- Two workers that both read the same last_billed_at would both compute the
-- same window_start. Row locking is what stops them getting that far; this
-- index is what makes it impossible rather than unlikely, and it is enforced by
-- the database rather than by the correctness of the function above it.
--
-- Deliberately NOT paired with ON CONFLICT DO NOTHING in meter_batch. See
-- 012_meter_batch.sql: skipping the charge while the clock has already advanced
-- would lose money quietly, which is worse than aborting the batch loudly.
CREATE UNIQUE INDEX IF NOT EXISTS charges_item_window
  ON billing.charges (item_id, window_start);

-- Serves per-subject period aggregation:
--   WHERE tenant_id = $1 AND subject_id = $2
--     AND window_start >= $3 AND window_start < $4
CREATE INDEX IF NOT EXISTS charges_subject_window
  ON billing.charges (tenant_id, subject_id, window_start);

-- Serves any window-bounded scan that is not subject-scoped: the monthly
-- revenue roll-up, and the ledger reconciliation in the test suite.
--
-- BRIN and not BTREE because the table is append-only and therefore naturally
-- clustered by window_start. A BRIN index over a hundred million rows is a few
-- kilobytes; the BTREE is gigabytes and is write amplification on every insert
-- for a scan that reads a whole month anyway.
CREATE INDEX IF NOT EXISTS charges_window_brin
  ON billing.charges USING brin (window_start);


-- ---------------------------------------------------------------------------
-- ledger_entries — partitioned by RANGE (posted_at), monthly
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS billing.ledger_entries (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),

  -- Shared by the legs of one posting. For a metering charge this is the
  -- charge id, so a ledger row names the charge that caused it without a join
  -- through anything else.
  transaction_id uuid NOT NULL,

  tenant_id      text NOT NULL,
  account_id     uuid NOT NULL REFERENCES billing.ledger_accounts (id),
  amount_minor   bigint NOT NULL,
  currency       char(3) NOT NULL,

  source_kind    text NOT NULL,
  source_id      uuid NOT NULL,
  leg            text NOT NULL CHECK (leg IN ('debit', 'credit')),

  posted_at      timestamptz NOT NULL DEFAULT now(),
  memo           text,

  PRIMARY KEY (id, posted_at)
) PARTITION BY RANGE (posted_at);

-- Idempotency backstop for a posting: one debit and one credit per source.
--
-- Honest about its limit: posted_at is in the key because a partitioned table's
-- unique index must include the partition key, so this constrains within a
-- partition and not across the whole table. It is not the primary guarantee and
-- was never meant to be — for metering, the guarantee is charges_item_window
-- above, plus the fact that ledger legs are inserted only from the charge
-- insert's RETURNING, in the same statement. A leg can only exist because a
-- charge row was created, and a charge row can only be created once.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_entries_source
  ON billing.ledger_entries (source_kind, source_id, leg, posted_at);

-- Serves balance re-derivation and the account statement:
--   WHERE account_id = $1 AND posted_at >= $2 ORDER BY posted_at
CREATE INDEX IF NOT EXISTS ledger_entries_account
  ON billing.ledger_entries (account_id, posted_at);

-- Serves whole-period ledger scans. Append-only, so BRIN for the same reason.
CREATE INDEX IF NOT EXISTS ledger_entries_posted_brin
  ON billing.ledger_entries USING brin (posted_at);


-- ---------------------------------------------------------------------------
-- meter_runs — one row per drain, written by the driver
-- ---------------------------------------------------------------------------
--
-- Written from TypeScript and NOT from a PL/pgSQL EXCEPTION handler. The
-- reference implementation inserted its failure row inside a handler that then
-- RAISEd; the RAISE aborts the transaction and rolls the insert back with
-- everything else, so the one run you most need a record of is the one run that
-- leaves none. §5.2(e).
--
-- The driver claims a row as 'running' before the first batch and settles it at
-- the end, so a process killed mid-drain leaves a 'running' row with a null
-- finished_at. That row is the signal; a run that emits nothing is not
-- distinguishable from a run that never started.

CREATE TABLE IF NOT EXISTS billing.meter_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which worker. "One of the twelve pods is stalling" is not answerable
  -- without it, and it is the question you have during an incident.
  runner             text NOT NULL,

  -- 'lease_lost' is a distinct terminal status and not a flavour of 'bounded'.
  -- It means the heartbeat found this run no longer 'running', so two workers
  -- were briefly both eligible to bill. That is a specific configuration fault
  -- — the lease is shorter than a batch takes — and folding it into 'bounded'
  -- hides the one status that says so.
  status             text NOT NULL
                     CHECK (status IN ('running', 'drained', 'bounded', 'skipped',
                                       'lease_lost', 'failed')),

  started_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,

  -- Touched once per batch while a drain is running. This row is the drain
  -- lease, and the lease is what stops overlapping drains stacking during an
  -- incident (§5.4).
  --
  -- ARCHITECTURE.md §5.4 uses pg_try_advisory_lock for this. That does not
  -- work over the executor the same document recommends: a session advisory
  -- lock belongs to a connection, and a pool hands out a different connection
  -- per query, so the lock is taken on one connection, never seen by the
  -- batches, and released on a third — or leaked when the unlock lands
  -- elsewhere. It fails silently and in the direction that looks fine.
  --
  -- A row is connection-independent. `heartbeat_at` rather than `started_at`
  -- alone because a long legitimate drain must not look expired, and a worker
  -- killed mid-drain must not hold the lease until someone notices.
  heartbeat_at       timestamptz NOT NULL DEFAULT now(),

  iterations         integer NOT NULL DEFAULT 0,
  items_billed       bigint  NOT NULL DEFAULT 0,
  minutes_billed     bigint  NOT NULL DEFAULT 0,
  items_suspended    bigint  NOT NULL DEFAULT 0,
  accounts_updated   bigint  NOT NULL DEFAULT 0,

  -- Keyed by currency, values are minor-unit integers as STRINGS.
  --   { "USD": "129400", "EUR": "8800" }
  -- Two decisions in one column. Keyed by currency because a single total
  -- across currencies is not a number, it is a category error that reads like a
  -- number. Strings because jsonb numbers are arbitrary-precision in Postgres
  -- and IEEE-754 doubles the moment JSON.parse sees them, which is exactly the
  -- silent precision loss §3.2 is about.
  amount_by_currency jsonb   NOT NULL DEFAULT '{}'::jsonb,

  duration_ms        integer,

  -- Message and SQLSTATE of the failure, when status = 'failed'.
  error              text,
  error_code         text
);

-- Serves the operational query: "what have the last N runs done".
CREATE INDEX IF NOT EXISTS meter_runs_recent
  ON billing.meter_runs (started_at DESC);

-- Serves both the drain lease check ("is a live run holding it") and the alert
-- ("is anything stuck"). Partial, so it is the size of the currently-running
-- set, which is normally single digits however large the run history grows.
CREATE INDEX IF NOT EXISTS meter_runs_in_flight
  ON billing.meter_runs (heartbeat_at)
  WHERE status = 'running';
