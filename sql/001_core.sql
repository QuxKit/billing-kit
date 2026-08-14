-- billing-kit core schema: ingest and ledger.
--
-- Scope of this file: only the tables `src/events.ts` and `src/ledger.ts`
-- touch. Aggregates, charges, prices and the metering engine's own objects
-- live in their own numbered file, so the two can be reviewed apart.
--
-- RESOLVED: `billing.ledger_entries` is declared here and nowhere else.
-- `sql/010_metering.sql` used to declare a second, incompatible version of the
-- same table (`account_id uuid` into a `ledger_accounts` row, `leg text`
-- constrained to debit/credit, `source_id uuid`) and both used CREATE TABLE IF
-- NOT EXISTS, so applying both did not error on the table — the second one
-- silently did nothing and its indexes then failed on columns that did not
-- exist. That is exactly the failure PROVENANCE.md records against the
-- reference application: two DDLs for one table, only one of which can be the
-- deployed shape.
--
-- This shape won, for two reasons. It matches the `LedgerEntry` interface in
-- src/types.ts, which is the library's declared public vocabulary; and
-- `leg IN ('debit','credit')` cannot express the three-legged settlement
-- posting in docs/ARCHITECTURE.md §4.4, where a provider total differing from
-- the accrued total posts accrued, settled and variance. `sql/012_meter_batch.sql`
-- was migrated onto these columns.
--
-- Everything is in a `billing` schema. A host application's `usage_events` and
-- ours must not be able to collide, and a `search_path` change must not be able
-- to make either ambiguous. It also gives the open-core/hosted sync seam a
-- clean boundary: the billing schema is the library's, identical on both sides.

CREATE SCHEMA IF NOT EXISTS billing;

-- ---------------------------------------------------------------------------
-- Ingest
-- ---------------------------------------------------------------------------

-- Append-only. Nothing updates this table, ever, and a trigger below enforces
-- that rather than trusting every future caller to know it.
--
-- Partitioned by `occurred_at` because that is the caller's timestamp and
-- therefore the axis every aggregation scan and every retention drop uses.
--
-- The primary key is (id, occurred_at) and not id: a partitioned table's
-- primary key must contain every partition key column. Prisma cannot express
-- either that or PARTITION BY, and `prisma db push` will cheerfully produce a
-- plain unpartitioned table with a single-column key. Nothing fails and nothing
-- warns; you find out at a hundred million rows. That is why this file exists
-- and why the check mode that compares it to the live database is not optional.
CREATE TABLE IF NOT EXISTS billing.usage_events (
  id           uuid           NOT NULL,
  tenant_id    text           NOT NULL,
  subject_id   text           NOT NULL,
  source       text           NOT NULL,
  external_id  text           NOT NULL,
  metric       text           NOT NULL,
  quantity     numeric(38,12) NOT NULL,
  occurred_at  timestamptz    NOT NULL,
  received_at  timestamptz    NOT NULL DEFAULT now(),
  metadata     jsonb,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

-- The dedupe claim.
--
-- This table exists because the obvious design is impossible. Ingest
-- deduplicates a usage event, but Postgres requires every unique index on a
-- partitioned table to include all partition key columns — so on a table
-- partitioned by occurred_at that unique constraint cannot be created at all.
-- Adding occurred_at to it would defeat it: the same event replayed with a
-- different timestamp would insert twice, which is exactly the retry case
-- dedupe is for.
--
-- So the key lives in its own small unpartitioned table and is claimed before
-- the event row is written. It carries occurred_at so retention can prune it on
-- the same schedule as the partitions it points into.
--
-- The key is (tenant_id, source, subject_id, metric, external_id), which is the
-- natural grain of an event and NOT (tenant_id, source, external_id). A caller
-- treats external_id as the id of a request, then emits several metrics under
-- it — input and output tokens for one API call — or bills two subjects from
-- one upstream webhook. With external_id alone as the key, the second metric
-- and the second subject collide with the first and are silently dropped: the
-- usage happened, the row does not exist, and the miss surfaces only when a bill
-- is reconciled by hand. Widening the key keeps genuine retries (same five
-- columns) deduplicated while letting distinct events through. A replay of the
-- SAME (subject, metric, external_id) with a DIFFERENT quantity is still treated
-- as a duplicate here; detecting that conflict is a separate decision.
CREATE TABLE IF NOT EXISTS billing.usage_event_keys (
  tenant_id    text        NOT NULL,
  source       text        NOT NULL,
  subject_id   text        NOT NULL,
  metric       text        NOT NULL,
  external_id  text        NOT NULL,
  event_id     uuid        NOT NULL,
  occurred_at  timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source, subject_id, metric, external_id)
);

