-- billing-kit — the metering batch
--
--   psql -v ON_ERROR_STOP=1 -f sql/012_meter_batch.sql
--
-- One bounded batch, one transaction, called in a loop by the driver in
-- src/metering/driver.ts until the queue is drained.
--
-- Two properties this file exists to hold, in order of how much they cost when
-- lost:
--
--   1. A minute of elapsed time is charged exactly once. Never twice, and never
--      not at all. Everything else here is subordinate to that.
--   2. One call is bounded work, whatever the state of the queue. A run whose
--      duration is a function of how long you were down is a run that turns an
--      outage into a longer outage.
--
-- Read alongside ARCHITECTURE.md §5. Where this file departs from the sketch
-- there, it says so and why.


/*
 * Round half to even, on numeric.
 *
 * Postgres `round(numeric)` rounds half AWAY FROM ZERO. That is not the
 * documented rule (§3.5) and the difference is not academic: a per-minute rate
 * whose product lands on a half-unit does so on every single interval, not
 * occasionally, so half-up is a systematic overcharge in one direction for the
 * whole life of the subscription rather than noise that cancels.
 *
 * `round(double precision)` does round half-to-even, which is the trap — the
 * behaviour is available, in the type that must not be used for money.
 *
 * Ties are broken toward the even neighbour. floor() is toward negative
 * infinity, so the negative cases fall out without a sign branch: -2.5 has
 * floor -3, which is odd, so it goes to -2, which is even and correct.
 */
CREATE OR REPLACE FUNCTION billing.round_half_even(v numeric)
RETURNS numeric
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE
    WHEN v - floor(v) > 0.5 THEN floor(v) + 1
    WHEN v - floor(v) < 0.5 THEN floor(v)
    WHEN floor(v) % 2 = 0   THEN floor(v)
    ELSE floor(v) + 1
  END;
$$;


/*
 * Bill one bounded batch of due items.
 *
 * p_batch       — at most this many items are locked and settled per call.
 * p_max_minutes — at most this many minutes are settled per item per call.
 *
 * Returns one row. `amount_by_currency` is a jsonb object of minor-unit totals
 * as strings, keyed by currency: {"USD": "12940"}. Not a single total, because
 * a sum across currencies is a category error that reads like a number; and
 * strings, because jsonb numbers become IEEE-754 doubles the moment JSON.parse
 * sees them.
 *
 * MUST be called at most once per transaction. Calling it twice is not unsafe,
 * but the second call sees the first call's own locks and its own advanced
 * grid, so it reports an empty batch and the driver reads that as "drained".
 * The driver opens a transaction per call for exactly this reason.
 *
 * now() here is transaction_timestamp(), so every item in a batch is measured
 * against one instant. clock_timestamp() would move between the CTEs of the
 * same statement and put two items on grids that disagree by microseconds,
 * which is invisible for a year and then shows up as an off-by-one-minute
 * dispute nobody can reconstruct.
 *
 * The database clock is the authority for anything that becomes an interval
 * boundary (§5.4). The driver's injected clock is for its own deadlines and for
 * tests, never for a boundary: two app servers 400ms apart otherwise write
 * overlapping intervals, and an overlap is not recoverable after the fact
 * because there is no record of which one was right.
 */
CREATE OR REPLACE FUNCTION billing.meter_batch(
  p_batch       integer DEFAULT 500,
  p_max_minutes integer DEFAULT 1440
) RETURNS TABLE (
  items_billed       integer,
  minutes_billed     bigint,
  amount_by_currency jsonb,
  accounts_updated   integer,
  items_suspended    integer
)
LANGUAGE plpgsql AS $$
DECLARE
  v_items     integer;
  v_minutes   bigint;
  v_amounts   jsonb;
  v_accounts  integer;
  v_debits    integer;
  v_credits   integer;
  v_ids       uuid[];
  v_suspended integer := 0;
