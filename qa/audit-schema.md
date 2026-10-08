# QA Audit — Schema & Data Layer

**Audit date:** 2026-10-09
**Auditor role:** SCHEMA & DATA-LAYER AUDITOR (Sprint 1 — standing AI-agent team, see `docs/AGENT_TEAM.md`)

## Method

Static parity analysis of the three schema layers (A = `server/schema.sql`, B = startup `runMigrations()` in `server/index.js`, C = lazy `server/utils/schemaRepair.js`): tables/columns cross-referenced programmatically, `runWithSchemaRepair` adoption counted by regex (excluding `runWithSchemaRepair(() => query(` wrappers), FK/index presence checked per hot query path. Empirical verification ran against a **hermetic local PostgreSQL 16** cluster (temp dir under `%TEMP%\opencode`, since removed) — `pool.query(schema)` (exactly what `server/scripts/init-db.js` does) and `node server/scripts/migrate.js` were both executed against a clean database to prove layer-A/B behavior for real. No production DB was touched; repo working tree unchanged except this file.

---

## Findings

### F1 — `server/schema.sql` contains JS-style `//` comments → `npm run db:init` fails at HEAD
**Severity:** HIGH
**Status:** CONFIRMED (empirically executed)

**Where:** `server/schema.sql:858, 860-862` (inside the `user_notifications` doc block)

**What:** Four lines of the block comment before `CREATE TABLE user_notifications` use `//` instead of `--`. SQL treats `//` as a syntax error, so the *entire* script aborts — a fresh install creates **zero tables**.

**Why it matters:** Layer A is the canonical schema for fresh installs (AGENTS.md §5). Any new environment, CI job, or restore-from-scratch hits this immediately. The repo's own QA harness works around it (`scripts/qa-commander.cjs:111-113` `stripSchema()` filters `//` lines — added in `42ebb8c`), so QA stays green while `db:init` is broken at HEAD: a classic "harness hides the bug" trap. Introduced in commit `dee5ee8` (2026-10-01).

**Evidence:**
```sql
857: -- The HRMS had NO stored notification feed: the bell only DERIVED counts from
858: // source tables (pending leave, tickets, ...) and only for manager/admin roles,
...
860: // not expressible. Web push cannot carry this on its own either - it silently
```
Hermetic run of `pool.query(fs.readFileSync('server/schema.sql','utf8'))` →
`syntax error at or near "//"` (code `42601`), 0 tables created.

---

### F2 — `server/scripts/migrate.js` splits schema.sql naively → 35/219 statements silently skipped, 7 tables never created
**Severity:** HIGH
**Status:** CONFIRMED (empirically executed)

**Where:** `server/scripts/migrate.js:21-24` (`sql.split(';')`)

**What:** The migrator splits the whole file on every `;`. That breaks (a) semicolons inside `--` line comments and (b) semicolons inside `DO $$ ... $$` bodies. Each failed statement is swallowed and counted, but the run still reports success.

**Why it matters:** `db:migrate` is the upgrade path for existing databases (AGENTS.md §9). Tables affected include user-facing ones (`user_notifications`, `project_leads`, `team_transfer_requests`, `team_handovers`, `employee_processes`, `process_tasks`, `project_status_updates`), plus `employees.basic_salary` ALTER (which then breaks the backfill that follows) and the attendance status CHECK drop/recreate. Because layer B/C can lazily re-create some of these, the damage is masked in normal operation and only bites on cold instances or fresh-ish DBs.

**Evidence:** Hermetic run against a clean PostgreSQL 16 (`$env:DATABASE_URL=...; node server/scripts/migrate.js`):
```
Done. 184/219 statements applied successfully.
```
35 failures; `SELECT to_regclass('public.user_notifications')` → NULL (also `project_leads`,
`team_transfer_requests`, `team_handovers`, `employee_processes`, `process_tasks`,
`project_status_updates`); follow-on error `column "basic_salary" does not exist`.

---

### F3 — `runWithSchemaRepair` imported but unused in key routes; 320 raw `query()` calls remain
**Severity:** MEDIUM
**Status:** CONFIRMED

**Where:** `server/routes/leave.js:11`, `server/routes/wfh.js:8`, `server/routes/manager.js:8`, `server/routes/employees.js:9`, `server/routes/notifications.js:5` (imports) vs their query call sites; repo-wide count across 29 files.

**What:** Per AGENTS.md §5, DB calls should go through `q = (sql, p) => runWithSchemaRepair(() => query(sql, p))`. Several files import the helper and then never define/use `q` — e.g. `leave.js` and `wfh.js` import `runWithSchemaRepair` at the top but contain **zero** `await q(` calls. Repo-wide, **320 `query()` calls across 29 files** are not wrapped. Worst offenders: `attendance.js` 42, `employees.js` 41, `leave.js` 35, `auth.js` 28 (no import at all), `wfh.js` 25, `manager.js` 22.

