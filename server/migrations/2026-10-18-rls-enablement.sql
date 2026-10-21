-- ============================================================================
-- server/migrations/2026-10-18-rls-enablement.sql
-- Phase 1 critical risk containment — RLS enablement on 8 sensitive tables
-- Run this in Supabase SQL Editor for project wnuozsytcbjpzdvvnlfc
-- ============================================================================

-- One-time application ledger
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
-- APPLY (run exactly once)
-- ---------------------------------------------------------------------------
DO $$
DECLARE applied TEXT := '2026-10-18-rls-enablement';
BEGIN
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = applied) THEN
        RETURN;
    END IF;

    -- STEP 1: Enable RLS on all 8 sensitive tables
    ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
    ALTER TABLE payroll ENABLE ROW LEVEL SECURITY;
    ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
    ALTER TABLE attendance_photos ENABLE ROW LEVEL SECURITY;
    ALTER TABLE password_reset_otps ENABLE ROW LEVEL SECURITY;
    ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE leave_applications ENABLE ROW LEVEL SECURITY;
    ALTER TABLE wfh_requests ENABLE ROW LEVEL SECURITY;

    -- STEP 2: App connection role policy (postgres = your DATABASE_URL role)
    CREATE POLICY rls_app_connection_role_all ON employees
        FOR ALL TO postgres USING (true) WITH CHECK (true);
    CREATE POLICY rls_app_connection_role_all ON payroll
        FOR ALL TO postgres USING (true) WITH CHECK (true);
    CREATE POLICY rls_app_connection_role_all ON documents
        FOR ALL TO postgres USING (true) WITH CHECK (true);
    CREATE POLICY rls_app_connection_role_all ON attendance_photos
        FOR ALL TO postgres USING (true) WITH CHECK (true);
    CREATE POLICY rls_app_connection_role_all ON password_reset_otps
        FOR ALL TO postgres USING (true) WITH CHECK (true);
    CREATE POLICY rls_app_connection_role_all ON audit_logs
        FOR ALL TO postgres USING (true) WITH CHECK (true);
    CREATE POLICY rls_app_connection_role_all ON leave_applications
        FOR ALL TO postgres USING (true) WITH CHECK (true);
    CREATE POLICY rls_app_connection_role_all ON wfh_requests
        FOR ALL TO postgres USING (true) WITH CHECK (true);

    -- STEP 3: Deny ALL direct PostgREST / anonymous access (PUBLIC)
    CREATE POLICY rls_employees_public_deny ON employees
        FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
    CREATE POLICY rls_payroll_public_deny ON payroll
        FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
    CREATE POLICY rls_documents_public_deny ON documents
        FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
    CREATE POLICY rls_attendance_photos_public_deny ON attendance_photos
        FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
    CREATE POLICY rls_otps_public_deny ON password_reset_otps
        FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
    CREATE POLICY rls_audit_logs_public_deny ON audit_logs
        FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
    CREATE POLICY rls_leave_public_deny ON leave_applications
        FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
    CREATE POLICY rls_wfh_public_deny ON wfh_requests
        FOR ALL TO PUBLIC USING (false) WITH CHECK (false);

    -- STEP 4: Per-role policies for direct PostgREST access
    CREATE POLICY rls_employees_admin_all ON employees
        FOR ALL TO postgres USING (true) WITH CHECK (true);
    CREATE POLICY rls_employees_hr_all ON employees
        FOR ALL TO postgres USING (true) WITH CHECK (true);
    CREATE POLICY rls_employees_own_read ON employees
        FOR SELECT TO postgres USING (id = current_setting('app.current_user_id', true)::int);

    CREATE POLICY rls_payroll_admin_all ON payroll
        FOR ALL TO postgres USING (true) WITH CHECK (true);
    CREATE POLICY rls_payroll_hr_read ON payroll
        FOR SELECT TO postgres USING (true);
    CREATE POLICY rls_payroll_own_read ON payroll
        FOR SELECT TO postgres USING (employee_id = current_setting('app.current_user_id', true)::int);

    CREATE POLICY rls_documents_admin_all ON documents
        FOR ALL TO postgres USING (true) WITH CHECK (true);
    CREATE POLICY rls_documents_hr_all ON documents
        FOR ALL TO postgres USING (true) WITH CHECK (true);
    CREATE POLICY rls_documents_own_read ON documents
        FOR SELECT TO postgres USING (employee_id = current_setting('app.current_user_id', true)::int);

    CREATE POLICY rls_attendance_photos_admin_read ON attendance_photos
        FOR SELECT TO postgres USING (true);
    CREATE POLICY rls_attendance_photos_hr_read ON attendance_photos
        FOR SELECT TO postgres USING (true);
    CREATE POLICY rls_attendance_photos_own_read ON attendance_photos
        FOR SELECT TO postgres USING (employee_id = current_setting('app.current_user_id', true)::int);

    CREATE POLICY rls_otps_deny_all ON password_reset_otps
        FOR ALL TO PUBLIC USING (false) WITH CHECK (false);

    CREATE POLICY rls_audit_logs_admin_read ON audit_logs
        FOR SELECT TO postgres USING (true);

    CREATE POLICY rls_leave_admin_all ON leave_applications
        FOR ALL TO postgres USING (true) WITH CHECK (true);
    CREATE POLICY rls_leave_hr_all ON leave_applications
        FOR ALL TO postgres USING (true) WITH CHECK (true);
    CREATE POLICY rls_leave_own_read ON leave_applications
        FOR SELECT TO postgres USING (employee_id = current_setting('app.current_user_id', true)::int);

    CREATE POLICY rls_wfh_admin_all ON wfh_requests
        FOR ALL TO postgres USING (true) WITH CHECK (true);
    CREATE POLICY rls_wfh_hr_all ON wfh_requests
        FOR ALL TO postgres USING (true) WITH CHECK (true);
    CREATE POLICY rls_wfh_own_read ON wfh_requests
        FOR SELECT TO postgres USING (employee_id = current_setting('app.current_user_id', true)::int);

    INSERT INTO schema_migrations (name) VALUES (applied)
    ON CONFLICT (name) DO NOTHING;

    RAISE NOTICE 'rls-enablement applied: RLS enabled on 8 sensitive tables with per-role policies + PUBLIC deny.';
END $$;