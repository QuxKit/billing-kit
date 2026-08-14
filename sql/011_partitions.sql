-- billing-kit — partition management for the metering tables
--
--   psql -v ON_ERROR_STOP=1 -f sql/011_partitions.sql
--   SELECT billing.ensure_partitions();      -- idempotent, run it every drain
--
-- `billing.charges` is declared PARTITION BY RANGE in 010 and created with no
-- partitions. This file supplies the function that fills them in, and it must
-- be run before the first charge is written.
--
-- `billing.ledger_entries` is kept ahead here too, because meter_batch writes
-- to it and the driver calls this function before every drain. It is declared
-- in sql/001_core.sql, which has its own billing.ensure_core_partitions() that
-- does the same job — and two partition managers for one table is normally how
-- you get "partition would overlap partition" every month forever, from
-- whichever one runs second.
--
-- What makes both safe is that neither one creates partitions itself: both
-- delegate to billing.ensure_month_partition() from 001_core, which is keyed on
-- the child's name, returns early when it already exists, and computes one set
-- of UTC-anchored boundaries. Same names, same ranges, same DEFAULT backstop,
-- same reconciliation of rows already sitting in the default. Duplicating that
-- logic here — which is what this file used to do, with a different month-end
-- calculation — is what would make them conflict.
--
-- Partitions are created AHEAD, never lazily on an insert failure (§6.3). A
-- missing partition makes every insert into that range fail; handling that by
-- catching the error and creating the partition means the first insert of every
-- month takes an exception path and an ACCESS EXCLUSIVE lock under load, on the
-- one code path that is holding a billing transaction open.
--
-- There is no expiry function here on purpose. §6.5 sets retention for both of
-- these tables to `never` — they are the financial record — so there is no
-- supported way to delete them and shipping a function that could would be
-- shipping the mistake. Erasure is served by redacting subject PII in the
-- subject table, which these reference by id.

/*
 * Create monthly partitions for the tables meter_batch writes — `charges` and
 * `ledger_entries` — plus a DEFAULT partition for each.
 * Idempotent, cheap when there is nothing to do, safe to call from every drain.
 *
 * Returns the number of partitions created, which is 0 on every call but the
 * first of each month. A non-zero return from a run that was not expected to
 * create anything is worth logging.
 *
 * p_months_behind exists because of catch-up. An item last billed six months
 * ago settles a window whose window_start is six months in the past, so the
 * charge lands in a partition for a month that has already gone by. A forward-
 * only implementation works perfectly until the first long outage and then
 * fails on the recovery, which is the worst possible moment to discover it.
 * The DEFAULT partition is the backstop for a gap wider than p_months_behind.
 *
 * The DEFAULT partition is a deliberate trade, not an oversight. Cost: while it
 * is NON-EMPTY, creating the next month's partition has to reconcile it under
 * ACCESS EXCLUSIVE. Benefit: a charge outside every declared range is stored
 * instead of raising, and a raise here means refusing to record money already
 * owed. The trade is acceptable because the default is expected to stay empty
 * and because it is watched: billing.partition_report() below reports its row
 * count and billing.metering_health() raises a fault when it is not zero, so it
 * is an alert weeks ahead rather than a locked table at month end.
 *
 * Both the month partitions and the default come from 001_core's
 * billing.ensure_month_partition() / billing.ensure_default_partition(), which
 * is also what moves rows out of a non-empty default and into the new month
 * rather than failing on them. See their comments; the reasoning is long and it
 * belongs in one place.
 */
CREATE OR REPLACE FUNCTION billing.ensure_partitions(
  p_months_ahead  integer DEFAULT 3,
  p_months_behind integer DEFAULT 1
) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_created integer := 0;
  v_parent  regclass;
  v_before  integer;
  v_after   integer;
  v_month   timestamp;
BEGIN
  IF p_months_ahead < 1 THEN
    RAISE EXCEPTION 'ensure_partitions: p_months_ahead must be at least 1, got %', p_months_ahead;
  END IF;
  IF p_months_behind < 0 THEN
    RAISE EXCEPTION 'ensure_partitions: p_months_behind cannot be negative, got %', p_months_behind;
  END IF;

  FOREACH v_parent IN ARRAY ARRAY['billing.charges'::regclass,
                                  'billing.ledger_entries'::regclass] LOOP

    SELECT count(*) INTO v_before FROM pg_inherits WHERE inhparent = v_parent;

    -- The default first, so that from here on there is no instant at which a
    -- row for an unexpected month has nowhere to go.
    PERFORM billing.ensure_default_partition(v_parent);

    FOR v_month IN
      SELECT generate_series(
               -- Anchored to UTC, not to the session's TimeZone.
               --
               -- date_trunc('month', now()) is evaluated in whatever TimeZone
               -- the connection happens to carry, so the same statement run
               -- from two differently-configured pools produces boundaries an
               -- hour or a day apart. The partitions then overlap, and Postgres
               -- reports that as a CREATE failure months after the mistake, on
               -- a machine that did nothing wrong.
               date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(months => p_months_behind),
               date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => p_months_ahead),
               interval '1 month')
    LOOP
      PERFORM billing.ensure_month_partition(v_parent, v_month AT TIME ZONE 'UTC');
    END LOOP;

    -- Counted from the catalog, so the number is what was created and not how
    -- many times the loop went round.
    SELECT count(*) INTO v_after FROM pg_inherits WHERE inhparent = v_parent;
    v_created := v_created + (v_after - v_before);

  END LOOP;

  RETURN v_created;
