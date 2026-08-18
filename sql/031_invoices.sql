-- Invoices: the document a charged period becomes.
--
-- The ledger is the financial record and the subscription period is the
-- schedule; neither is a thing a customer can be shown or an auditor can
-- follow by number. That is what an invoice is: a numbered, stateful document
-- with lines that sum to a total, tied back to the period and the ledger
-- posting that produced it.
--
-- Three properties are enforced here rather than documented:
--
--   gap-free numbering   `invoice_counters` holds one row per (tenant, prefix,
--                        year); `finalize` locks it FOR UPDATE and increments
--                        it in the same transaction that writes the number
--                        onto the invoice. A rolled-back finalize rolls the
--                        counter back too, so the sequence has no holes.
--   one invoice per period   UNIQUE (tenant_id, subscription_period_id).
--   lines sum to total   the total is stored, and recomputed from the lines
--                        by the code on every write; the constraint below is
--                        the state vocabulary, which is closed.
--
-- Depends on sql/001_core.sql. Adds a column to sql/020_subscriptions.sql's
-- subscription_periods; safe to run before or after 020 has data.

CREATE SCHEMA IF NOT EXISTS billing;

-- The charge breakdown, persisted at charge time so an invoice can be built
-- from what was actually billed rather than recomputed from a plan object that
-- may since have changed. JSON of ChargeLine[] (money as {amount, currency},
-- quantities as decimal strings). NULL on rows charged before this migration.
ALTER TABLE billing.subscription_periods
  ADD COLUMN IF NOT EXISTS charge_lines jsonb;

CREATE TABLE IF NOT EXISTS billing.invoice_counters (
  tenant_id text    NOT NULL,
  prefix    text    NOT NULL,
  year      integer NOT NULL,
  next_seq  bigint  NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, prefix, year)
);

CREATE TABLE IF NOT EXISTS billing.invoices (
  id                     uuid        PRIMARY KEY,
  tenant_id              text        NOT NULL,
  subject_id             text        NOT NULL,
  -- NULL while draft; assigned once, at finalize, and never changed.
  number                 text,
  state                  text        NOT NULL DEFAULT 'draft',
  currency               char(3)     NOT NULL,
  subtotal_minor         bigint      NOT NULL DEFAULT 0,
  total_minor            bigint      NOT NULL DEFAULT 0,
  -- The period this invoices, when it invoices one.
  subscription_period_id uuid REFERENCES billing.subscription_periods (id),
  period_start           timestamptz,
  period_end             timestamptz,
  -- The provider settlement this invoice was sent to, once it was. This is
  -- how a payment webhook finds its invoice.
  provider               text,
  provider_ref           text,
  issued_at              timestamptz,
  due_at                 timestamptz,
  paid_at                timestamptz,
  voided_at              timestamptz,
  metadata               jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoices_state_known
    CHECK (state IN ('draft', 'open', 'paid', 'void', 'uncollectible')),
  -- Every issued invoice has a number. A draft has none; a draft that was
  -- voided before issue keeps none (no number was ever taken).
  CONSTRAINT invoices_number_once_open
    CHECK (state IN ('draft', 'void') OR number IS NOT NULL),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, subscription_period_id)
);

CREATE INDEX IF NOT EXISTS invoices_subject_idx
  ON billing.invoices (tenant_id, subject_id, created_at);

-- The webhook's lookup: "which invoice was settled as stripe:in_123".
CREATE UNIQUE INDEX IF NOT EXISTS invoices_provider_ref_idx
  ON billing.invoices (provider, provider_ref)
  WHERE provider IS NOT NULL AND provider_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS billing.invoice_lines (
  id           uuid    PRIMARY KEY,
  invoice_id   uuid    NOT NULL REFERENCES billing.invoices (id) ON DELETE CASCADE,
  tenant_id    text    NOT NULL,
  line_no      integer NOT NULL,
  -- base | seats | overage | discount | credit | custom
  kind         text    NOT NULL,
  description  text    NOT NULL,
  metric       text,
  quantity     numeric(38, 12),
  amount_minor bigint  NOT NULL,
  currency     char(3) NOT NULL,
  metadata     jsonb,
  UNIQUE (invoice_id, line_no),
  CONSTRAINT invoice_lines_kind_known
    CHECK (kind IN ('base', 'seats', 'overage', 'discount', 'credit', 'custom'))
);
