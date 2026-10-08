# Sprint 1 Audit — Full Triage (Program Manager ledger)

> Single source of truth for the 36 Sprint-1 audit findings + session-discovered items.
> **Updated:** 2026-10-09 (fix batch shipped).
> Evidence files (read-only audits): `qa/audit-wiring.md` (3), `qa/audit-schema.md` (9),
> `qa/audit-contract.md` (9), `qa/audit-security.md` (15), `qa/audit-myinfo.md` (7).
> The whole shared fix batch shipped together — see `docs/FEATURE_MYINFO_FIXES.md`
> (gate: hermetic `npm run qa` **55/55 green**, 0 failed).

**Status legend:** `SHIPPED` committed+pushed · `FIXED-PENDING-VERIFY` code done, awaiting hermetic
verify + commit · `QUEUED` planned · `DECISION-NEEDED` owner/product call · `DEFERRED` documented risk.

Counts: 36 findings = **3 high** (schema F1, schema F2, contract F1) · 9 medium · 24 low.
After the fix batch + owner decisions: **0 high open · 0 medium open · 1 low open**
(security F12 — audit-log admin rows, owner decision pending; all other lows
SHIPPED or explicitly DEFERRED-by-owner).

---

## HIGH

| ID | Finding (one-line) | Evidence | Fix plan | Status |
|----|--------------------|----------|----------|--------|
| schema F1 | `schema.sql` `//` comments break `npm run db:init` (0 tables at HEAD); QA `stripSchema()` hid it | audit-schema.md F1 | `//` → `--` at lines 858-862; QA boots schema verbatim with `ON_ERROR_STOP=1` | **SHIPPED** `c5fe134` |
| schema F2 | `migrate.js` naive `split(';')` silently skipped 35/219 stmts incl. 7 tables | audit-schema.md F2 | SQL-aware tokenizer (comments/quotes/`$tag$`) + fail-loud + `require.main` guard | **SHIPPED** `c5fe134` |
| contract F1 | HR can list + permanently delete documents but `GET /:id/download` excludes `hr` (403 on read) | audit-contract.md F1 | documents.js:115 guard → `admin \|\| hr \|\| owner`; verify HR reaches storage-404 (not guard-403), deny cells still 403 | **SHIPPED** (this batch; harness: HR/owner 404-not-403, team_lead 403) |

## MEDIUM