**Why it matters:** The lazy self-heal layer only protects routes that actually use the wrapper. On a cold Vercel instance against a partially-migrated DB, unwrapped routes 500 on missing tables/columns instead of self-healing — precisely the failure mode layer C exists to prevent. The unused imports also signal the convention was adopted incompletely (docs say one thing, code does another).

**Evidence:**
```
leave.js:11  -> require('../utils/schemaRepair') ...
await q( count in leave.js: 0
wfh.js:8     -> require('../utils/schemaRepair') ...
await q( count in wfh.js: 0
```
Regex count excluding `runWithSchemaRepair(() => query(`: **320 raw `query()` calls / 29 files**.

---

### F4 — Attendance break columns live only in layer A; the hottest attendance routes are unwrapped
**Severity:** MEDIUM
**Status:** CONFIRMED

**Where:** `server/schema.sql:105-107` (`break_start`, `break_end`, `break_log` in `CREATE TABLE attendance`); `server/routes/attendance.js` (42 unwrapped `query()` calls).

**What:** The break-tracking columns exist inside layer A's `CREATE TABLE attendance` but have **no** entry in layer B's startup ALTERs or layer C's `ATTENDANCE_ALTER_COLUMNS` (`schemaRepair.js:64-71`). Any DB whose `attendance` table predates the break feature and isn't rebuilt from schema.sql will lack them — and since `attendance.js` bypasses the self-heal wrapper (F3), break start/end breaks on exactly the instances that need repair.

**Why it matters:** Break tracking shipped as a core attendance feature (see AGENTS.md §11, break-finalize work). The three-layer convention explicitly requires new columns to be added to "all relevant layers"; this one only reached layer A.

**Evidence:**
```sql
-- schema.sql:105-107
break_start TIMESTAMP,
break_end   TIMESTAMP,
break_log   JSONB DEFAULT '[]'::jsonb,
```
`ATTENDANCE_ALTER_COLUMNS` keys: `check_in`, `check_out`, `status`, `auto_checkout*` — no `break_*`.

---

### F5 — `token_version` missing from layer B
**Severity:** LOW
**Status:** CONFIRMED

**Where:** `server/schema.sql:445` (A ✓), `server/utils/schemaRepair.js:55` (C ✓), absent from `server/index.js` `runMigrations()` (B ✗).

**What:** `ALTER TABLE employees ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0` exists in A and C but B's startup ALTER block never adds it.

**Why it matters:** Security-relevant column (immediate JWT invalidation on password change — schema.sql:444 comment). Layer B is what runs on *every* cold boot for *every* existing DB; layer C only fires lazily on a schema error touching that path. The gap is small because C covers it, but B is the designated "existing DB" layer and should own it.

**Evidence:**
```
schema.sql:445: ALTER TABLE employees ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
schemaRepair.js:55: token_version: 'INTEGER NOT NULL DEFAULT 0',
server/index.js: (no token_version match)
```

---

### F6 — Leave/WFH routes return raw Postgres `DATE` values; client slices at `T` → previous-day off-by-one off-UTC
**Severity:** MEDIUM
**Status:** CONFIRMED (code path verified; not reproducible on Vercel/UTC hosts)

**Where:** `server/routes/leave.js` (`/my` `/all` `/pending` — `SELECT la.*` at :214-224, :233-261, :269-279), `server/routes/wfh.js` (`/my` `/all` — :187-196, :205-232); client `public/pages/manager/my-team.html:547-548`.

**What:** These endpoints return `SELECT la.*` / `SELECT wr.*`, so `DATE` columns serialize as full ISO timestamps at local midnight. The client then does `(l.start_date || '').split('T')[0]` — the exact pattern AGENTS.md §5 warns about (fixed for attendance in the 2026-10-07 `dateOnly()` work, but *not* applied to leave/WFH).

**Why it matters:** On any host whose local time is **west** of UTC (e.g. the dev machine pattern documented in AGENTS.md §11 where the attendance bug bit), `DATE '2026-10-09'` serializes to `2026-10-08T…Z`, and `split('T')[0]` yields the **previous day** — leave/WFH dates render off by one in manager/HR views. Vercel runs UTC so production is currently safe, but any local QA, self-hosted deploy, or TZ-configured region re-introduces the bug. Attendance already learned this lesson the hard way; leave/WFH should use the same `dateOnly()` normalization.

**Evidence:**
```js
// leave.js:214-216
`SELECT la.* FROM leave_applications la ...`
// my-team.html:547-548
(l.start_date || '').split('T')[0]
```
`server/utils/date.js` exports `dateOnly()` (used in `attendance.js:45,121,486,534,685,830` but not in leave/wfh).

