# My Info fix batch + Sprint-1 shared fixes

> Shipped 2026-10-09 as the fix sprint following the full-system audit
> (`qa/audit-*.md` → `qa/triage.md`). This batch closes the **My Info**
> employee-login audit (`qa/audit-myinfo.md`: MI-1…MI-7) plus a bundle of
> wiring/schema/security/contract findings from the 4-agent squad, and stands
> up a new 57-check hermetic harness (`scripts/qa-fix-sprint.cjs`) that pins the
> whole batch.

**Gate:** hermetic `npm run qa` → **55/55 stages green, 0 failed**
(discover + 5 regression harnesses, 175 RBAC cell probes incl. 3 new matrix
rows, 43 DB invariants, zero QA leftovers). Verification details per fix below.
No schema writes beyond the additive 3-layer parity; one destructive-migration
ledger (A1) now gates the historical reshape DDL.

---

## 1. My Info audit (MI-1 … MI-7) — all closed

| ID | Finding | Fix | Verification |
|----|---------|-----|--------------|
| MI-1 | Raw Postgres `DATE` forwarded on 9 read routes → client `date.split('T')[0]` off-by-one off-UTC | `dateOnly()` normalization on holiday/leave/wfh/regularization/work-assignments/daily-work-logs/projects ×3/project-updates/project-access reads + created/updated responses | fix-sprint harness: `/attendance/my`, `/leave/my`, `/holidays`, `/regularization/mine` all return plain `YYYY-MM-DD` |
| MI-2 | False "no data" empty states while fetch is in flight | 3-way loaders (Syncing → data | error+Retry) on attendance/leave/my-projects pages | node --check + inline-JS gate + UI reviewed |
| MI-3 | Profile-request cancel was TOCTOU + unaudited (could clobber an approved request) | auth.js `POST /profile-request/:id/cancel` → single conditional `UPDATE … WHERE status='pending'` + owner guard + `logAudit` | harness: first cancel 200, second 400, `profile_request.cancel` audit row written |
| MI-4 | Project-access approve/reject/cancel race → duplicate grants + unaudited cancel | `decideRequest`: conditional flip is the arbiter; grant INSERT commits in the same transaction as the status flip; cancel/reject also conditional + audited | harness: double approve 400, exactly **1** grant row, cancel-after-approve 400, approve+cancel audits written |
| MI-5 | Weekday math used JS timezone instead of office day | `getTodayIST()`/`getWeekDayIST`-style office-timezone weekday on leave page | inline-JS gate green (leave.html) |
| MI-6 | `toISOString()` used for "today" → wrong day before 05:30 IST | `getTodayIST()` (date-only via local-noon trick) on my-projects page | inline-JS gate green |
| MI-7 | No fetch timeout on the attendance card | `apiCall({ timeoutMs })` (default 20 s) + 3× backoff retry in `loadAttendanceStatus` before the error card | check-in status harness 24/24 still green |

Also fixed en route: `GET /attendance/photo/:token` now `isAdminOrHr` (was
`isAdmin`) — the HR vault photo button is now openable (contract F6).

## 2. Server / schema / security batch (shared)

- **A1 — one-time migration ledger.** `schema_migrations` table + `appliedMigrations()`;
  the destructive `hrms_project_reshape` DROPs are **gated** behind
  `applied.has('hrms_project_reshape')` and recorded once — no more re-running
  destructive DDL on every cold start (wiring F1).
- **A2 — cloudinary removed** from package.json (declared, never required).
- **A3 — bare `/manager` + `/employee` roots** now serve the login page,
  symmetric with `/admin` (wiring F3).
- **F5 — `employees.token_version`** added to layer B startup (schema F5).
- **F7 — indexes** `idx_leave_applications_approver`, `idx_wfh_requests_approver`,
  `idx_support_tickets_employee`, `idx_project_employees_project`,
  `idx_project_employees_employee` in schema A; approver indexes + token index
  in layer B (schema F7). Layer C intentionally skips indexes (perf-only).
- **F8 — single `MIN_PASSWORD_LEN = 8`** exported from `validation.js` and used
  by change/set/OTP-reset + employees reset paths (security F8).
- **F8-schema — dead `project_settings` table dropped** from schema.sql
  (schema F8); `projects` layer-A DDL widened with
  `start_date/end_date/location/project_type` (schema F9) and layer-C projects
  DDL updated to match.
