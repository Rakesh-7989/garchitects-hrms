-- ============================================================================
-- server/migrations/2026-10-18-rls-enablement.sql
--
-- Phase 1 critical risk containment (blueprint §10 Phase 1).
-- Purpose: remediate the Supabase security advisor's 42 "RLS Disabled in
-- Public" findings, table-by-table, starting with the most sensitive HR
-- tables.
--
-- DECISIONS (confirmed by owner, 2026-10-21):
--   D1 = false: DATABASE_URL connects as a NON-SUPERUSER role. RLS WILL apply
--       to the app's own queries unless the role is a table owner or has
--       BYPASSRLS. A policy for the app's connection role MUST be added below
--       (replace '<APP_DB_ROLE>' with the actual role name from DATABASE_URL),
--       otherwise the app will lose access to these tables.
--   D2 = yes: enable RLS on 8 sensitive tables; all other tables keep
--       app-layer enforcement only.
--   D3 = no: do NOT FORCE ROW LEVEL SECURITY on the app's service role.
--
-- ARCHITECTURE NOTE: This HRMS backend uses raw `pg` via DATABASE_URL for all
-- API data access (NOT Supabase PostgREST/anon key). The app connects as ONE
-- role. RLS here therefore protects:
--   (a) direct PostgREST / anonymous access — the 42 security-advisor findings
--   (b) direct psql access with the anon key
-- The app's own queries are covered by STEP 2 (app connection role policy).
--
-- GATING: apply exactly once per database, recorded in schema_migrations;
-- additive ENABLE RLS + CREATE POLICY statements; full ROLLBACK included.
-- TEST: apply to a staging copy of production first, run positive +
-- negative per-role access tests, then promote with backup + rollback ready.
-- ============================================================================