| ID | Finding | Evidence | Fix plan | Status |
|----|---------|----------|----------|--------|
| wiring F1 | Destructive startup DDL re-runs every cold start (pool contention + silent-drop hazard) | audit-wiring.md F1 | One-time migration-applied ledger (table), skip block when marked; keep additive ALTERs | **SHIPPED** (A1: `schema_migrations` + `appliedMigrations()`; reshape gated + recorded once) |
| schema F3 | `runWithSchemaRepair` imported-but-unused in leave/wfh (320 raw `query()` across 29 files) | audit-schema.md F3 | Wire `q = runWithSchemaRepair` wrapper in leave.js/wfh.js (remove unused imports or use them) | **SHIPPED** (unused imports removed — additive startup ALTERs make self-heal redundant there) |
| schema F4 | attendance `break_*` columns live only in layer A | audit-schema.md F4 | Add to layer B startup ALTERs + C `ATTENDANCE_ALTER_COLUMNS` | **SHIPPED** (layer B `ALTER TABLE attendance ADD COLUMN IF NOT EXISTS` `break_start/break_end TIME` + `break_log TEXT`; layer C already) |
| schema F6 | Leave/WFH routes return raw `DATE`; client `split('T')[0]` off-by-one off-UTC | audit-schema.md F6 | `dateOnly()` on leave/wfh read routes (mirror attendance fix) | **SHIPPED** (dateOnly across leave/wfh + all 9 My Info read surfaces — MI-1) |
| contract F2 | HR sees Add/Edit/Delete on departments/designations/holidays/announcements; writes are `isAdmin` | audit-contract.md F2 | UX: hide write buttons for non-admin on the 4 pages (or drop pages for HR) — server boundary already correct | **SHIPPED** (Gamma: `isAdmin` gating on all 4 pages) |
| contract F3 | My Team shows Regularization Approve/Reject to HR/manager/TL; `/regularization/:id/review` admin-only | audit-contract.md F3 | Gate buttons `role === 'admin'` (UI) + add `regularize-review` RBAC row; keep review admin-only | **SHIPPED** (Gamma gating + matrix row verified) |
| contract F4 | 16/35 route modules have zero harness + zero RBAC row | audit-contract.md F4 | Phase 2: add matrix rows (wfh, tickets, work-assignments guard, then governance bundle) | **QUEUED** (deferred to roadmap after fix sprint) |
| contract F5 | No UI↔API contract test — root cause of F1–F3/F6/F7 class | audit-contract.md F5 | Playwright golden journeys (deferred decision) — documented in QA commander doc | **DEFERRED** (Phase 2, by earlier decision) |
| security F5 | HR can edit an admin's salary/bank/reporting via `PUT /employees/:id` | audit-security.md F5 | Any field change on an admin target → MAIN_ADMIN-only (after confirming admin self-edit route exists) | **SHIPPED** (D-F5: `MAIN_ADMIN_ID` guard; `/auth/profile` self-edit confirmed) |
| security F6 | Missing `logAudit` on ~11 mutation paths (settings, announcements, structure, profileUpdates approve, tickets, apply×3, attendance mark/reset) | audit-security.md F6 | Add `logAudit` calls; prioritise profileUpdates approve (PII) + back-dated attendance edits | **SHIPPED** (D-F6 complete: settings, departments, designations, announcements, profileUpdates approve/reject, tickets create/respond, auth profile-request create/cancel, attendance mark-present/absent/reset, apply×3) |
| security F7 | `forgot-password` is an account-existence oracle (404 vs 200) | audit-security.md F7 | Always 200 + generic body, silent lookup, keep 5/15m limiter | **SHIPPED** (D-F7: uniform generic 200 for unknown/known **and** SMTP-down branch — harness 5/5) |

## LOW