- **F10 — central error handler** in `index.js` routes every uncaught error
  through `pgErrorResponse` (security F10) — friendly 400s, never raw PG text.
- **C-F1 — document download guard `admin || hr || owner`** (was admin/owner;
  HR could list + permanently delete but not open a doc — contract F1).
- **D-F5 — whole admin-account edit (`PUT /employees/:id`) is MAIN_ADMIN-only**
  (security F5): any field change on an admin target → only `MAIN_ADMIN_ID`
  may write; `/auth/profile` self-edit remains for the admin themself.
- **D-F7 — forgot-password uniform 200** for unknown/known identifiers AND a
  silent 200 when SMTP is down (the 502 "Email service is not configured"
  branch leaked enumeration + config state; now logged, not sent) (security F7).
- **D-F6 — logAudit completion** across settings, departments, designations,
  announcements (create/update×2/delete), profileUpdates approve/reject (PII),
  tickets create/respond, auth profile-request create/cancel, attendance
  mark-present/mark-absent/reset, leave/wfh/regularization/onboarding applies
  (security F6).
- **security F1–F4 — raw-error hygiene** in employees (detail dropped),
  onboarding start, multer-failure mapping (documents), and the auto-checkout
  cron failure string; all mapped via `pgErrorResponse`.
- **MI-5/MI-6 (client) + Beta resilience** — dashboard bell sums
  `pendingRegularizations` (contract F9) and the my-team leave badge; attendance
  page tolerates check-in/check-out cache races; holiday warning surfaces on the
  leave balance calculator (sandwich rule).
- **Gamma — admin UI parity**: write buttons (add/edit/delete) on
  departments/designations/holidays/announcements gated to admins; my-team
  Regularization Approve/Reject gated to `_myTeamUser.role === 'admin'`;
  HR redirected away from project-management/audit-logs/settings pages
  (contract F2/F3/F7).
- **Schema F3/F4 parity** — dead `runWithSchemaRepair` imports removed from
  leave/wfh; `attendance.break_start/break_end/break_log` mirrored into layer B
  startup ALTERs (was layer A + C only).

## 3. New QA surface

- `scripts/qa-fix-sprint.cjs` — 57-check hermetic harness pinned to this batch
  (A1/A3, F5/F7/F8 schema + F8 min-length via change-password, D-F7 uniformity,
  F6 photo widen, C-F1 download guard, MI-1 date normalization, MI-3/MI-4
  TOCTOU + audits, D-F6 ticket audit, zero-leftover cleanup). Wired into
  `qa-commander.cjs` `HARNESSES` as the 5th regression harness (fresh server
  between harnesses resets the in-memory login limiter).
- `qa/rbac-matrix.json` +3 rows (**37 rows / 175 cell probes**):
  `regularize-review` (admin-only review), `wfh-apply`
  (`blockAdminSelfService` boundary), `att-photo` (F6 widen: admin/hr 404 vs
  manager 403).
- `public/sw.js` cache `v13 → v14` for the shipped static assets.

## 4. Bugs the new harness caught before ship

1. `regularization.js` called `dateOnly()` without importing it → runtime
   `ReferenceError` (500) on `/regularization/mine` — import added; duplicate
   normalize loop removed.
2. `forgot-password` known-identifier branch returned **502** when SMTP was
   unconfigured — an account-existence oracle (see D-F7).
3. Fix-sprint harness v1 probed `employees/:id/reset-password` for min-length —
   that route generates its own temp password (never reads the body value) and
   **bumps `token_version`**, revoking the QA employee's token mid-matrix. The
   probe now targets `PUT /auth/change-password` (validates `MIN_PASSWORD_LEN`
   before any write). Lesson #2 of this QA discipline, after the reset-password
   dedicated-account rule.
4. `logAudit` is fire-and-forget by design — audit asserts now poll
   (`waitForAudit`), not race the async INSERT.

## 5. Remaining decision gates

See `qa/triage.md` §DECISION-NEEDED: contract F8 / security F11 (projects
read parity `GET /api/projects` → `isAdminOrHr`?), security F12 (audit-log UI
hides admin rows), security F13 (in-memory rate limiting accepted), security
F15 (login statuses intentional), security F9 (block-admin-self-service
exceptions documented in AGENTS §6).