---

### F7 — Missing indexes on frequently-filtered columns
**Severity:** LOW
**Status:** CONFIRMED

**Where:**
- `support_tickets.employee_id` — queried at `server/routes/tickets.js:101` (`WHERE st.employee_id = $1`) with **no index anywhere** (schema.sql, index.js, schemaRepair.js).
- `leave_applications.manager_id/hr_id` and `wfh_requests.manager_id/hr_id` — used in OR-predicates (`manager.js:147,171,216,303,373,411,488,572`: `la.reporting_manager_id = $1 OR la.manager_id = $1 OR la.hr_id = $1 ...`); schema.sql indexes only `employee_id` and `reporting_manager_id` (`idx_leave_emp`/`idx_leave_manager` :345-347, `idx_wfh_emp`/`idx_wfh_manager` :439-440).
- `project_employees` in schema.sql has only partial unique indexes — no plain `project_id`/`employee_id` scan indexes (B adds `idx_project_employees_unit`, C adds two more, so layers disagree).

**Why it matters:** These are per-manager/org-wide scans that run on every dashboard/notification poll (`notifications.js:195-213`). OR-predicates can't use a single index well, but without *any* index on `manager_id`/`hr_id` Postgres falls back to seq scans as data grows — an org-wide leave list at a mid-size studio will feel it. Missing FK-side indexes also slow cascading deletes.

**Evidence:**
```sql
-- schema.sql:345-347 (leave_applications)
CREATE INDEX IF NOT EXISTS idx_leave_emp ON leave_applications(employee_id);
CREATE INDEX IF NOT EXISTS idx_leave_manager ON leave_applications(reporting_manager_id);
-- no manager_id / hr_id index; support_tickets has no employee_id index at all
```

---

### F8 — `project_settings` is a dead table (layer A only, zero consumers)
**Severity:** LOW
**Status:** CONFIRMED

**Where:** `server/schema.sql:907` (defined); zero references in `server/routes/*`, `server/services/*`, `server/utils/*`, `server/index.js`.

**What:** The table is created in layer A and never touched by any other layer or any runtime code path.

**Why it matters:** Dead schema is maintenance surface and reviewer noise — it also makes layer-coverage tables misleading (a table that exists in exactly one layer and is never used reads like a parity gap but is actually dead weight). Either wire it up or remove it; leaving it half-defined contradicts the "add new tables to all relevant layers" rule by never justifying which layers it needs.

**Evidence:** `Select-String -Pattern 'project_settings'` across schema.sql + routes + services + utils + index.js → exactly one hit: `schema.sql:907`.

---

### F9 — Layer C's `projects` DDL omits columns present in layer A (mitigated)
**Severity:** LOW
**Status:** CONFIRMED (impact mitigated by B/C ALTERs)

**Where:** `server/utils/schemaRepair.js:213-225` (`ENSURE_TABLE_DDL.projects`)

**What:** The self-heal `CREATE TABLE ... projects` includes `status/customer/client/description/created_at/updated_at` but omits `start_date/end_date/location/project_type` that layer A's `CREATE TABLE` defines.

**Why it matters:** If layer C ever *creates* a missing `projects` table on a cold instance, that table starts without lifecycle columns. It is mitigated today: `PROJECT_ALTER_COLUMNS` (`schemaRepair.js:76-88`) covers `start_date/end_date/location/project_type`, and layer B's startup ALTERs also add them — so the columns appear on the next query that touches the self-heal path. Still, the DDL being narrower than schema.sql means the "create" and "ensure" paths disagree about what `projects` is, which is exactly the drift the three-layer convention is meant to prevent.

**Evidence:**
```js
// schemaRepair.js ENSURE_TABLE_DDL.projects — no start_date/end_date/location/project_type
`CREATE TABLE IF NOT EXISTS projects (
    id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL UNIQUE,
    customer VARCHAR(255), client VARCHAR(255), description TEXT,
    status VARCHAR(20) DEFAULT 'active' CHECK (...), created_at ..., updated_at ...
)`
// vs PROJECT_ALTER_COLUMNS:76-88 — start_date DATE, end_date DATE, location, project_type present
```

---

## Layer coverage table

A = `server/schema.sql` (fresh installs) · B = startup `runMigrations()` in `server/index.js` (existing DBs) · C = lazy `server/utils/schemaRepair.js` (cold-instance self-heal)