| ID | Finding | Evidence | Fix plan | Status |
|----|---------|----------|----------|--------|
| wiring F2 | `cloudinary` declared, never required | audit-wiring.md F2 | `npm uninstall cloudinary` (package.json + lock) | **SHIPPED** (A2) |
| wiring F3 | Bare `/manager` `/employee` roots 404 while `/admin` works | audit-wiring.md F3 | Serve login page for bare roots symmetric with `/admin` | **SHIPPED** (A3; harness asserts 200 HTML for `/manager` `/employee` `/admin` + portal pages) |
| schema F5 | `token_version` missing from layer B | audit-schema.md F5 | Add to startup ALTER block in index.js | **SHIPPED** (F5; harness asserts column present) |
| schema F7 | Missing indexes: `support_tickets.employee_id`, `leave/wfh.manager_id+hr_id`, `project_employees` plain scans | audit-schema.md F7 | `CREATE INDEX IF NOT EXISTS` in all three layers | **SHIPPED** (5 indexes in schema A; approver + token indexes in layer B; harness asserts all 5) |
| schema F8 | `project_settings` dead table (layer A only, zero consumers) | audit-schema.md F8 | Remove from schema.sql (or wire up) | **SHIPPED** (removed; harness asserts absent on fresh install) |
| schema F9 | Layer C `projects` DDL narrower than layer A (mitigated) | audit-schema.md F9 | Add `start_date/end_date/location/project_type` to C create DDL | **SHIPPED** (layer C widened; layer A already full) |
| contract F6 | HR views check-in photo button but `/attendance/photo/:token` is `isAdmin` → generic "Failed to load photo" | audit-contract.md F6 | Hide photo buttons for non-admin OR widen to `isAdminOrHr` (attendance read surface is HR-capable) | **SHIPPED** (widen; harness: HR 404-not-403, manager 403) |
| contract F7 | Hidden admin pages stay URL-reachable for hr/manager → broken pages (no data exposure) | audit-contract.md F7 | Page-onload role redirect (like team_lead bounce) or leave as-is (API boundary holds) | **SHIPPED** (Gamma: HR redirected on project-management/audit-logs/settings) |
| contract F8 | `AGENTS.md` §6 "HR read-only on projects" vs `GET /api/projects` = `isAdmin` | audit-contract.md F8 | **DECISION-NEEDED**: widen to `isAdminOrHr` or amend §6 | **SHIPPED** (owner DECIDED 2026-10-09: widen. `GET /`, `/stats`, `/:id` → `isAdminOrHr`; writes admin-only; matrix `proj-list` cell flipped hr→allow + re-verified) |
| contract F9 | Admin/HR bell sum omits `pendingRegularizations` (server `total` unused) | audit-contract.md F9 | Add `pendingRegularizations` to dashboard.js admin/hr sum | **SHIPPED** (Beta: bell-sum includes it; my-team badge parity) |
| security F1 | employees.js:668/902 admin `detail = error.message` (raw PG text) | audit-security.md F1 | `pgErrorResponse(error).message` or drop `detail` | **SHIPPED** (raw detail dropped) |
| security F2 | onboarding start concatenates raw driver message | audit-security.md F2 | Log `r.error`, return `pgErrorResponse(e).message` | **SHIPPED** |
| security F3 | Multer failures echo `err.message` (any authed user) | audit-security.md F3 | Map known multer codes, else generic | **SHIPPED** (documents upload mapping) |
| security F4 | Cron responses can carry raw error string (secret-holder-only) | audit-security.md F4 | Generic string in attendanceAutoCheckout failure branch | **SHIPPED** |
| security F8 | Inconsistent password minimums (6/8/none) | audit-security.md F8 | Single `MIN_PASSWORD_LEN = 8` on all 4 paths (create/change/OTP-reset/admin reset) | **SHIPPED** (validation.js constant; harness asserts change-password <8 → 400) |
| security F9 | `blockAdminSelfService` gaps: daily-work-logs, tickets, documents/upload | audit-security.md F9 | Mount guard on the 3, or document deliberate exceptions in §6 | **SHIPPED** (owner DECIDED 2026-10-09: deliberate exceptions — documented in AGENTS.md §6; admins log own work, file tickets, upload own docs) |
| security F10 | ~20 DB routes don't import `pgErrorResponse` (friendly-400 convention) | audit-security.md F10 | Centralise mapping in global error handler (index.js:109-116) so every route inherits | **SHIPPED** (central handler in index.js) |
| security F11 | Role-model divergences stricter than §6: designations/departments manager-blocked, projects HR-blocked, documents download HR-blocked | audit-security.md F11 | Decide per row (align code ↔ §6); keep `applyRoleNav()` parity | **SHIPPED** (owner DECIDED 2026-10-09: projects reads widened to `isAdminOrHr` — contract F8 row; documents download already SHIPPED via contract F1; designations/departments stay manager-403 by design) |
| security F12 | Audit-log UI hides every admin-actor row | audit-security.md F12 | Confirm intent; filter by event type instead of actor role if accidental | **DECISION-NEEDED** |
| security F13 | Rate limiting in-memory per serverless instance | audit-security.md F13 | Store counters in Postgres/Redis, or accept + document | **DEFERRED** (owner ACCEPTED 2026-10-09 + documented; D-F7 removed the worst-case oracle) |
| security F14 | CORS falls back to `localhost:3000` when `ALLOWED_ORIGINS` unset (SUSPECTED) | audit-security.md F14 | Verify Vercel env has `ALLOWED_ORIGINS`; fail closed if unset | **SHIPPED** (verified live 2026-10-09: fallback allow-list active — `garchitects.in`/localhost get ACAO, all other origins fail-closed; deployed SPA is same-origin, unaffected. Optional hardening: set `ALLOWED_ORIGINS` explicitly on Vercel) |
| security F15 | Login discloses account status (deliberate UX) | audit-security.md F15 | Optional: generic "Invalid credentials" post-auth statuses | **DEFERRED** (owner CONFIRMED 2026-10-09: intentional UX — kept) |

---

## My Info audit (from `qa/audit-myinfo.md`) — all SHIPPED this batch

