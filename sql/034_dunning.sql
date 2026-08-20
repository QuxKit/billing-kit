-- Dunning: one case per failed settlement, and a clock over it.
--
-- A failed payment already lands in `provider_events` with `applied: false` —
-- correctly, because no money moved and the ledger must not post. This is what
-- happens next: a durable row that says we are chasing this debt, how far along
-- we are, and when to look again.
--
-- Two properties are enforced here rather than documented:
--
--   one case per debt   UNIQUE (tenant_id, settlement_ref). The same
--                       `payment.failed` webhook delivered three times opens
--                       one case, and a provider's own failed retry against
--                       the same settlement reuses it rather than starting a
--                       second ladder for the same money.
--   a closed case stays closed   `dunning_cases_closed_at` ties `closed_at` to
--                       the terminal states, so a row cannot claim to be
--                       `recovered` and still be waiting for a step.
--
-- What is NOT here: the actions. No email, no template, no send log. The sweep
-- returns what should happen and the host does it, so what a notification *is*
-- stays outside this schema entirely.
--
-- Depends on sql/001_core.sql and sql/031_invoices.sql.
--
-- Note for an existing database: sql/090_rls.sql discovers tenant-scoped tables
-- by column, so a fresh `migrate` run covers this table automatically — 090
-- sorts after 034. A database that already applied 090 has it recorded and
-- checksummed, so `migrate` will not re-run it; apply 090 by hand there if RLS
-- is in use.

CREATE SCHEMA IF NOT EXISTS billing;

CREATE TABLE IF NOT EXISTS billing.dunning_cases (
  id             uuid        PRIMARY KEY,
  tenant_id      text        NOT NULL,
  subject_id     text        NOT NULL,
  -- The provider's settlement this is about. Half the natural key, and what a
  -- later payment.succeeded is matched on to close the case.
  settlement_ref text        NOT NULL,
  -- NULL under a provider that issues its own document (a merchant of record).
  invoice_id     uuid REFERENCES billing.invoices (id),
  provider       text        NOT NULL,
  state          text        NOT NULL DEFAULT 'open',
  amount_minor   bigint      NOT NULL,
  currency       char(3)     NOT NULL,
  -- Steps fired, not payment attempts made. Zero on a case whose first step
  -- has not run, which is the state a case is in the moment it opens.
  attempts       integer     NOT NULL DEFAULT 0,
  last_reason    text        NOT NULL,
  opened_at      timestamptz NOT NULL,
  -- NULL on a terminal case, and NULL under an observing policy: there is
  -- nothing to wake up for when nothing will act.
  next_action_at timestamptz,
  closed_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dunning_cases_state_known
    CHECK (state IN ('open', 'recovered', 'written_off', 'cancelled')),
  CONSTRAINT dunning_cases_attempts_nonnegative
    CHECK (attempts >= 0),
  -- An open case has not closed; a closed one has. Without this a case can be
  -- `recovered` and still hold a `next_action_at`, and the sweep's own
  -- state check is then the only thing standing between a paying customer and
  -- a suspension email.
  CONSTRAINT dunning_cases_closed_at
    CHECK ((state = 'open') = (closed_at IS NULL)),
  UNIQUE (tenant_id, settlement_ref)
);

-- The sweep's only query: what is due. Partial, because a case that is closed
-- or unscheduled is never a candidate and there are eventually far more of
-- those than of open ones.
CREATE INDEX IF NOT EXISTS dunning_cases_due_idx
  ON billing.dunning_cases (next_action_at)
  WHERE state = 'open' AND next_action_at IS NOT NULL;

-- "What is outstanding for this customer", which is the question a support
-- screen asks and the one an operator asks before a refund.
CREATE INDEX IF NOT EXISTS dunning_cases_subject_idx
  ON billing.dunning_cases (tenant_id, subject_id, opened_at);
