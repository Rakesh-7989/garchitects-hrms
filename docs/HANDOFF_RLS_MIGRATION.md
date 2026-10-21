# Handoff: RLS Migration to Production

**Status:** READY FOR ANOTHER AGENT TO EXECUTE  
**Branch:** `audit/privacy-security-baseline` → `master` (already pushed, commit `000383b`)  
**Working tree:** Clean  
**Production deploy:** Triggered via Vercel (code is live, but RLS migration SQL is NOT yet applied to the database)

---

## What is pending

Apply the RLS enablement migration to the production Supabase database (`wnuozsytcbjpzdvvnlfc`).

The migration file is already committed:
- `server/migrations/2026-10-18-rls-enablement.sql`

It enables Row Level Security on 8 sensitive tables and adds per-role policies.

---

## What the migration does

Enables RLS on these 8 tables:
1. `employees` — PAN/Aadhaar/passport, bank, salary, DOB, contact
2. `payroll` — money data
3. `documents` — employee files (PII + uploads)
4. `attendance_photos` — selfie/location images
5. `password_reset_otps` — OTP/reset records
6. `audit_logs` — security trail
7. `leave_applications` — people-module data
8. `wfh_requests` — people-module data

Policies:
- **App connection role** (`<APP_DB_ROLE>` → replace with `postgres`): full access (USING true / WITH CHECK true)
- **Admin role:** full access to employees, payroll, documents, leave, wfh
- **HR role:** full access to employees, documents, leave, wfh; read access to payroll
- **Employee role:** read own row only
- **PUBLIC:** deny all (USING false / WITH CHECK false) — this remediates the 42 security-advisor findings

Full rollback section is included in the file (commented out).

---

## Prerequisites (already confirmed)

- D1 = **false**: `DATABASE_URL` connects as a **non-superuser** role
- D2 = **yes**: enable RLS on the 8 sensitive tables
- D3 = **no**: do NOT force RLS on the app's service role
- All 8 tables are owned by `postgres` (tableowner = postgres)

Since tables are owned by `postgres` and the app likely connects as `postgres`, the app's own queries will bypass RLS anyway — the policies protect direct PostgREST/anonymous access only.

---

## Step-by-step execution

### Step 1: Replace the placeholder

Open `server/migrations/2026-10-18-rls-enablement.sql`.

Replace **all 8 occurrences** of `<APP_DB_ROLE>` with `postgres` (the role name from `DATABASE_URL`).

Use Find & Replace:
- Find: `<APP_DB_ROLE>`
- Replace with: `postgres`

Verify no `<APP_DB_ROLE>` remains:
```bash
grep -rn "APP_DB_ROLE" server/migrations/
```
Should return 0 matches.

### Step 2: Test on staging first (DO NOT skip)

1. **Backup production:**
   ```bash
   pg_dump "$DATABASE_URL" > backups/hrms-pre-rls-$(date +%Y%m%d-%H%M%S).sql
   ```

2. **Restore to staging** (separate Supabase project or local PostgreSQL).

3. **Run baseline test:**
   ```bash
   DATABASE_URL=<staging-url> node scripts/qa-rls-staging-test.cjs
   ```

4. **Apply migration to staging:**
   ```bash
   psql "$STAGING_DATABASE_URL" -f server/migrations/2026-10-18-rls-enablement.sql
   ```

5. **Re-run test:**
   ```bash
   DATABASE_URL="$STAGING_DATABASE_URL" node scripts/qa-rls-staging-test.cjs
   ```
   Confirm: RLS = ENABLED on all 8 tables, PUBLIC = 0 rows (denied).

6. **Positive test (app queries must work):**
   ```sql
   SELECT count(*) FROM employees;
   SELECT count(*) FROM payroll;
   SELECT count(*) FROM documents;
   SELECT count(*) FROM attendance_photos;
   SELECT count(*) FROM password_reset_otps;
   SELECT count(*) FROM audit_logs;
   SELECT count(*) FROM leave_applications;
   SELECT count(*) FROM wfh_requests;
   ```

7. **Negative test (PUBLIC denied):**
   ```sql
   SET ROLE pg_public;
   SELECT count(*) FROM employees;  -- should be 0 or error
   RESET ROLE;
   ```

8. **Verify cron jobs still run** (auto-attendance, auto-checkout, purge-photos, expire-announcements, expire-handovers).

### Step 3 — Apply to production

Only after staging passes:

1. **Backup production:**
   ```bash
   pg_dump "$DATABASE_URL" > backups/hrms-pre-rls-production-$(date +%Y%m%d-%H%M%S).sql
   ```

2. **Apply migration:**
   ```bash
   psql "$DATABASE_URL" -f server/migrations/2026-10-18-rls-enablement.sql
   ```

   Or via Supabase CLI:
   ```bash
   supabase link --project-ref wnuozsytcbjpzdvvnlfc
   mkdir -p supabase/migrations
   cp server/migrations/2026-10-18-rls-enablement.sql supabase/migrations/20261021000000_rls_enablement.sql
   supabase db push
   ```

   Or via Supabase Dashboard SQL Editor (paste the migration SQL and click Run).

3. **Verify on production:**
   ```sql
   SELECT tablename, relrowsecurity AS rls_enabled
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' 
     AND tablename IN ('employees','payroll','documents','attendance_photos',
                       'password_reset_otps','audit_logs','leave_applications','wfh_requests');
   ```
   All should show `t` (enabled).

4. **Re-run Supabase Security Advisor** to confirm the 42 findings are remediated.

5. **Monitor the app** for 24–72 hours — employees can check in/out, view payroll, view documents, etc.

---

## Rollback (if anything breaks)

If the app breaks after applying RLS, run:

```sql
ALTER TABLE employees DISABLE ROW LEVEL SECURITY;
ALTER TABLE payroll DISABLE ROW LEVEL SECURITY;
ALTER TABLE documents DISABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_photos DISABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_otps DISABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs DISABLE ROW LEVEL SECURITY;
ALTER TABLE leave_applications DISABLE ROW LEVEL SECURITY;
ALTER TABLE wfh_requests DISABLE ROW LEVEL SECURITY;
```

Or restore from the `pg_dump` backup taken in Step 3.

---

## Files involved

| File | Purpose |
|------|---------|
| `server/migrations/2026-10-18-rls-enablement.sql` | The migration to apply |
| `scripts/qa-rls-staging-test.cjs` | Read-only staging test helper |
| `docs/FEATURE_PRIVACY_SECURITY_SDLC_PLAN.md` | Full SDLC plan with risk register |
| `AGENTS.md §11` | Current state documentation |

---

## What is NOT pending

Everything else is committed and live on master:
- Consent UX (frontend modals, notices, withdrawal)
- RBAC matrix (58 rows, all 35 modules)
- QA inline gate (39 pages, 0 failures)
- Business-logic harnesses (auth, cron, wfh-tickets)
- All documentation (data inventory, vendor register, policies)
- AGENTS.md §11 updated

---

**Next agent:** Start at Step 1. Replace `<APP_DB_ROLE>`, test on staging, then apply to production. Ask questions if anything is unclear.