| ID | Finding | Status |
|----|---------|--------|
| MI-1 | Raw Postgres `DATE` forwarded on 9 read routes (off-by-one off-UTC on client `split('T')[0]`) | **SHIPPED** — `dateOnly()` normalization (holidays, leave ×3, wfh ×3, regularization ×2, work-assignments ×2, daily-work-logs ×2, projects ×5, project-updates, project-access ×3) |
| MI-2 | False "no data" empty states while fetch in flight | **SHIPPED** — 3-way loaders (attendance/leave/my-projects) |
| MI-3 | Profile-request cancel TOCTOU + unaudited | **SHIPPED** — single conditional UPDATE + owner guard + audit; harness 3/3 |
| MI-4 | Project-access approve/reject/cancel race → duplicate grants + unaudited cancel | **SHIPPED** — conditional-flip arbiter + grant in same tx; cancel audited; harness asserts single grant |
| MI-5 | Weekday math used JS timezone instead of office day | **SHIPPED** — office-timezone weekday on leave page |
| MI-6 | `toISOString()` used for "today" → wrong day before 05:30 IST | **SHIPPED** — `getTodayIST()` on my-projects page |
| MI-7 | No fetch timeout on the attendance card | **SHIPPED** — `apiCall({ timeoutMs })` default 20 s + 3× backoff retry |

---

## Session-discovered (beyond the 36)

| Item | Finding | Status |
|------|---------|--------|
| QA commander stripSchema quarantine | Audit-schema F1 revealed `stripSchema()` masked the `//` bug; removed, schema boots verbatim | **SHIPPED** — folded into `c5fe134` + commander hardening |
| QA commander invariants stage | New stage between rbac and db — Leave/Attendance/Payroll DB invariants, hermetic-only | **SHIPPED** `d9f1e4a` (43/43 green) |
| Full-gate re-run | discover+regression(4)+rbac(160)+invariants(43)+db after commander changes | **SHIPPED** — 51/51 green, zero leftovers (2026-10-09) |
| regularization.js dateOnly ReferenceError | `dateOnly()` called without import → 500 on `/regularization/mine` (caught by the new fix-sprint harness) | **SHIPPED** — this batch (import added) |
| forgot-password SMTP-down 502 | Known-identifier branch returned 502 "Email service is not configured" when SMTP unconfigured → account oracle (caught by harness) | **SHIPPED** — this batch (silent generic 200, logged) |
| reset-password token_version trap | Employees `:id/reset-password` generates its own temp password + bumps `token_version` — never probe it with the QA employee mid-matrix | **SHIPPED** — this batch (harness probes `change-password` instead; documented in FEATURE doc §4) |
| Fix-sprint harness + matrix rows | 5th regression harness (57 checks) + 3 RBAC rows (regularize-review, wfh-apply, att-photo) → 37 rows / 175 probes | **SHIPPED** — this batch (see `docs/FEATURE_MYINFO_FIXES.md`) |

---

## Route-map for the fix sprint (batch order)

1. **Documented gate** → push `qa/triage.md` with the pending My Info agent findings merged (agent to report first). — ✅ **DONE** (this batch)
2. **Fix batch (hermetic-verified, atomic commits):**
   - My Info agent findings (from `qa/audit-myinfo.md`) — priority. — ✅
   - C-F1 verify + commit; A2 (cloudinary); A3 (bare roots); schema F5/F7/F8/F9 layers; security F1–F4, F8–F10; contract F6/F9; D-F5 (admin-edit), D-F7 (forgot-password); schema F3/F4/F6 (leave/wfh/attendance wrapper+layers+dateOnly). — ✅
3. **DECISION-NEEDED triage** → present to owner: contract F8/security F11 (projects+download parity), security F12 (audit-log), F13 (rate-limit), F15 (login statuses). — ✅ **RESOLVED 2026-10-09** (F8/F11 widen SHIPPED, F9 exceptions documented, F13/F15 accepted/kept, F14 verified live). Only **security F12** (audit-log UI hides admin rows) remains — owner follow-up pending.
4. **Phase 2 (roadmap, deferred by earlier decision):** matrix auto-discovery, Playwright golden journeys, CI wiring, Work Assignments v2 Increment 2/3.