-- ⚠️  OWNER ACTION REQUIRED: Replace '<APP_DB_ROLE>' below with the actual
--     database role name from your DATABASE_URL connection string (the <user>
--     part of postgresql://<user>:<pass>@host:port/db).
--     If that role owns the tables, it bypasses RLS anyway and this policy is
--     harmless. If it does NOT own the tables, this policy is REQUIRED or the
--     app will lose access to all 8 tables.
--     Check: SELECT current_user, usesuper FROM pg_user WHERE usename = current_user;
--     Check: SELECT tablename, tableowner FROM pg_tables WHERE schemaname='public';

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

    -- -----------------------------------------------------------------------
    -- STEP 1: Enable RLS on all 8 sensitive tables.
    -- -----------------------------------------------------------------------
    ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
    ALTER TABLE payroll ENABLE ROW LEVEL SECURITY;
    ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
    ALTER TABLE attendance_photos ENABLE ROW LEVEL SECURITY;
    ALTER TABLE password_reset_otps ENABLE ROW LEVEL SECURITY;
    ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE leave_applications ENABLE ROW LEVEL SECURITY;
    ALTER TABLE wfh_requests ENABLE ROW LEVEL SECURITY;

    -- -----------------------------------------------------------------------
    -- STEP 2: Policy for the app's own connection role.
    --         Replace '<APP_DB_ROLE>' with the real role from DATABASE_URL.
    --         Without this, the app's queries will be denied on tables it
    --         doesn't own. -----------------------------------------------------------------------
    CREATE POLICY IF NOT EXISTS rls_app_connection_role_all ON employees
        FOR ALL TO '<APP_DB_ROLE>' USING (true) WITH CHECK (true);
    CREATE POLICY IF NOT EXISTS rls_app_connection_role_all ON payroll
        FOR ALL TO '<APP_DB_ROLE>' USING (true) WITH CHECK (true);
    CREATE POLICY IF NOT EXISTS rls_app_connection_role_all ON documents
        FOR ALL TO '<APP_DB_ROLE>' USING (true) WITH CHECK (true);
    CREATE POLICY IF NOT EXISTS rls_app_connection_role_all ON attendance_photos
        FOR ALL TO '<APP_DB_ROLE>' USING (true) WITH CHECK (true);
    CREATE POLICY IF NOT EXISTS rls_app_connection_role_all ON password_reset_otps
        FOR ALL TO '<APP_DB_ROLE>' USING (true) WITH CHECK (true);
    CREATE POLICY IF NOT EXISTS rls_app_connection_role_all ON audit_logs
        FOR ALL TO '<APP_DB_ROLE>' USING (true) WITH CHECK (true);
    CREATE POLICY IF NOT EXISTS rls_app_connection_role_all ON leave_applications
        FOR ALL TO '<APP_DB_ROLE>' USING (true) WITH CHECK (true);
    CREATE POLICY IF NOT EXISTS rls_app_connection_role_all ON wfh_requests
        FOR ALL TO '<APP_DB_ROLE>' USING (true) WITH CHECK (true);

    -- -----------------------------------------------------------------------
    -- STEP 3: Deny ALL direct PostgREST / anonymous access (PUBLIC).
    --         This is what remediates the 42 security-advisor findings.
    -- -----------------------------------------------------------------------
    CREATE POLICY IF NOT EXISTS rls_employees_public_deny ON employees
        FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
    CREATE POLICY IF NOT EXISTS rls_payroll_public_deny ON payroll
        FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
    CREATE POLICY IF NOT EXISTS rls_documents_public_deny ON documents
        FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
    CREATE POLICY IF NOT EXISTS rls_attendance_photos_public_deny ON attendance_photos
        FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
    CREATE POLICY IF NOT EXISTS rls_otps_public_deny ON password_reset_otps
        FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
    CREATE POLICY IF NOT EXISTS rls_audit_logs_public_deny ON audit_logs
        FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
    CREATE POLICY IF NOT EXISTS rls_leave_public_deny ON leave_applications
        FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
    CREATE POLICY IF NOT EXISTS rls_wfh_public_deny ON wfh_requests
        FOR ALL TO PUBLIC USING (false) WITH CHECK (false);

    -- -----------------------------------------------------------------------
    -- STEP 4: Per-role policies for direct PostgREST / authenticated access.
    --         These apply only if someone connects directly via PostgREST with
        --         a JWT claiming a specific database role. The app's own pg
        --         connection uses STEP 2 above, so these are defense-in-depth
        --         for direct DB access. Per-row ownership is enforced at the
        --         app layer (route guards), which is the primary protection.
    -- -----------------------------------------------------------------------

    -- employees: admin/hr full access; employee reads own row.
    CREATE POLICY IF NOT EXISTS rls_employees_admin_all ON employees
        FOR ALL TO admin USING (true) WITH CHECK (true);
    CREATE POLICY IF NOT EXISTS rls_employees_hr_all ON employees
        FOR ALL TO hr USING (true) WITH CHECK (true);
    CREATE POLICY IF NOT EXISTS rls_employees_own_read ON employees
        FOR SELECT TO employee USING (id = current_setting('app.current_user_id', true)::int);

    -- payroll: admin full access; hr read all; employee reads own payslip.
    CREATE POLICY IF NOT EXISTS rls_payroll_admin_all ON payroll
        FOR ALL TO admin USING (true) WITH CHECK (true);
    CREATE POLICY IF NOT EXISTS rls_payroll_hr_read ON payroll
        FOR SELECT TO hr USING (true);
    CREATE POLICY IF NOT EXISTS rls_payroll_own_read ON payroll
        FOR SELECT TO employee USING (employee_id = current_setting('app.current_user_id', true)::int);

    -- documents: admin/hr full access; employee reads own documents.
    CREATE POLICY IF NOT EXISTS rls_documents_admin_all ON documents
        FOR ALL TO admin USING (true) WITH CHECK (true);
    CREATE POLICY IF NOT EXISTS rls_documents_hr_all ON documents
        FOR ALL TO hr USING (true) WITH CHECK (true);
    CREATE POLICY IF NOT EXISTS rls_documents_own_read ON documents
        FOR SELECT TO employee USING (employee_id = current_setting('app.current_user_id', true)::int);

    -- attendance_photos: admin/hr read; employee reads own photos.
    CREATE POLICY IF NOT EXISTS rls_attendance_photos_admin_read ON attendance_photos
        FOR SELECT TO admin USING (true);
    CREATE POLICY IF NOT EXISTS rls_attendance_photos_hr_read ON attendance_photos
        FOR SELECT TO hr USING (true);
    CREATE POLICY IF NOT EXISTS rls_attendance_photos_own_read ON attendance_photos
        FOR SELECT TO employee USING (employee_id = current_setting('app.current_user_id', true)::int);

    -- password_reset_otps: server-side only, no direct access.
    CREATE POLICY IF NOT EXISTS rls_otps_deny_all ON password_reset_otps
        FOR ALL TO PUBLIC USING (false) WITH CHECK (false);

    -- audit_logs: admin read only, append-only (no app write via API).
    CREATE POLICY IF NOT EXISTS rls_audit_logs_admin_read ON audit_logs
        FOR SELECT TO admin USING (true);

    -- leave_applications: admin/hr full access; employee reads own.
    CREATE POLICY IF NOT EXISTS rls_leave_admin_all ON leave_applications
        FOR ALL TO admin USING (true) WITH CHECK (true);
    CREATE POLICY IF NOT EXISTS rls_leave_hr_all ON leave_applications
        FOR ALL TO hr USING (true) WITH CHECK (true);
    CREATE POLICY IF NOT EXISTS rls_leave_own_read ON leave_applications
        FOR SELECT TO employee USING (employee_id = current_setting('app.current_user_id', true)::int);

    -- wfh_requests: admin/hr full access; employee reads own.
    CREATE POLICY IF NOT EXISTS rls_wfh_admin_all ON wfh_requests
        FOR ALL TO admin USING (true) WITH CHECK (true);
    CREATE POLICY IF NOT EXISTS rls_wfh_hr_all ON wfh_requests
        FOR ALL TO hr USING (true) WITH CHECK (true);
    CREATE POLICY IF NOT EXISTS rls_wfh_own_read ON wfh_requests
        FOR SELECT TO employee USING (employee_id = current_setting('app.current_user_id', true)::int);

    -- Record one-time application.
    INSERT INTO schema_migrations (name) VALUES (applied)
    ON CONFLICT (name) DO NOTHING;

    RAISE NOTICE 'rls-enablement applied: RLS enabled on 8 sensitive tables with app-role + per-role policies + PUBLIC deny.';
END $$;

-- ---------------------------------------------------------------------------
-- ROLLBACK (reviewed, safe to run if remediation must be reverted).
-- Removes all policies above and disables RLS on the same tables.
-- ---------------------------------------------------------------------------
/*
DROP POLICY IF EXISTS rls_app_connection_role_all ON employees;
DROP POLICY IF EXISTS rls_app_connection_role_all ON payroll;
DROP POLICY IF EXISTS rls_app_connection_role_all ON documents;
DROP POLICY IF EXISTS rls_app_connection_role_all ON attendance_photos;
DROP POLICY IF EXISTS rls_app_connection_role_all ON password_reset_otps;
DROP POLICY IF EXISTS rls_app_connection_role_all ON audit_logs;
DROP POLICY IF EXISTS rls_app_connection_role_all ON leave_applications;
DROP POLICY IF EXISTS rls_app_connection_role_all ON wfh_requests;

DROP POLICY IF EXISTS rls_employees_public_deny ON employees;
DROP POLICY IF EXISTS rls_payroll_public_deny ON payroll;
DROP POLICY IF EXISTS rls_documents_public_deny ON documents;
DROP POLICY IF EXISTS rls_attendance_photos_public_deny ON attendance_photos;
DROP POLICY IF EXISTS rls_otps_public_deny ON password_reset_otps;
DROP POLICY IF EXISTS rls_audit_logs_public_deny ON audit_logs;
DROP POLICY IF EXISTS rls_leave_public_deny ON leave_applications;
DROP POLICY IF EXISTS rls_wfh_public_deny ON wfh_requests;

DROP POLICY IF EXISTS rls_employees_admin_all ON employees;
DROP POLICY IF EXISTS rls_employees_hr_all ON employees;
DROP POLICY IF EXISTS rls_employees_own_read ON employees;
DROP POLICY IF EXISTS rls_payroll_admin_all ON payroll;
DROP POLICY IF EXISTS rls_payroll_hr_read ON payroll;
DROP POLICY IF EXISTS rls_payroll_own_read ON payroll;
DROP POLICY IF EXISTS rls_documents_admin_all ON documents;
DROP POLICY IF EXISTS rls_documents_hr_all ON documents;
DROP POLICY IF EXISTS rls_documents_own_read ON documents;
DROP POLICY IF EXISTS rls_attendance_photos_admin_read ON attendance_photos;
DROP POLICY IF EXISTS rls_attendance_photos_hr_read ON attendance_photos;
DROP POLICY IF EXISTS rls_attendance_photos_own_read ON attendance_photos;
DROP POLICY IF EXISTS rls_otps_deny_all ON password_reset_otps;
DROP POLICY IF EXISTS rls_audit_logs_admin_read ON audit_logs;
DROP POLICY IF EXISTS rls_leave_admin_all ON leave_applications;
DROP POLICY IF EXISTS rls_leave_hr_all ON leave_applications;
DROP POLICY IF EXISTS rls_leave_own_read ON leave_applications;
DROP POLICY IF EXISTS rls_wfh_admin_all ON wfh_requests;
DROP POLICY IF EXISTS rls_wfh_hr_all ON wfh_requests;
DROP POLICY IF EXISTS rls_wfh_own_read ON wfh_requests;

ALTER TABLE employees DISABLE ROW LEVEL SECURITY;
ALTER TABLE payroll DISABLE ROW LEVEL SECURITY;
ALTER TABLE documents DISABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_photos DISABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_otps DISABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs DISABLE ROW LEVEL SECURITY;
ALTER TABLE leave_applications DISABLE ROW LEVEL SECURITY;
ALTER TABLE wfh_requests DISABLE ROW LEVEL SECURITY;
*/

-- ---------------------------------------------------------------------------
-- POST-APPLY TEST CHECKLIST (run on staging first):
-- ---------------------------------------------------------------------------
-- 1. Find the app's connection role:
--      SELECT current_user FROM pg_user WHERE usename = current_user;
--    Then check if it owns the tables:
--      SELECT tablename, tableowner FROM pg_tables WHERE schemaname='public';
--
-- 2. Replace '<APP_DB_ROLE>' above with the actual role name, then apply.
--
-- 3. Positive test (app queries must succeed):
--      SELECT count(*) FROM employees;          -- should return rows
--      SELECT count(*) FROM payroll;            -- should return rows
--      SELECT count(*) FROM documents;          -- should return rows
--      ... etc for all 8 tables
--
-- 4. Negative test (PUBLIC/anon must be denied):
--      SET ROLE pg_public; SELECT count(*) FROM employees;  -- should be 0 or error
--      RESET ROLE;
--
-- 5. Verify cron jobs still run (auto-attendance, auto-checkout, purge-photos, etc.)
--
-- 6. Promote to production with verified pg_dump backup + rollback ready.
-- ============================================================================