| Table | A | B | C | Notes |
|---|---|---|---|---|
| employees, roles, leave*, wfh, tickets, attendance*, documents, payroll, holidays, announcements, push_subscriptions, etc. (≈32 tables) | ✓ | — | partial | Layer A only; C covers the subset its query paths can hit via `ENSURE_TABLE_DDL` (21 keys) |
| projects, project_employees, project_documents, project_daily_updates, project_units, work_assignments, daily_work_logs, project_leads, employee_status_history | ✓ | ✓ (B CREATEs) | ✓ | Full three-layer parity (the newest/widest-covered domain) |
| user_notifications | ✓ | — | ✓ | A blocked by F1 `//` lines; created lazily via C |
| team_transfer_requests, team_handovers, employee_processes, process_tasks, project_status_updates | ✓ | — | ✓ | A-only in B's view — F2 means `db:migrate` never creates them |
| project_settings | ✓ | — | — | Dead table (F8) |

| Column set | A | B | C | Notes |
|---|---|---|---|---|
| work_assignments v2 (`blocked_reason`, `cancel_reason`, `started_at`, `cancelled_at`, `start_date`, `assigned_at`) | ✓ | ✓ | ✓ | Full parity (schema.sql:794-801, index.js:370-375, schemaRepair.js:570-578) |
| `employees.token_version` | ✓ | ✗ | ✓ | F5 |
| `attendance.break_start/break_end/break_log` | ✓ (CREATE only) | ✗ | ✗ | F4 — layer A only |
| `attendance.auto_checkout*` | ✓ | — | ✓ | F4-adjacent but covered by C's `ATTENDANCE_ALTER_COLUMNS` |
| `announcements.expires_at`, `hr_task_templates.type`, `leave/wfh/tickets.manager_id+hr_id` | ✓ | ✓ | — | A+B parity |

---

## Verified sound

- **Three-layer convention is real, not aspirational** — `runMigrations()` (index.js:187-481) and `ENSURE_TABLE_DDL` (schemaRepair.js:110-477) genuinely exist and cover the newest domain (projects/work-assignments) with full three-layer parity.
- **`ENSURE_TABLE_DDL` creates full tables with FKs**, not bare columns — e.g. `attendance_regularizations` (schemaRepair.js:126-143) is a complete `CREATE TABLE ... REFERENCES ... ON DELETE` — referential integrity is preserved even through the self-heal path.
- **Work-assignment v2 columns** — the most recent schema change — are correctly added to **all three layers** with matching types (schema.sql:794-801, index.js:370-375, schemaRepair.js:570-578), proving the convention *can* be followed; F4/F5 are drift on older/one-off changes, not a broken process.
- **`attendance` unique constraint** — `UNIQUE(employee_id, date)` (schema.sql:115) is in place, backing the duplicate-check-in prevention described in AGENTS.md §11 (409 + conditional `ON CONFLICT` update). Empirically verified against hermetic PG.
- **`user_notifications` FK index** — `idx_un_employee` (schema.sql:880) present on the bell-feed hot path.
- **`employees.reporting_manager_id`** — indexed, and correctly used by manager-scoped queries across `manager.js`/`notifications.js`.
- **Attendance read-path fix (2026-10-08, `docs/FEATURE_ATTENDANCE_MY_READPATH_FIX.md`)** — `dateOnly()` normalization is correctly applied at attendance.js:45,121,486,534,685,830, and the guarded "open row?" pre-check avoids the company-wide scan on the common path. Same-day duplicate check-ins are structurally impossible.
- **`pgErrorResponse` error hygiene** — no route inspected in this audit leaked raw Postgres error text in a success-shaped payload; the mapper is applied consistently on the paths checked.
- **Hermetic QA cluster recipe in `scripts/qa-commander.cjs`** (spin-up/teardown, `stripSchema`) is sound and reproducible — used as the empirical backbone of this audit (though `stripSchema` is also what hides F1 from QA).

---

## Summary: 9 findings (2 high, 3 medium, 4 low)

- **F1 (HIGH)** — `//` comments break `db:init` entirely at HEAD; QA's `stripSchema()` hides it.
- **F2 (HIGH)** — `db:migrate`'s naive `split(';')` silently skips 35/219 statements, incl. 7 tables.
- **F3 (MEDIUM)** — `runWithSchemaRepair` imported-but-unused in leave/wfh; 320 raw `query()` calls across 29 files.
- **F4 (MEDIUM)** — attendance break columns added to layer A only.
- **F5 (LOW)** — `token_version` missing from layer B.
- **F6 (MEDIUM)** — leave/WFH routes return raw `DATE`; client `split('T')[0]` off-by-one off-UTC hosts.
- **F7 (LOW)** — missing indexes: `support_tickets.employee_id`; `leave/wfh.manager_id+hr_id`; `project_employees` plain scan indexes.
- **F8 (LOW)** — `project_settings` is a dead table.
- **F9 (LOW)** — layer C's `projects` DDL narrower than layer A (mitigated by B/C ALTERs).
