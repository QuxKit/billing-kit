-- billing-kit — the drain lease
--
--   psql -v ON_ERROR_STOP=1 -f sql/013_runs.sql
--
-- Three functions the driver in src/metering/driver.ts calls around its batch
-- loop: claim the lease, keep it, give it back. They exist as SQL rather than
-- as statements in TypeScript for one reason: claiming a lease is a read and a
-- write that must not interleave with another worker's, and that is a property
-- of one transaction, not of three round trips.
--
-- Why a lease row and not `pg_try_advisory_lock`, which ARCHITECTURE.md §5.4
-- specifies: the advisory lock is held by a CONNECTION. The executor the same
-- document recommends is a `pg.Pool`, which hands out a different connection
-- per query. The lock would be taken on connection 1, the batches would run on
-- connections 2..n knowing nothing about it, and the unlock would be attempted
-- on connection 5, where it does nothing and logs a warning nobody reads. The
-- guard would appear to work and would never once exclude anything.
--
-- The advisory lock is still used, but scoped to a single transaction
-- (pg_advisory_xact_lock) around the claim, where "one transaction" and "one
-- connection" are the same thing and the pool cannot break it.

/*
 * Claim the drain lease, or report that someone else holds it.
 *
 * Returns the run id, or NULL when a live run already holds the lease.
 *
 * The advisory lock makes the read and the insert atomic against another
 * claimer. Without it both workers evaluate NOT EXISTS against a snapshot that
 * cannot see the other's uncommitted row, both insert, and the lease excludes
 * nothing — the classic check-then-act, which is invisible in any test that
 * does not run two claims in the same millisecond.
 *
 * It is a transaction-scoped lock, so it is released at COMMIT and only ever
 * serialises the claim itself. The lease is what covers the drain.
 *
 * A run whose heartbeat has gone stale is treated as dead and its lease is
 * available. It is deliberately left with status 'running' rather than being
 * marked failed here: this function did not observe a failure, only a silence,
 * and a row that says 'failed' when nobody watched it fail is a worse record
 * than one that says 'running' with an old heartbeat. billing.metering_health()
 * reports it.
 */
CREATE OR REPLACE FUNCTION billing.claim_meter_run(
  p_runner text,
  p_lease  interval DEFAULT interval '5 minutes'
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('billing-kit:meter:claim'));

  IF EXISTS (
    SELECT 1 FROM billing.meter_runs
     WHERE status = 'running'
       AND heartbeat_at > now() - p_lease
  ) THEN
    RETURN NULL;
  END IF;

  INSERT INTO billing.meter_runs (runner, status)
  VALUES (p_runner, 'running')
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;


/*
 * Keep the lease. Called once per batch, which is often enough to be cheap and
 * frequent enough that a lease can be much shorter than a long drain.
 *
 * Returns the id it touched, or NULL if the row is no longer 'running' —
 * meaning something else settled this run. The driver stops rather than
 * continuing to bill under a lease it does not hold, which is the only way two
 * drains can end up running at once after a lease expiry.
 */
CREATE OR REPLACE FUNCTION billing.heartbeat_meter_run(p_id uuid)
RETURNS uuid
LANGUAGE sql AS $$
  UPDATE billing.meter_runs
     SET heartbeat_at = now()
   WHERE id = p_id AND status = 'running'
  RETURNING id;
$$;


/*
 * Settle the run row.
 *
 * Called from TypeScript, outside the batch transaction, on every exit path
 * including the failing one. §5.2(e): the reference implementation recorded its
 * failure inside a PL/pgSQL EXCEPTION handler that then RAISEd, and the RAISE
 * rolled the record back along with everything else. Recording a failure from
 * inside the transaction that failed cannot work, and it fails in the way that
 * leaves no evidence it was ever tried.
 *
 * Idempotent on status: settling an already-settled run is a no-op, so a
 * driver that both catches an error and hits its finally block writes one
 * outcome rather than overwriting the interesting one with the tidy one.
 */
CREATE OR REPLACE FUNCTION billing.settle_meter_run(
  p_id                 uuid,
  p_status             text,
  p_iterations         integer,
  p_items_billed       bigint,
  p_minutes_billed     bigint,
  p_items_suspended    bigint,
  p_accounts_updated   bigint,
  p_amount_by_currency jsonb,
  p_duration_ms        integer,
  p_error              text DEFAULT NULL,
  p_error_code         text DEFAULT NULL
) RETURNS uuid
LANGUAGE sql AS $$
  UPDATE billing.meter_runs
     SET status             = p_status,
         finished_at        = now(),
         heartbeat_at       = now(),
         iterations         = p_iterations,
         items_billed       = p_items_billed,
         minutes_billed     = p_minutes_billed,
         items_suspended    = p_items_suspended,
         accounts_updated   = p_accounts_updated,
         amount_by_currency = p_amount_by_currency,
         duration_ms        = p_duration_ms,
         error              = p_error,
         error_code         = p_error_code
   WHERE id = p_id AND status = 'running'
  RETURNING id;
$$;
