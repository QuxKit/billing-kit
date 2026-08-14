-- Subscriptions: recurring plans billed on our side of the settle line.
--
-- Unlike usage_events and ledger_entries, these tables are not partitioned:
-- they are bounded by the number of customers, not by traffic, and the row that
-- matters for correctness — one charge per period — is guarded by a plain
-- UNIQUE constraint the way ledger_transactions is, not by a partition scheme.
--
-- The plan CATALOGUE is not here. Plans are defined in code (`definePlan`) and
-- held by the application, the same way the metering rate is a column the host
-- owns; a subscription only references a plan by id, and the plan object is
-- passed back in when a period is charged. Persisting plans would make the
-- library the owner of a pricing catalogue it has no opinions about.

CREATE SCHEMA IF NOT EXISTS billing;

-- One subscription instance.
--
-- (tenant_id, key) is the natural key for creation: `key` is the caller's own
-- idempotency token, so creating the same subscription twice — a retried signup
-- — returns the first row rather than making a second. The same contract as
-- ingest and the ledger.
CREATE TABLE IF NOT EXISTS billing.subscriptions (
  id                   uuid        PRIMARY KEY,
  tenant_id            text        NOT NULL,
  subject_id           text        NOT NULL,
  key                  text        NOT NULL,
  plan_id              text        NOT NULL,
  currency             char(3)     NOT NULL,
  state                text        NOT NULL,
  seats                integer     NOT NULL DEFAULT 0,
  current_period_start timestamptz NOT NULL,
  current_period_end   timestamptz NOT NULL,
  trial_end            timestamptz,
  started_at           timestamptz NOT NULL,
  canceled_at          timestamptz,
  cancel_at_period_end boolean     NOT NULL DEFAULT false,
  metadata             jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key),
  CONSTRAINT subscriptions_state_known CHECK (state IN ('trialing', 'active', 'canceled')),
  CONSTRAINT subscriptions_seats_nonneg CHECK (seats >= 0)
);

CREATE INDEX IF NOT EXISTS subscriptions_subject_idx
  ON billing.subscriptions (tenant_id, subject_id);

-- Serves the sweep: "which subscriptions have reached the end of a period".
-- Partial on the not-canceled rows, because a canceled subscription is never
-- due and does not belong in the index the cron scans on every fire.
CREATE INDEX IF NOT EXISTS subscriptions_due_idx
  ON billing.subscriptions (current_period_end)
  WHERE state <> 'canceled';

-- One charged period.
--
-- (subscription_id, period_start) is UNIQUE, so charging the same period twice
-- writes nothing the second time — the append-only, idempotent contract the
-- ledger already holds, mirrored here so an advance cannot double-bill. The
-- charge_id is the ledger transaction's source_id (source_kind = 'charge'), the
-- seam that ties a billed period to the posting it produced.
CREATE TABLE IF NOT EXISTS billing.subscription_periods (
  id              uuid        PRIMARY KEY,
  subscription_id uuid        NOT NULL REFERENCES billing.subscriptions (id),
  tenant_id       text        NOT NULL,
  subject_id      text        NOT NULL,
  period_start    timestamptz NOT NULL,
  period_end      timestamptz NOT NULL,
  charge_id       text        NOT NULL,
  amount_minor    bigint      NOT NULL,
  currency        char(3)     NOT NULL,
  charged_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, period_start)
);

CREATE INDEX IF NOT EXISTS subscription_periods_subscription_idx
  ON billing.subscription_periods (subscription_id, period_start);
