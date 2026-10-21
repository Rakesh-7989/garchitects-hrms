-- Verify RLS is enabled on all 8 sensitive tables
SELECT c.relname AS tablename,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname='public' 
  AND c.relkind = 'r'
  AND c.relname IN ('employees','payroll','documents','attendance_photos',
                    'password_reset_otps','audit_logs','leave_applications','wfh_requests')
ORDER BY c.relname;