END;
$$;


/*
 * What partitions actually exist, for the `--check` mode and the health
 * endpoint.
 *
 * The point of reporting from the catalog rather than from the schema
 * definition is that the schema definition is what someone intended. §6.2 is
 * about a `prisma db push` that produces a plain unpartitioned table and warns
 * about nothing; the only way to know which one you have is to ask the
 * database, so that is what this does.
 *
 * `live_rows` is exact rather than an estimate. It is only ever called against
 * the partition list, which is dozens of rows, and an estimate of zero from a
 * never-analysed default partition is precisely the wrong answer to give to a
 * check whose whole job is noticing that the default is not empty.
 */
CREATE OR REPLACE FUNCTION billing.partition_report()
RETURNS TABLE (
  parent         text,
  partition_name text,
  is_default     boolean,
  bounds         text,
  live_rows      bigint
)
LANGUAGE plpgsql AS $$
DECLARE
  v_row record;
  v_n   bigint;
BEGIN
  FOR v_row IN
    SELECT p.relname                     AS child,
           c.relname                     AS parent,
           pg_get_expr(p.relpartbound, p.oid) AS bounds
      FROM pg_class c
      JOIN pg_inherits i ON i.inhparent = c.oid
      JOIN pg_class p    ON p.oid = i.inhrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'billing'
       -- `usage_events` and `ledger_entries` belong to sql/001_core.sql and are
       -- created by its ensure_core_partitions(), not by this file. They are
       -- reported here anyway, because reporting is not ownership and because
       -- this is the only surface that answers "is a default partition filling
       -- up" — the question a DEFAULT partition exists in order to raise. A
       -- second report keyed to the core tables would be a second place to look
       -- during the incident that made you look at all.
       AND c.relname IN ('charges', 'ledger_entries', 'usage_events')
     ORDER BY c.relname, p.relname
  LOOP
    EXECUTE format('SELECT count(*) FROM billing.%I', v_row.child) INTO v_n;
    parent         := v_row.parent;
    partition_name := v_row.child;
    is_default     := v_row.bounds = 'DEFAULT';
    bounds         := v_row.bounds;
    live_rows      := v_n;
    RETURN NEXT;
  END LOOP;
END;
$$;


/*
 * One call the health endpoint and the `--check` mode both use.
 *
 * Returns a fault list rather than a boolean. "Unhealthy" with no reason is a
 * page that starts with someone reading source at 3am; the reasons are cheap to
 * compute here and impossible to reconstruct there.
 */
CREATE OR REPLACE FUNCTION billing.metering_health()
RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_faults    jsonb := '[]'::jsonb;
  v_parent    text;
  v_partitioned boolean;
  v_ahead     integer;
  v_default   bigint;
  v_stuck     bigint;
BEGIN
  -- Same three tables partition_report() covers, and for the same reason: a
  -- default partition that is filling up is the fault this function exists to
  -- surface, and it is no less a fault on the core tables than on `charges`.
  -- The month partitions of the two core tables are created by 001_core's
  -- ensure_core_partitions(); a runway that stops growing is what this reports.
  FOREACH v_parent IN ARRAY ARRAY['charges', 'ledger_entries', 'usage_events'] LOOP

    -- The §6.2 check, stated as a question to the catalog: is this table
    -- actually partitioned, or is it the plain table `db push` leaves behind?
    SELECT c.relkind = 'p' INTO v_partitioned
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'billing' AND c.relname = v_parent;

    IF v_partitioned IS NULL THEN
      v_faults := v_faults || jsonb_build_object('fault', 'missing_table', 'table', v_parent);
      CONTINUE;
    ELSIF NOT v_partitioned THEN
      v_faults := v_faults || jsonb_build_object('fault', 'not_partitioned', 'table', v_parent);
      CONTINUE;
    END IF;

    -- How many months of runway. Fewer than two means the next month's inserts
    -- are one forgotten cron away from the default partition.
    SELECT count(*) INTO v_ahead
      FROM billing.partition_report() r
     WHERE r.parent = v_parent
       AND NOT r.is_default
       AND r.partition_name >= format('%s_%s', v_parent, to_char(now() AT TIME ZONE 'UTC', 'YYYY"m"MM'));

    IF v_ahead < 2 THEN
      v_faults := v_faults || jsonb_build_object(
        'fault', 'partition_runway_low', 'table', v_parent, 'monthsAhead', v_ahead);
    END IF;

    SELECT coalesce(sum(r.live_rows), 0) INTO v_default
      FROM billing.partition_report() r
     WHERE r.parent = v_parent AND r.is_default;

    IF v_default > 0 THEN
      v_faults := v_faults || jsonb_build_object(
        'fault', 'default_partition_not_empty', 'table', v_parent, 'rows', v_default);
    END IF;

  END LOOP;

  -- A run that claimed the lease and stopped heartbeating. Either a worker was
  -- killed mid-drain or one is wedged; both are worth knowing and neither shows
  -- up in a count of successful runs. Measured from heartbeat_at, not
  -- started_at, so a legitimately long drain is not reported as stuck.
  SELECT count(*) INTO v_stuck
    FROM billing.meter_runs
   WHERE status = 'running' AND heartbeat_at < now() - interval '15 minutes';

  IF v_stuck > 0 THEN
    v_faults := v_faults || jsonb_build_object('fault', 'runs_stuck', 'count', v_stuck);
  END IF;

  RETURN jsonb_build_object(
    'ok',     jsonb_array_length(v_faults) = 0,
    'faults', v_faults);
END;
$$;