BEGIN
  IF p_batch IS NULL OR p_batch < 1 THEN
    RAISE EXCEPTION 'meter_batch: p_batch must be at least 1, got %', p_batch
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- An unbounded catch-up is the failure this parameter exists to prevent, so
  -- there is no "0 means unlimited" escape hatch. See the cap's comment below.
  IF p_max_minutes IS NULL OR p_max_minutes < 1 THEN
    RAISE EXCEPTION 'meter_batch: p_max_minutes must be at least 1, got %', p_max_minutes
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- One statement. Every CTE is consumed by the next one or by the final
  -- SELECT — there is no CTE here that a reader has to take on faith executes.
  --
  -- (The reference implementation's pipeline had two data-modifying CTEs that
  -- nothing referenced. Postgres does run them exactly once, so it was correct,
  -- but a reviewer cannot tell that by reading it. Chaining the CTEs is a
  -- better answer than splitting them into statements: it keeps the set-based
  -- shape and the single snapshot, and makes the execution order a data
  -- dependency rather than a promise.)
  WITH due AS (
    -- Claim the queue.
    --
    -- Only `id` is selected, deliberately. Under READ COMMITTED, a row updated
    -- by a transaction that committed after this statement's snapshot is
    -- re-fetched and re-checked by EvalPlanQual, so a locking scan can return a
    -- NEWER version of a row than the rest of the statement sees. Taking only
    -- the id here means every other column is read once, from one snapshot, by
    -- the plain join below — and the compare-and-set in `claimed` is then a
    -- comparison between two values that came from the same place.
    --
    -- ORDER BY is load-bearing, not tidiness: with LIMIT and no ORDER BY the
    -- set of items that make progress is whatever the plan happened to reach
    -- first, and an item can starve behind a churning head of the table
    -- indefinitely while every run reports success.
    --
    -- `last_billed_at <= now() - interval '1 minute'` and not
    -- `last_billed_at + interval '1 minute' <= now()`. They are the same
    -- predicate; only the first one can use billable_items_due, because an
    -- expression on the indexed column is not an index scan. The reference
    -- implementation wrote it the second way.
    --
    -- SKIP LOCKED: rows a sibling worker holds are passed over rather than
    -- queued behind, so N workers do N times the work instead of taking turns.
    SELECT id
      FROM billing.billable_items
     WHERE status = 'active'
       AND last_billed_at <= now() - interval '1 minute'
     ORDER BY last_billed_at
     LIMIT p_batch
     FOR UPDATE SKIP LOCKED
  ),
  priced AS (
    SELECT
      r.id,
      r.tenant_id,
      r.subject_id,
      r.metric,
      r.currency,
      r.rate_per_minute,
      r.last_billed_at,
      m.minutes,
      r.last_billed_at + make_interval(mins => m.minutes) AS window_end,
      -- Rounded once, here, at the charge (§3.5). Not per minute — rounding
      -- each minute of a 1,440-minute catch-up rounds 1,440 times and the error
      -- grows with the row count. Not at the invoice — the ledger and the
      -- invoice then disagree by the residue and neither is wrong.
      (m.minutes * r.rate_per_minute)                             AS amount_exact,
      billing.round_half_even(m.minutes * r.rate_per_minute)::bigint AS amount_minor
      FROM due d
      JOIN billing.billable_items r ON r.id = d.id
      CROSS JOIN LATERAL (
        SELECT least(
                 -- Whole elapsed minutes since the grid point.
                 --
                 -- Differencing two epochs rather than taking the epoch of an
                 -- interval. Both forms give the same answer for two
                 -- timestamptz values — checked, not assumed: `a - b`
                 -- normalises to absolute seconds and re-expresses them as
                 -- 24-hour days, so a DST transition is already accounted for
                 -- and extract(epoch) reverses it exactly.
                 --
                 -- This form is kept because the equivalence is a property of
                 -- the operand TYPES, not of the expression. An interval that
                 -- carries a months component resolves a month as exactly 30
                 -- days, and any future edit that lets one in here — a grace
                 -- period expressed as `interval '1 month'`, a column widened
                 -- to interval — silently acquires that error. Two epochs
                 -- cannot: there is no calendar left in the subtraction.
                 --
                 -- extract(epoch ...) returns numeric in PG14+, so this is
                 -- exact arithmetic and not float.
                 floor((extract(epoch FROM now()) - extract(epoch FROM r.last_billed_at)) / 60),

                 -- The cap. Two reasons, and the second is the real one.
                 --
                 -- Recovery becomes O(downtime / cap) instead of O(downtime):
                 -- the reference advanced exactly one minute per run, so six
                 -- hours down needed 360 runs. That is the gap this fixes.
                 --
                 -- But uncapped elapsed settlement replaces it with a worse
                 -- one. An item untouched for a year settles 525,600 minutes in
                 -- a single charge, taking a prepaid balance to a number nobody
                 -- authorised, in one statement, with no opportunity for the
                 -- balance guard to suspend at the minute the money ran out.
                 -- The cap is what gives the guard a turn between chunks.
                 p_max_minutes
               )::integer AS minutes
      ) m
  ),
  claimed AS (
    -- Advance the grid, and let the advance BE the claim.
    --
    -- The compare-and-set on last_billed_at is the single most important
    -- predicate in this file. Concretely, the race it closes:
    --
    --   worker A commits a charge for item X at time T, advancing X from L to
    --   L+5. Worker B's statement snapshot was taken just before T, so B's scan
    --   sees X at L and computes a window starting at L — a window A has
    --   already billed. B's locking scan does not skip X, because A has already
    --   released the lock.
    --
    -- When this UPDATE reaches X it finds a newer committed version, runs
    -- EvalPlanQual, and re-checks the predicate against it: L+5 = L is false,
    -- so the row is not updated, `claimed` does not emit it, and no charge is
    -- written. X is simply picked up by the next batch, from L+5, which is
    -- where it should start.
    --
    -- Without the CAS that row is a double charge, and it is a double charge
    -- that appears only under concurrency, only in a sub-millisecond window,
    -- and never in a single-threaded test.
    --
    -- `SET last_billed_at = window_end` and never `= now()`. now() discards the
    -- sub-minute remainder on every single run — 40 seconds a minute-boundary,
    -- compounding, until the item's grid has drifted far enough that the
    -- customer's invoice and their own logs disagree about how long anything
    -- ran. Advancing by the settled minutes keeps consecutive windows exactly
    -- contiguous, which is what makes the contiguity assertion in the
    -- concurrency test a real check rather than a tautology.
    UPDATE billing.billable_items r
       SET last_billed_at = p.window_end
      FROM priced p
     WHERE r.id = p.id
       AND r.last_billed_at = p.last_billed_at
       AND r.status = 'active'
    RETURNING
      r.id            AS item_id,
      p.tenant_id,
      p.subject_id,
      p.metric,
      p.currency,
      p.rate_per_minute,
      p.minutes,
      p.last_billed_at AS window_start,
      p.window_end,
      p.amount_exact,
      p.amount_minor
  ),
  charged AS (
    -- Deliberately NOT `ON CONFLICT (item_id, window_start) DO NOTHING`, which
    -- is what ARCHITECTURE.md §5.3 sketched.
    --
    -- DO NOTHING silently drops the charge while `claimed` has already moved
    -- the grid past that window in the same transaction. The clock advances,
    -- the money does not, and the row that would have said so is the row that
    -- was skipped. That is a quiet revenue loss, and quiet revenue loss is
    -- worse than a loud abort.
    --
    -- The replay-safety that DO NOTHING was there to provide is already
    -- provided, better, by the compare-and-set above: a replayed batch reads
    -- the advanced grid and computes a DIFFERENT window, so there is nothing to
    -- conflict with. A conflict here therefore means an invariant is broken —
    -- most plausibly that someone moved last_billed_at backwards by hand — and
    -- the correct response to a broken invariant is to abort the transaction,
    -- which is what the unique violation does.
    INSERT INTO billing.charges (
      tenant_id, subject_id, item_id, metric,
      window_start, window_end, quantity, rate,
      amount_minor, amount_exact, currency)
    SELECT
      c.tenant_id, c.subject_id, c.item_id, c.metric,
      c.window_start, c.window_end, c.minutes, c.rate_per_minute,
      c.amount_minor, c.amount_exact, c.currency
      FROM claimed c
    RETURNING id, tenant_id, subject_id, item_id, currency, amount_minor, quantity
  ),
  -- Two legs, signed, summing to zero. `leg` is a discriminator for the
  -- idempotency key, not the accounting sign — the sign is in amount_minor.
  --
  -- customer_balance is signed from the subject's point of view: positive means
  -- funded, so a charge subtracts. That is the convention the balance guard
  -- below reads, and it is stated here rather than inferred from the guard.
  debit AS (
    INSERT INTO billing.ledger_entries (
      transaction_id, tenant_id, account_id, amount_minor, currency,
      source_kind, source_id, leg, memo)
    SELECT ch.id, ch.tenant_id, a.id, -ch.amount_minor, ch.currency,
           'charge', ch.id, 'debit', 'elapsed-time metering'
      FROM charged ch
      JOIN billing.ledger_accounts a
        ON  a.tenant_id  = ch.tenant_id
        AND a.subject_id = ch.subject_id
        AND a.kind       = 'customer_balance'
        AND a.currency   = ch.currency
    RETURNING account_id, amount_minor
  ),
  credit AS (
    INSERT INTO billing.ledger_entries (
      transaction_id, tenant_id, account_id, amount_minor, currency,
      source_kind, source_id, leg, memo)
    SELECT ch.id, ch.tenant_id, a.id, ch.amount_minor, ch.currency,
           'charge', ch.id, 'credit', 'elapsed-time metering'
      FROM charged ch
      JOIN billing.ledger_accounts a
        ON  a.tenant_id  = ch.tenant_id
        AND a.subject_id = ch.subject_id
        AND a.kind       = 'revenue_accrued'
        AND a.currency   = ch.currency
    RETURNING account_id, amount_minor
  ),
  movements AS (
    SELECT m.account_id, sum(m.amount_minor) AS delta
      FROM (SELECT account_id, amount_minor FROM debit
            UNION ALL
            SELECT account_id, amount_minor FROM credit) m
     GROUP BY m.account_id
  ),
  locks AS MATERIALIZED (
    -- Take every account lock this batch needs, in id order, before touching
    -- any of them.
    --
    -- Without this, `balances` locks accounts in whatever order its plan
    -- produces. Two workers hold disjoint ITEM sets — SKIP LOCKED guarantees
    -- that — but two items in different batches routinely belong to the same
    -- subject, so the ACCOUNT sets overlap. Worker A takes X then Y while
    -- worker B takes Y then X and one of them is rolled back by the deadlock
    -- detector, discarding a batch that had already done all its work.
    --
    -- MATERIALIZED is required, not stylistic. Inlined, this becomes a semi-
    -- join evaluated as `balances` scans, and the ordering it exists to impose
    -- disappears into the plan. Materialised, it is a tuplestore that must be
    -- filled before `balances` can read it, so the locks are taken in sorted
    -- order and the dependency is visible to the planner.
    SELECT a.id
      FROM billing.ledger_accounts a
     WHERE a.id IN (SELECT m.account_id FROM movements m)
     ORDER BY a.id
     FOR UPDATE
  ),
  balances AS (
    -- Maintained in the same transaction as the entries that move it, so the
    -- balance guard below reads a number that includes this batch. A cache
    -- refreshed by a separate job would let an item bill one more interval
    -- after the money ran out, every time.
    UPDATE billing.ledger_accounts a
       SET balance_minor = a.balance_minor + m.delta,
           updated_at    = now()
      FROM movements m
     WHERE a.id = m.account_id
       AND a.id IN (SELECT l.id FROM locks l)
    RETURNING a.id
  )
  SELECT
    (SELECT count(*) FROM charged)::integer,
    (SELECT coalesce(sum(c.quantity), 0) FROM charged c)::bigint,
    (SELECT coalesce(jsonb_object_agg(g.currency, g.total::text), '{}'::jsonb)
       FROM (SELECT c.currency, sum(c.amount_minor) AS total
               FROM charged c GROUP BY c.currency) g),
    (SELECT count(*) FROM balances)::integer,
    (SELECT count(*) FROM debit)::integer,
    (SELECT count(*) FROM credit)::integer,
    (SELECT coalesce(array_agg(c.item_id), ARRAY[]::uuid[]) FROM charged c)
  INTO v_items, v_minutes, v_amounts, v_accounts, v_debits, v_credits, v_ids;

  -- The join in `debit`/`credit` is an inner join, so a subject with no ledger
  -- account would lose its legs and keep its charge: billed, grid advanced, no
  -- ledger record, nothing raised. The trigger in 001 is what makes that
  -- impossible; this is what makes it detected. Asserting a fact costs one
  -- comparison and removes a whole class of "the ledger doesn't reconcile and
  -- nobody knows since when".
  IF v_debits <> v_items OR v_credits <> v_items THEN
    RAISE EXCEPTION
      'meter_batch: % charges produced % debit and % credit legs; a ledger account is missing for a billed subject',
      v_items, v_debits, v_credits
      USING ERRCODE = 'data_exception';
  END IF;

  -- The balance guard.
  --
  -- Same transaction as the charge, so an item cannot be billed again after the
  -- balance went negative. The trade is stated rather than hidden: an item may
  -- overdraft by at most one interval, because the alternative is refusing to
  -- bill for time the customer has already consumed, and that is a worse
  -- answer to give an auditor than a bounded overdraft.
  --
  -- Restricted to `v_ids` — the items this transaction already holds locks on.
  -- Suspending every item belonging to an underwater subject would be more
  -- thorough, but it would take locks on rows a sibling worker may hold, in an
  -- order nothing controls, which is the deadlock `locks` above just went to
  -- some trouble to avoid. The rest of the subject's items suspend on their own
  -- next batch, at most one interval later.
  UPDATE billing.billable_items r
     SET status       = 'suspended',
         suspended_at = now()
    FROM billing.ledger_accounts a
   WHERE r.id = ANY (v_ids)
     AND r.status      = 'active'
     AND a.tenant_id   = r.tenant_id
     AND a.subject_id  = r.subject_id
     AND a.kind        = 'customer_balance'
     AND a.currency    = r.currency
     AND a.balance_minor < 0;

  GET DIAGNOSTICS v_suspended = ROW_COUNT;

  RETURN QUERY SELECT v_items, v_minutes, v_amounts, v_accounts, v_suspended;
END;
$$;
