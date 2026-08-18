-- Row-level security for every billing table that carries a tenant.
--
-- OPTIONAL. Nothing in billing-kit requires this file; every query the library
-- issues already filters by tenant_id. What this adds is enforcement below the
-- application: with RLS forced, a query that forgets the filter — a host's own
-- reporting SQL, a psql session, a bug — sees only the tenant the connection
-- has declared, and a connection that declared none sees nothing.
--
-- The tenant is declared per transaction, tenant-kit's convention:
--
--   BEGIN;
--   SET LOCAL tenancy.tenant_id = 'acme';
--   ... every statement here sees only acme's rows ...
--   COMMIT;
--
-- current_setting('tenancy.tenant_id', true) returns NULL when unset (the
-- second argument suppresses the error), NULL never equals anything, so no
-- declaration means no rows — closed by default, not open.
--
-- FORCE matters: without it the table OWNER bypasses every policy, and the
-- role most applications connect as is the role that created the tables. With
-- FORCE the owner is subject to the policy too; only superusers and roles with
-- BYPASSRLS step around it (they always can — do not run the application as
-- one).
--
-- Idempotent: policies are dropped and recreated, ENABLE/FORCE re-run clean.
-- Number 090 because it must run after every table it covers exists; re-run it
-- after any migration that adds a tenant-scoped table (the DO block below
-- discovers them by column, so a re-run covers new tables automatically).
--
-- What is NOT covered, deliberately:
--   - invoice_counters: keyed by tenant_id but read only inside `finalize`,
--     which already scopes by tenant. Covered anyway — it has the column.
--   - schema_migrations, meter_runs: operational, no tenant_id column; they
--     hold no tenant data.
-- The policy name is uniform so a re-run can drop it by name.

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
     WHERE n.nspname = 'billing'
       AND c.relkind IN ('r', 'p')          -- tables and partitioned parents
       AND a.attname = 'tenant_id'
       AND NOT a.attisdropped
       -- Partitions inherit the parent's policy scope through the parent;
       -- policies attach to the parent, and FORCE on the parent is enough
       -- because all access goes through it. Child partitions are excluded by
       -- name convention (they are created by ensure_*_partition with a
       -- _yYYYY / _default suffix and are not queried directly).
       AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)
  LOOP
    EXECUTE format('ALTER TABLE billing.%I ENABLE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format('ALTER TABLE billing.%I FORCE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON billing.%I', t.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON billing.%I
        USING (tenant_id = current_setting(''tenancy.tenant_id'', true))
        WITH CHECK (tenant_id = current_setting(''tenancy.tenant_id'', true))',
      t.table_name
    );
  END LOOP;
END $$;
