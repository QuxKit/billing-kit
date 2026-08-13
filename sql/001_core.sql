-- billing-kit core schema: ingest and ledger.
--
-- Scope of this file: only the tables `src/events.ts` and `src/ledger.ts`
-- touch. Aggregates, charges, prices and the metering engine's own objects
-- live in their own numbered file, so the two can be reviewed apart.
--
-- UNRESOLVED, and it must be resolved before either file is applied anywhere
-- real: `sql/001_metering.sql` declares its own `billing.ledger_entries` with
-- a different shape (`account_id uuid` referencing a `ledger_accounts` table,
-- `leg text` constrained to debit/credit, `source_id uuid`). This file
-- declares `subject_id`, `account text`, `leg_no smallint`, `source_id text`.
-- Both use CREATE TABLE IF NOT EXISTS, so applying both does not error on the
-- table: the second one silently does nothing and then its indexes fail on
-- columns that do not exist. Verified by applying the two in order.
--
-- That is precisely the failure PROVENANCE.md records against the reference
-- application — two DDLs for one table, only one of which can be the deployed
-- shape. One of the two definitions has to win. Note when choosing that
-- `leg IN ('debit','credit')` cannot express the three-legged settlement
-- posting in docs/ARCHITECTURE.md §4.4, where a provider total differing from
-- the accrued total posts accrued, settled and variance.
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

CREATE INDEX IF NOT EXISTS ledger_entries_balance_idx
  ON billing.ledger_entries (tenant_id, subject_id, account, currency, posted_at);

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

-- Create the month partition covering `at`, plus its per-partition triggers.
--
-- Triggers are attached per partition rather than to the parent because
-- Postgres does not allow a BEFORE ROW trigger or a CONSTRAINT TRIGGER on a
-- partitioned table. Attaching them here means a partition created by any route
-- other than this function silently loses both the append-only guarantee and
-- the balance check — which is the failure the health check looks for.
CREATE OR REPLACE FUNCTION billing.ensure_month_partition(
  p_parent regclass,
  p_at     timestamptz
) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_start   timestamptz := date_trunc('month', p_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_end     timestamptz := v_start + interval '1 month';
  v_parent  text := replace(p_parent::text, 'billing.', '');
  v_child   text := format('%s_%s', v_parent, to_char(v_start AT TIME ZONE 'UTC', 'YYYYMM'));
BEGIN
  IF to_regclass('billing.' || quote_ident(v_child)) IS NOT NULL THEN
    RETURN v_child;
  END IF;

  EXECUTE format(
    'CREATE TABLE billing.%I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
    v_child, p_parent::text, v_start, v_end
  );

  EXECUTE format(
    'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON billing.%I
       FOR EACH ROW EXECUTE FUNCTION billing.reject_mutation()',
    v_child || '_append_only', v_child
  );

  IF v_parent = 'ledger_entries' THEN
    EXECUTE format(
      'CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON billing.%I
         DEFERRABLE INITIALLY DEFERRED
         FOR EACH ROW EXECUTE FUNCTION billing.assert_transaction_balanced()',
      v_child || '_balanced', v_child
    );
  END IF;

  RETURN v_child;
END;
$$;

-- Partitions are created ahead, never lazily on an insert failure. A missing
-- partition makes every insert into that range fail, and for usage_events that
-- means billable usage on the floor. Three weeks of headroom turns that into an
-- alert rather than an incident at midnight on the first of the month.
CREATE OR REPLACE FUNCTION billing.ensure_core_partitions(
  p_months_ahead integer DEFAULT 3,
  p_now          timestamptz DEFAULT now()
) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_created integer := 0;
  v_month   integer;
BEGIN
  -- Starts at -1 so a late event for last month still has somewhere to land.
  FOR v_month IN -1 .. p_months_ahead LOOP
    PERFORM billing.ensure_month_partition(
      'billing.usage_events'::regclass, p_now + (v_month || ' month')::interval);
    PERFORM billing.ensure_month_partition(
      'billing.ledger_entries'::regclass, p_now + (v_month || ' month')::interval);
    v_created := v_created + 2;
  END LOOP;
  RETURN v_created;
END;
$$;
