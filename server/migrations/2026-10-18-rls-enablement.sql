-- ============================================================================
-- server/migrations/2026-10-18-rls-enablement.sql
--
-- DRAFT — Phase 1 critical risk containment (blueprint §10 Phase 1).
-- Purpose: remediate the Supabase security advisor's 42 "RLS Disabled in
-- Public" findings, table-by-table, starting with the most sensitive HR
-- tables. This file is REVIEWABLE but is NOT applied to production here.
--
-- GATING (mirrors the existing one-time reshape block in server/index.js):
--   apply exactly once per database, recorded in schema_migrations; additive
--   ENABLE RLS + CREATE POLICY statements; full ROLLBACK section included.
--
-- PRECONDITIONS (owner must confirm BEFORE applying to production):
--   D1: which Postgres role DATABASE_URL connects as (superuser / non-superuser).
--       A superuser connection bypasses RLS entirely — remediation then only
--       protects direct PostgREST/anon access, not the app's own queries.
--   D2: table-by-table policy intent approved (which roles read/write what).
--   D3: whether RLS should also constrain the app's own pg service role
--       (recommended NO — the service role owns/bypasses tables; policies
--       protect direct anon/PostgREST access).
--
-- TESTING: apply to a staging copy of production first; run positive +
-- negative per-role access tests; verify scheduled jobs + server queries;
-- only then promote via reviewed migration with backup + rollback ready.
-- ============================================================================

-- One-time application ledger (idempotent guard — this block runs once).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_schema='public' AND table_name='schema_migrations') THEN
        CREATE TABLE schema_migrations (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL UNIQUE,
            applied_at TIMESTAMP DEFAULT NOW()
        );
    END IF;
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '2026-10-18-rls-enablement') THEN
        RAISE NOTICE 'rls-enablement already applied — skipping.';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- APPLY (run exactly once). Sensitive tables first.
-- ---------------------------------------------------------------------------
DO $$
DECLARE applied TEXT := '2026-10-18-rls-enablement';
BEGIN
    -- Skip if already recorded.
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = applied) THEN
        RETURN;
    END IF;

    -- 1. employees — PAN/Aadhaar/passport, bank, salary, DOB, contact.
    ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
    -- NOTE: policy bodies below use `current_user` / role placeholders that
    -- must be aligned with the actual DATABASE_URL connection role (D1).
    -- Until D1-D3 are confirmed, PUBLIC gets NO policy → no direct access.
    CREATE POLICY IF NOT EXISTS rls_employees_app_read ON employees
        FOR SELECT TO PUBLIC USING (false);
    CREATE POLICY IF NOT EXISTS rls_employees_app_write ON employees
        FOR ALL TO PUBLIC USING (false) WITH CHECK (false);

    -- 2. payroll — money data.
    ALTER TABLE payroll ENABLE ROW LEVEL SECURITY;
    CREATE POLICY IF NOT EXISTS rls_payroll_app_read ON payroll
        FOR SELECT TO PUBLIC USING (false);
    CREATE POLICY IF NOT EXISTS rls_payroll_app_write ON payroll
        FOR ALL TO PUBLIC USING (false) WITH CHECK (false);

    -- 3. documents — employee files (PII + uploads).
    ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
    CREATE POLICY IF NOT EXISTS rls_documents_app_read ON documents
        FOR SELECT TO PUBLIC USING (false);
    CREATE POLICY IF NOT EXISTS rls_documents_app_write ON documents
        FOR ALL TO PUBLIC USING (false) WITH CHECK (false);

    -- 4. attendance_photos — selfie/location images.
    ALTER TABLE attendance_photos ENABLE ROW LEVEL SECURITY;
    CREATE POLICY IF NOT EXISTS rls_attendance_photos_app_read ON attendance_photos
        FOR SELECT TO PUBLIC USING (false);
    CREATE POLICY IF NOT EXISTS rls_attendance_photos_app_write ON attendance_photos
        FOR ALL TO PUBLIC USING (false) WITH CHECK (false);

    -- 5. password_reset_otps — OTP/reset records.
    ALTER TABLE password_reset_otps ENABLE ROW LEVEL SECURITY;
    CREATE POLICY IF NOT EXISTS rls_otps_app_read ON password_reset_otps
        FOR SELECT TO PUBLIC USING (false);
    CREATE POLICY IF NOT EXISTS rls_otps_app_write ON password_reset_otps
        FOR ALL TO PUBLIC USING (false) WITH CHECK (false);

    -- 6. audit_logs — security trail (append-only; no app write path via API).
    ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
    CREATE POLICY IF NOT EXISTS rls_audit_logs_app_read ON audit_logs
        FOR SELECT TO PUBLIC USING (false);
    CREATE POLICY IF NOT EXISTS rls_audit_logs_app_write ON audit_logs
        FOR ALL TO PUBLIC USING (false) WITH CHECK (false);

    -- 7. leave_applications, wfh_requests — people-module data.
    ALTER TABLE leave_applications ENABLE ROW LEVEL SECURITY;
    ALTER TABLE wfh_requests ENABLE ROW LEVEL SECURITY;
    CREATE POLICY IF NOT EXISTS rls_leave_app_read ON leave_applications
        FOR SELECT TO PUBLIC USING (false);
    CREATE POLICY IF NOT EXISTS rls_leave_app_write ON leave_applications
        FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
    CREATE POLICY IF NOT EXISTS rls_wfh_app_read ON wfh_requests
        FOR SELECT TO PUBLIC USING (false);
    CREATE POLICY IF NOT EXISTS rls_wfh_app_write ON wfh_requests
        FOR ALL TO PUBLIC USING (false) WITH CHECK (false);

    -- Record one-time application.
    INSERT INTO schema_migrations (name) VALUES (applied)
    ON CONFLICT (name) DO NOTHING;

    RAISE NOTICE 'rls-enablement applied: RLS enabled on 8 sensitive tables with deny-by-default PUBLIC policies.';
