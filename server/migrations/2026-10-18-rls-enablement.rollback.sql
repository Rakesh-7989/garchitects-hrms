-- ============================================================================
-- server/migrations/2026-10-18-rls-enablement.rollback.sql
-- Undo 2026-10-18-rls-enablement.sql completely:
--   1. Drop all 36 policies created by the forward migration.
--   2. DISABLE ROW LEVEL SECURITY on the 8 sensitive tables.
--   3. Remove the ledger row (so a deliberate re-apply is not skipped).
-- NOTE: relaxes security back to pre-migration state. Only run if the forward
-- migration caused an incident, or as a drill on a scratch cluster.
-- ============================================================================
DO $$
BEGIN
    -- STEP 1/2 policies (same name reused per table is legal in PG)
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

    -- STEP 2: turn RLS off again
    ALTER TABLE employees DISABLE ROW LEVEL SECURITY;
    ALTER TABLE payroll DISABLE ROW LEVEL SECURITY;
    ALTER TABLE documents DISABLE ROW LEVEL SECURITY;
    ALTER TABLE attendance_photos DISABLE ROW LEVEL SECURITY;
    ALTER TABLE password_reset_otps DISABLE ROW LEVEL SECURITY;
    ALTER TABLE audit_logs DISABLE ROW LEVEL SECURITY;
    ALTER TABLE leave_applications DISABLE ROW LEVEL SECURITY;
    ALTER TABLE wfh_requests DISABLE ROW LEVEL SECURITY;

    -- STEP 3: ledger row out (re-apply must not be skipped)
    DELETE FROM schema_migrations WHERE name = '2026-10-18-rls-enablement';

    RAISE NOTICE 'rls-enablement rolled back: policies dropped, RLS disabled, ledger row removed.';
END $$;
