-- 033_tax_lines.sql — let an invoice line be tax.
--
-- `invoice_lines.kind` is constrained to a known set, and 031 wrote that set
-- without `tax` because billing-kit had no tax seam. It has one now
-- (`billing-kit/tax`), and a calculator's answer lands as ordinary lines: one
-- per jurisdiction, positive, outside the subtotal.
--
-- A separate file rather than an edit to 031, because `billing-kit migrate`
-- checksums what it applied and refuses a file that changed underneath it. An
-- edit would be reported as tampering on every database that already ran 031,
-- which is every database there is.
--
-- Re-runnable, like every file here: it inspects the constraint before touching
-- it and does nothing on a database that already has the wider one. The drop is
-- unconditional inside that branch rather than `IF EXISTS`-guarded on its own,
-- because a database that somehow lost the constraint should get it back.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'billing.invoice_lines'::regclass
       AND conname  = 'invoice_lines_kind_known'
       AND pg_get_constraintdef(oid) LIKE '%''tax''%'
  ) THEN
    ALTER TABLE billing.invoice_lines
      DROP CONSTRAINT IF EXISTS invoice_lines_kind_known;

    ALTER TABLE billing.invoice_lines
      ADD CONSTRAINT invoice_lines_kind_known
      CHECK (kind IN ('base', 'seats', 'overage', 'tax', 'discount', 'credit', 'custom'));
  END IF;
END $$;