END $$;

-- ---------------------------------------------------------------------------
-- ROLLBACK (reviewed, safe to run if remediation must be reverted).
-- Removes the policies above and disables RLS on the same tables.
-- NOTE: does not drop schema_migrations row (re-apply would be a no-op).
-- ---------------------------------------------------------------------------
/*
DROP POLICY IF EXISTS rls_employees_app_read ON employees;
DROP POLICY IF EXISTS rls_employees_app_write ON employees;
ALTER TABLE employees DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_payroll_app_read ON payroll;
DROP POLICY IF EXISTS rls_payroll_app_write ON payroll;
ALTER TABLE payroll DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_documents_app_read ON documents;
DROP POLICY IF EXISTS rls_documents_app_write ON documents;
ALTER TABLE documents DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_attendance_photos_app_read ON attendance_photos;
DROP POLICY IF EXISTS rls_attendance_photos_app_write ON attendance_photos;
ALTER TABLE attendance_photos DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_otps_app_read ON password_reset_otps;
DROP POLICY IF EXISTS rls_otps_app_write ON password_reset_otps;
ALTER TABLE password_reset_otps DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_audit_logs_app_read ON audit_logs;
DROP POLICY IF EXISTS rls_audit_logs_app_write ON audit_logs;
ALTER TABLE audit_logs DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_leave_app_read ON leave_applications;
DROP POLICY IF EXISTS rls_leave_app_write ON leave_applications;
ALTER TABLE leave_applications DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_wfh_app_read ON wfh_requests;
DROP POLICY IF EXISTS rls_wfh_app_write ON wfh_requests;
ALTER TABLE wfh_requests DISABLE ROW LEVEL SECURITY;
*/

-- ---------------------------------------------------------------------------
-- NEXT STEPS AFTER D1-D3 CONFIRMED + STAGING TESTED:
--   1. Replace the `USING (false)` / `WITH CHECK (false)` placeholder policies
--      with real per-role policies (e.g. employee reads own row via
--      current_user mapping, admin/HR read all, PUBLIC denied).
--   2. If the app connects as a non-owner role, add a policy allowing that role
--      (or set `ALTER TABLE ... FORCE ROW LEVEL SECURITY` only after confirming
--      the app role is a table owner / has BYPASSRLS).
--   3. Apply to staging → positive/negative per-role tests → production.
-- ============================================================================
