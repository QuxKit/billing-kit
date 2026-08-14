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
  v_items        integer;
  v_minutes      bigint;
  v_amounts      jsonb;
  v_accounts     integer;
  v_transactions integer;
  v_legs         integer;
  v_ids          uuid[];
  v_suspended    integer := 0;
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
  posted AS (
    -- The transaction row, one per charge, in billing.ledger_transactions
    -- (sql/001_core.sql). This is where posting idempotency actually lives:
    -- UNIQUE (tenant_id, source_kind, source_id) on an UNPARTITIONED table, so
    -- it holds across the whole ledger rather than within one partition.
    --
    -- Deliberately no ON CONFLICT, for the same reason `charged` has none: a
    -- conflict here means charge id X has already been posted, and a charge id
    -- is generated once by the INSERT above. It cannot collide unless an
    -- invariant is already broken, and the right answer to a broken invariant
    -- is to abort rather than to write a charge with no ledger legs.
    --
    -- `id` is the charge id, so `transaction_id` on the entries below names the
    -- charge that caused them without a join through anything else.
    INSERT INTO billing.ledger_transactions (id, tenant_id, source_kind, source_id, posted_at)
    SELECT ch.id, ch.tenant_id, 'charge', ch.id::text, now()
      FROM charged ch
    RETURNING id
  ),
  legs AS (
    -- Two legs, signed, summing to zero, in 001_core's columns and 001_core's
    -- sign convention: positive is a debit, negative is a credit.
    --
    -- The signs are the mirror of what this file used to write, and the flip is
    -- the substance of migrating onto the canonical shape rather than a detail
    -- of it. This engine used to treat customer_balance as a prepaid wallet
    -- seen from the subject — positive means funded, a charge subtracts.
    -- src/ledger.ts's accrualPosting() treats it as a receivable seen from us —
    -- a charge ADDS to what the customer owes, and a payment subtracts (see
    -- paymentPosting()). Both are coherent; they are not both possible in one
    -- table. A charge posted by this function and a charge posted by
    -- `post(accrualPosting(...))` would otherwise move the same account in
    -- opposite directions, and no balance in the system would mean anything.
    --
    -- leg_no 0 and 1 in that order, matching accrualPosting()'s leg order, so
    -- an entry written here is indistinguishable from one written by the
    -- library. `legNo` is the ordinal in the posting, not an accounting sign;
    -- the sign is in amount_minor.
    INSERT INTO billing.ledger_entries (
      id, transaction_id, tenant_id, subject_id, account, currency,
      amount_minor, leg_no, source_kind, source_id, posted_at, memo)
    SELECT gen_random_uuid(), ch.id, ch.tenant_id, ch.subject_id, l.account, ch.currency,
           l.amount_minor, l.leg_no, 'charge', ch.id::text, now(), 'elapsed-time metering'
      FROM charged ch
      CROSS JOIN LATERAL (VALUES
        ('customer_balance',  ch.amount_minor, 0::smallint),
        ('revenue_accrued',  -ch.amount_minor, 1::smallint)
      ) AS l(account, amount_minor, leg_no)
    RETURNING tenant_id, subject_id, account, currency
  )
  SELECT
    (SELECT count(*) FROM charged)::integer,
    (SELECT coalesce(sum(c.quantity), 0) FROM charged c)::bigint,
    (SELECT coalesce(jsonb_object_agg(g.currency, g.total::text), '{}'::jsonb)
       FROM (SELECT c.currency, sum(c.amount_minor) AS total
               FROM charged c GROUP BY c.currency) g),
    -- Distinct accounts this batch moved. The same number the old cached-balance
    -- UPDATE reported, computed from the legs instead of from the rows it wrote
    -- to a cache: two per (subject, currency) that was billed.
    (SELECT count(*) FROM (
       SELECT DISTINCT tenant_id, subject_id, account, currency FROM legs) a)::integer,
    (SELECT count(*) FROM posted)::integer,
    (SELECT count(*) FROM legs)::integer,
    (SELECT coalesce(array_agg(c.item_id), ARRAY[]::uuid[]) FROM charged c)
  INTO v_items, v_minutes, v_amounts, v_accounts, v_transactions, v_legs, v_ids;

  -- Every charge got one transaction row and two legs.
  --
  -- Cheaper than it looks and worth keeping even though the LATERAL above makes
  -- a missing leg hard to imagine: `posted` and `legs` are data-modifying CTEs
  -- whose results nothing else consumes, and counting them here is what makes
  -- their execution a fact a reader can check rather than a promise. The legs
  -- summing to zero is enforced separately and at COMMIT, by 001_core's
  -- deferred assert_transaction_balanced() constraint trigger.
  IF v_transactions <> v_items OR v_legs <> 2 * v_items THEN
    RAISE EXCEPTION
      'meter_batch: % charges produced % ledger transactions and % legs; expected % and %',
      v_items, v_transactions, v_legs, v_items, 2 * v_items
      USING ERRCODE = 'data_exception';
  END IF;

  -- The balance guard.
  --
  -- Same transaction as the charge, so an item cannot be billed again after the
  -- customer went past what they have paid for. The trade is stated rather than
  -- hidden: an item may overdraft by at most one interval, because the
  -- alternative is refusing to bill for time the customer has already consumed,
  -- and that is a worse answer to give an auditor than a bounded overdraft.
  --
  -- `> 0` and not `< 0`, because customer_balance is a receivable under
  -- 001_core's convention: charges add to it, payments subtract. A positive
  -- balance is a customer who has consumed more than they have funded. See the
  -- sign note on `legs` above.
  --
  -- DERIVED, not read from a cache, and this is the one place the cost of that
  -- decision lands. sql/010_metering.sql's `ledger_accounts` used to carry a
  -- balance_minor column that this guard read in a single indexed lookup; it is
  -- gone because it was maintained by this function alone, so every payment
  -- posted through src/ledger.ts desynchronised it silently. The number below
  -- is the same one `balance()` returns, by construction.
  --
  -- What it costs. Verified on PostgreSQL 17: this predicate is served by
  -- ledger_entries_balance_idx as an **Index Only Scan with Heap Fetches: 0**,
  -- which is what INCLUDE (amount_minor) on that index is for — the aggregate
  -- reads the index and never visits the heap. Confirmed from EXPLAIN (ANALYZE,
  -- BUFFERS) against a migrated database.
  --
  -- No millisecond figures are quoted here on purpose. An earlier revision of
  -- this comment carried a table of them and they could not be reproduced, which
  -- makes them worse than absent: a number in a comment is read as measured, and
  -- the next person sizes a batch against it. If you need them, measure on your
  -- own hardware and data — and note that a synthetic fixture is easy to get
  -- wrong here, because assert_transaction_balanced() is a DEFERRED FOR EACH ROW
  -- constraint trigger that sums the whole transaction, so loading a fixture as
  -- one transaction with N legs costs O(N^2) at commit and measures the fixture
  -- rather than this guard. Real postings have two or three legs.
  --
  -- The shape of the cost is the part that matters and it does not need a
  -- benchmark: this sums a subject's entry history, so the guard costs the total
  -- history of the subjects in the batch, NOT the size of the batch. It is
  -- linear and unbounded in that history, and it is the same work `balance()` in
  -- src/ledger.ts does on every call.
  --
  -- When that stops being acceptable, the answer is a rollup table maintained by
  -- a trigger on ledger_entries itself — which cannot drift, because
  -- ledger_entries is append-only and the trigger sits on its only write path —
  -- and NOT a cache that one caller remembers to update. That was the previous
  -- design and it is why ledger_accounts.balance_minor is gone: it was
  -- maintained here and nowhere else, so every payment posted through
  -- src/ledger.ts desynchronised it silently. A decision for whoever owns the
  -- ledger; it does not change the meaning of this guard, only how the number is
  -- fetched.
  --
  -- Restricted to `v_ids` — the items this transaction already holds locks on.
  -- Suspending every item belonging to an underwater subject would be more
  -- thorough, but it would take locks on rows a sibling worker may hold, in an
  -- order nothing controls. The rest of the subject's items suspend on their
  -- own next batch, at most one interval later.
  UPDATE billing.billable_items r
     SET status       = 'suspended',
         suspended_at = now()
   WHERE r.id = ANY (v_ids)
     AND r.status = 'active'
     AND (SELECT coalesce(sum(e.amount_minor), 0)
            FROM billing.ledger_entries e
           WHERE e.tenant_id  = r.tenant_id
             AND e.subject_id = r.subject_id
             AND e.account    = 'customer_balance'
             AND e.currency   = r.currency) > 0;

  GET DIAGNOSTICS v_suspended = ROW_COUNT;

  RETURN QUERY SELECT v_items, v_minutes, v_amounts, v_accounts, v_suspended;
END;
$$;
