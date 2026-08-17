-- Provider events: the replay guard for webhooks.
--
-- Every VerifiedEvent that `applyVerifiedEvent` sees is recorded here, keyed
-- by (provider, provider_event_id), before anything is posted for it. The
-- ledger is already idempotent on its own natural key, but that key is ours
-- and is derived from the event; this table is the record in the provider's
-- terms — "have we seen evt_1Abc" — which is the question a retried webhook
-- delivery actually asks. A row is written for every event, including the ones
-- that post nothing (a failed payment, an unmodelled kind), so a replay of a
-- non-posting event is answered from the row and never re-evaluated against a
-- ledger that may since have changed.
--
-- Depends on sql/001_core.sql (the ledger this posts into) and nothing else.

CREATE SCHEMA IF NOT EXISTS billing;

CREATE TABLE IF NOT EXISTS billing.provider_events (
  provider          text        NOT NULL,
  provider_event_id text        NOT NULL,
  kind              text        NOT NULL,
  -- The provider's ordering signal, never wall-clock arrival.
  occurred_at       timestamptz NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  -- Resolved from the event by the caller's resolver (or, once invoices exist,
  -- from the invoice the settlement references). NULL when the event could not
  -- be tied to a subject — recorded so the replay is still a no-op, but posted
  -- for no one.
  tenant_id         text,
  subject_id        text,
  -- 'posted' when a ledger transaction was written; 'skipped' otherwise, with
  -- `reason` saying why (payment_failed, refund_declined, unmodelled, ...).
  outcome           text        NOT NULL,
  reason            text,
  -- The ledger transaction this event produced, when it did, and its
  -- source_id (source_kind = 'payment' | 'refund') so a replay can name it.
  transaction_id    uuid,
  source_id         text,
  raw               jsonb,
  PRIMARY KEY (provider, provider_event_id),
  CONSTRAINT provider_events_outcome_known CHECK (outcome IN ('posted', 'skipped'))
);

-- Serves "what did this provider tell us about this subject" and the tenant
-- scoping the RLS policy in sql/090_rls.sql needs.
CREATE INDEX IF NOT EXISTS provider_events_subject_idx
  ON billing.provider_events (tenant_id, subject_id, occurred_at);