CREATE INDEX IF NOT EXISTS usage_event_keys_occurred_at_idx
  ON billing.usage_event_keys (occurred_at);

-- ---------------------------------------------------------------------------
-- Ledger
-- ---------------------------------------------------------------------------

-- One transaction. Unique on (tenant_id, source_kind, source_id), which is the
-- natural key: replaying the posting for charge X writes nothing the second
-- time rather than double-counting it.
--
-- This table is deliberately not partitioned. It is where posting idempotency
-- is enforced, and a unique constraint on a partitioned table would have to
-- include the partition key — the same trap as usage_events, with a worse
-- consequence, since a duplicate here is a duplicated charge.
CREATE TABLE IF NOT EXISTS billing.ledger_transactions (
  id          uuid        PRIMARY KEY,
  tenant_id   text        NOT NULL,
  source_kind text        NOT NULL,
  source_id   text        NOT NULL,
  posted_at   timestamptz NOT NULL DEFAULT now(),
  metadata    jsonb,
  UNIQUE (tenant_id, source_kind, source_id)
);

-- The legs. Signed minor units: positive debit, negative credit, and the legs
-- of one transaction sum to zero per currency.
--
-- amount_minor is BIGINT, never double precision. The reason is not magnitude
-- (2^63-1 cents is more money than exists) but that SUM(double precision) is
-- not associative: the planner may reorder a parallel aggregate, so the same
-- rows produce different totals on different plans. A balance that depends on
-- the query plan cannot be re-derived, and re-derivability is the only thing
-- that makes an audit possible. SUM(bigint) widens to numeric, so aggregation
-- here cannot overflow either.
CREATE TABLE IF NOT EXISTS billing.ledger_entries (
  id             uuid        NOT NULL,
  transaction_id uuid        NOT NULL,
  tenant_id      text        NOT NULL,
  subject_id     text        NOT NULL,
  account        text        NOT NULL,
  currency       char(3)     NOT NULL,
  amount_minor   bigint      NOT NULL,
  leg_no         smallint    NOT NULL,
  source_kind    text        NOT NULL,
  source_id      text        NOT NULL,
  posted_at      timestamptz NOT NULL,
  memo           text,
  PRIMARY KEY (id, posted_at),
  CONSTRAINT ledger_entries_account_known CHECK (account IN (
    'customer_balance', 'revenue_accrued', 'revenue_settled',
    'settlement_variance', 'cash', 'tax_payable', 'rounding', 'write_off'
  ))
) PARTITION BY RANGE (posted_at);

CREATE INDEX IF NOT EXISTS ledger_entries_transaction_idx
  ON billing.ledger_entries (transaction_id);

-- Serves `balance()` in src/ledger.ts and the balance guard in
-- sql/012_meter_batch.sql, which are the same query: SUM(amount_minor) over one
-- (tenant, subject, account, currency).
--
-- amount_minor is INCLUDEd rather than left to a heap fetch, so the aggregate
-- can be satisfied from the index alone. Verified from EXPLAIN (ANALYZE,
-- BUFFERS) on PostgreSQL 17: Index Only Scan, Heap Fetches: 0.
--
-- The reason it is worth an INCLUDE at all is that a balance is DERIVED by
-- summing an account's whole history — there is no cached total anywhere, by
-- decision — so the cost is linear in that history and every constant factor
-- comes off a number that grows forever.
CREATE INDEX IF NOT EXISTS ledger_entries_balance_idx
  ON billing.ledger_entries (tenant_id, subject_id, account, currency, posted_at)
  INCLUDE (amount_minor);

