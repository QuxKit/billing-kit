-- Plan changes: moving a subscription between plans, and the record of it.
--
-- `pending_plan_id` is the period-end change: set now, applied when the
-- period is next charged and advanced, so the customer keeps the plan they are
-- in until the period they are in ends. An immediate change closes the current
-- period early on the old plan (charged for its elapsed days) and starts the
-- remainder on the new one; that needs no column, only the audit row below.
--
-- Depends on sql/020_subscriptions.sql.

CREATE SCHEMA IF NOT EXISTS billing;

ALTER TABLE billing.subscriptions
  ADD COLUMN IF NOT EXISTS pending_plan_id text;

CREATE TABLE IF NOT EXISTS billing.plan_changes (
  id              uuid        PRIMARY KEY,
  tenant_id       text        NOT NULL,
  subscription_id uuid        NOT NULL REFERENCES billing.subscriptions (id),
  from_plan_id    text        NOT NULL,
  to_plan_id      text        NOT NULL,
  behaviour       text        NOT NULL,
  requested_at    timestamptz NOT NULL,
  -- When the new plan takes (or took) effect: `requested_at` for immediate,
  -- the current period's end for period_end.
  effective_at    timestamptz NOT NULL,
  -- For an immediate change: the charge_id of the closed partial period, or
  -- NULL when there was nothing to charge (same-day, or a trial).
  charge_id       text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- One change per subscription per instant: a retried call finds its row.
  UNIQUE (subscription_id, effective_at),
  CONSTRAINT plan_changes_behaviour_known CHECK (behaviour IN ('immediate', 'period_end'))
);

CREATE INDEX IF NOT EXISTS plan_changes_subscription_idx
  ON billing.plan_changes (subscription_id, effective_at);