-- ---------------------------------------------------------------------------
-- Append-only enforcement
-- ---------------------------------------------------------------------------

-- There is no API to update or delete a ledger entry and there will not be one.
-- Saying so in a document protects nothing; a trigger protects it against the
-- 3am psql session, which is the only case that matters.
CREATE OR REPLACE FUNCTION billing.reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '0A000';
END;
$$;

-- Balance check, deferred to commit.
--
-- Deferred and not immediate because the legs are inserted one statement at a
-- time and a transaction is unbalanced in between by construction. An immediate
-- check would reject every correct posting on its first leg.
CREATE OR REPLACE FUNCTION billing.assert_transaction_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  offending record;
BEGIN
  SELECT currency, SUM(amount_minor) AS residual
    INTO offending
    FROM billing.ledger_entries
   WHERE transaction_id = NEW.transaction_id
   GROUP BY currency
  HAVING SUM(amount_minor) <> 0
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'ledger transaction % does not sum to zero in %: residual %',
      NEW.transaction_id, offending.currency, offending.residual
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Partitions
-- ---------------------------------------------------------------------------

-- Attach the per-partition triggers.
--
-- Triggers are attached per partition rather than to the parent because
-- Postgres does not allow a BEFORE ROW trigger or a CONSTRAINT TRIGGER on a
-- partitioned table. Attaching them here means a partition created by any route
-- other than these functions silently loses both the append-only guarantee and
-- the balance check — which is the failure the health check looks for.
CREATE OR REPLACE FUNCTION billing.attach_partition_triggers(
  p_parent text,
  p_child  text
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format(
    'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON billing.%I
       FOR EACH ROW EXECUTE FUNCTION billing.reject_mutation()',
    p_child || '_append_only', p_child
  );

  IF p_parent = 'ledger_entries' THEN
    EXECUTE format(
      'CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON billing.%I
         DEFERRABLE INITIALLY DEFERRED
         FOR EACH ROW EXECUTE FUNCTION billing.assert_transaction_balanced()',
      p_child || '_balanced', p_child
    );
  END IF;
END;
$$;

/*
 * The DEFAULT partition. A safety net, not a destination.
 *
 * Every range-partitioned table here gets one, because the alternative is that
 * a row outside every declared range cannot be stored at all: Postgres raises
 * "no partition of relation ... found for row" and the insert fails. For
 * ledger_entries that means a real payment — a webhook retried for four days, a
 * reconciliation job backfilling a quarter, a dead-letter queue replayed —
 * cannot be recorded. Money must never be rejected for want of a partition.
 * For usage_events it means billable usage on the floor for the same reason;
 * both tables had the hole and both are fixed here.
 *
 * Rows accumulating in a default partition are a SIGNAL, not a steady state.
 * They mean the partition maintenance below has not run far enough ahead or far
 * enough behind, and the count is reported by billing.partition_report() and
 * raised as a `default_partition_not_empty` fault by billing.metering_health()
 * (sql/011_partitions.sql) so it is an alert weeks early rather than a surprise.
 *
 * The cost is real and is why the report exists: while a default partition is
 * NON-EMPTY, creating the next month's partition has to reconcile it, holding
 * ACCESS EXCLUSIVE for the duration. billing.ensure_month_partition below does
 * that reconciliation rather than failing, which is the difference between a
 * pause and an outage.
 */
CREATE OR REPLACE FUNCTION billing.ensure_default_partition(
  p_parent regclass
) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_parent text;
  v_child  text;
BEGIN
  SELECT c.relname INTO v_parent FROM pg_class c WHERE c.oid = p_parent;
  v_child := v_parent || '_default';

  IF to_regclass('billing.' || quote_ident(v_child)) IS NOT NULL THEN
    RETURN v_child;
  END IF;

  EXECUTE format('CREATE TABLE billing.%I PARTITION OF %s DEFAULT', v_child, p_parent::text);
  PERFORM billing.attach_partition_triggers(v_parent, v_child);

  RETURN v_child;
END;
$$;

/*
 * Create the month partition covering `p_at`, and move into it anything the
 * default partition is already holding for that month.
 *
 * The move is not an optimisation. `CREATE TABLE ... PARTITION OF` fails
 * outright — "updated partition constraint for default partition would be
 * violated by some row" — when the default holds a row that belongs in the new
 * range. So the first late payment to land in the default would break every
 * subsequent call of this function, permanently, and the failure would surface
 * as a cron job that stopped creating partitions rather than as anything to do
 * with the payment. The whole point of the default partition is to keep a row
 * that has nowhere else to go; a maintenance path that then cannot cope with
 * that row would hand the outage back with interest.
 *
 * The sequence, all in the caller's transaction so a failure leaves nothing
 * half-done:
 *
 *   1. detach the default, so creating the new partition does not have to
 *      validate against it at all;
 *   2. create the new month partition and attach its triggers;
 *   3. move the rows the default holds for that month into it;
 *   4. re-attach the default, which validates the (now correct) remainder.
 *
 * Step 3 has to DELETE from the default, and the default carries the same
 * append-only trigger as every other partition — so the trigger is disabled for
 * the duration and re-enabled before the transaction commits. That is not a
 * hole in the guarantee: DISABLE TRIGGER needs table ownership, the window is
 * inside one transaction that holds ACCESS EXCLUSIVE on the table, and the rows
 * are not changed, only relocated to the address they should have had. The
 * alternative — leaving the default untriggered so the move is possible — would
 * mean the one partition rows land in unexpectedly is the one partition anybody
 * can quietly edit.
 */
CREATE OR REPLACE FUNCTION billing.ensure_month_partition(
  p_parent regclass,
  p_at     timestamptz
) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  -- Both boundaries come from ONE plain `timestamp` in UTC, and the month is
  -- added to that timestamp before it is labelled +00.
  --
  -- Writing it the obvious way — v_end := v_start + interval '1 month' with
  -- v_start a timestamptz — is wrong, and it was wrong here. Adding a month to
  -- a timestamptz resolves the calendar in the SESSION's TimeZone, so a start
  -- of 2026-07-01T00:00Z (which is 2026-06-30 19:00 in America/Chicago) plus
  -- one month is 2026-07-30 19:00 local = 2026-07-31T00:00Z. The July partition
  -- then ended a day before the August partition began, and every row posted
  -- during that day belonged to no partition at all.
  v_month   timestamp   := date_trunc('month', p_at AT TIME ZONE 'UTC');
  v_start   timestamptz := v_month AT TIME ZONE 'UTC';
  v_end     timestamptz := (v_month + interval '1 month') AT TIME ZONE 'UTC';
  v_parent  text;
  v_child   text;
  v_default text;
  v_key     text;
  v_moved   bigint := 0;
BEGIN
  SELECT c.relname INTO v_parent FROM pg_class c WHERE c.oid = p_parent;

  -- `YYYYmMM`, matching the names sql/011_partitions.sql produces for
  -- `charges`. One convention across the schema, because billing.metering_health()
  -- measures partition runway by comparing these names.
  v_child   := format('%s_%s', v_parent, to_char(v_month, 'YYYY"m"MM'));
  v_default := v_parent || '_default';

  IF to_regclass('billing.' || quote_ident(v_child)) IS NOT NULL THEN
    RETURN v_child;
  END IF;

  -- Asked of the catalog rather than hardcoded per table: `occurred_at` for
  -- usage_events, `posted_at` for ledger_entries, `window_start` for charges.
  SELECT a.attname INTO v_key
    FROM pg_partitioned_table pt
    JOIN pg_attribute a ON a.attrelid = pt.partrelid AND a.attnum = pt.partattrs[0]
   WHERE pt.partrelid = p_parent;

  IF to_regclass('billing.' || quote_ident(v_default)) IS NOT NULL THEN
    EXECUTE format('ALTER TABLE %s DETACH PARTITION billing.%I', p_parent::text, v_default);
  END IF;

  EXECUTE format(
    'CREATE TABLE billing.%I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
    v_child, p_parent::text, v_start, v_end
  );

  PERFORM billing.attach_partition_triggers(v_parent, v_child);

  IF to_regclass('billing.' || quote_ident(v_default)) IS NOT NULL THEN
    EXECUTE format('ALTER TABLE billing.%I DISABLE TRIGGER %I',
                   v_default, v_default || '_append_only');

    -- One statement, so the rows cannot exist in both places or in neither.
    -- Inserted through the PARENT rather than straight into the child, so
    -- partition routing decides where each row goes and this function never has
    -- to be right about the boundary twice.
    EXECUTE format(
      'WITH moved AS (
         DELETE FROM billing.%I WHERE %I >= %L AND %I < %L RETURNING *
       )
       INSERT INTO %s SELECT * FROM moved',
      v_default, v_key, v_start, v_key, v_end, p_parent::text
    );
    GET DIAGNOSTICS v_moved = ROW_COUNT;

    EXECUTE format('ALTER TABLE billing.%I ENABLE TRIGGER %I',
                   v_default, v_default || '_append_only');
    EXECUTE format('ALTER TABLE %s ATTACH PARTITION billing.%I DEFAULT', p_parent::text, v_default);

    IF v_moved > 0 THEN
      RAISE NOTICE 'billing: moved % row(s) from % into %', v_moved, v_default, v_child;
    END IF;
  END IF;

  RETURN v_child;
END;
$$;

-- Partitions are created ahead, never lazily on an insert failure. A missing
-- partition sends every insert in that range to the default, and a default that
-- fills up is an ACCESS EXCLUSIVE reconciliation at month end instead of a
-- no-op. Three weeks of headroom turns that into an alert rather than an
-- incident at midnight on the first of the month.
--
-- Returns how many partitions were actually created, counted from the catalog
-- rather than from how many times the loop went round. A non-zero return from a
-- run that was not expected to create anything means the previous runs were not
-- happening, and that is only worth logging if the number is true.
CREATE OR REPLACE FUNCTION billing.ensure_core_partitions(
  p_months_ahead integer DEFAULT 3,
  p_now          timestamptz DEFAULT now()
) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_before  integer;
  v_after   integer;
  v_created integer := 0;
  v_month   integer;
  v_parent  regclass;
BEGIN
  FOREACH v_parent IN ARRAY ARRAY['billing.usage_events'::regclass,
                                  'billing.ledger_entries'::regclass] LOOP
    SELECT count(*) INTO v_before FROM pg_inherits WHERE inhparent = v_parent;

    -- The default first, so that from here on there is no instant at which a
    -- row for an unexpected month has nowhere to go.
    PERFORM billing.ensure_default_partition(v_parent);

    -- Starts at -1 so a late event for last month still has a partition of its
    -- own rather than the default.
    FOR v_month IN -1 .. p_months_ahead LOOP
      PERFORM billing.ensure_month_partition(
        v_parent, p_now + (v_month || ' month')::interval);
    END LOOP;

    SELECT count(*) INTO v_after FROM pg_inherits WHERE inhparent = v_parent;
    v_created := v_created + (v_after - v_before);
  END LOOP;

  RETURN v_created;
END;
$$;

-- Call it once, here, so the schema is usable the moment it exists.
--
-- Without this line the file defines the function and never runs it, and a
-- freshly migrated database has NO partitions at all — not the month ones and
-- not the defaults. Every insert into usage_events and ledger_entries fails
-- with "no partition of relation ... found for row" until somebody knows to
-- call this by hand. That is the same defect adversarial case A5 names, moved
-- from four months ago to the first minute: money rejected for want of a
-- partition, with the schema reporting itself as fully migrated.
--
-- The DEFAULT partitions are the part that matters here. The month window will
-- run out — that is what the scheduled call in docs/OPERATIONS.md is for — but
-- a default that exists from the first statement means running out is a row in
-- the wrong place rather than a rejected write.
--
-- Idempotent, so re-running this file is a no-op: ensure_default_partition and
-- ensure_month_partition both return early when their partition is there, and
-- `billing-kit migrate` applies each file once in any case.
SELECT billing.ensure_core_partitions();
