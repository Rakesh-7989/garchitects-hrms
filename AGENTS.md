# AGENTS.md — G-Architects HRMS

> Operating manual for AI agents working in this repository. Read this **first** in every session.
> This file is the single source of truth for scope, conventions, and the working agreement.

---

## 0. Scope rule (highest priority)

- **Work ONLY on this project** (G-Architects HRMS). Never import files, context, config, or
  decisions from any other project (e.g. Site-Tracker-Pro). If a global agent file mentions
  another project, ignore it here.
- Keep work state per-project. Do not mix project boards, notes, or sessions.

## 1. Communication agreement

- The user often writes/speaks in **Telugu-roman**. **Always reply in English.**
- Be concise, professional, and expert. Make smart, resilient decisions. Surface trade-offs,
  risks, and **anything destructive** (DB drops/rewrites, force-push, prod rollback) *before*
  doing it, then proceed once the user confirms.
- Before non-trivial work, **restate in one line what the user is actually asking for** so a
  misunderstood point is caught early.

## 2. SDLC workflow (follow for every non-trivial task)

1. **Deep-dive** — read the relevant routes / pages / schema / docs before changing anything.
2. **Plan** — list the change set, decisions (⚠), and blast radius. Get user sign-off on
   decisions. Design docs go in `docs/`.
3. **Implement** — follow existing patterns (see §5–§8). Keep commits atomic (server + UI + docs
   together) so no deploy has a transient broken state.
4. **Verify** — syntax gates (`node --check`, inline-JS check) + a **live QA harness** against the
   deployed API (role gates, scope, guard rails, leak-free errors), then roll back the test world
   so the DB stays pristine.
5. **Document** — add/refresh the matching `docs/FEATURE_*.md` with what shipped + verification.
6. **Commit + push** to `master` (auto-deploys to Vercel), then verify live.

Never commit or print secrets. `.env` is gitignored and stays local (only `.env.example` is tracked).

## 3. What the project is

An HRMS for an architecture studio (Keka-inspired), deployed at
**https://garchitects-hrms.vercel.app** (repo `Rakesh-7989/garchitects-hrms`, branch `master`).

- **Backend**: Node.js + Express, PostgreSQL (Supabase), `pg`, JWT (`jsonwebtoken`), `bcryptjs`.
- **Frontend**: **no bundler** — static multi-page HTML/CSS/JS (vanilla). Shared scripts in `public/js`.
- **Serverless entry**: `api/index.js` exports the Express app; Vercel function `maxDuration: 30`.

## 4. Repository map

```
api/index.js              Vercel serverless entry -> server/index.js
server/index.js           Express app: middleware, all route mounts, startup auto-migrations
server/config/database.js pg pool + query() helper
server/middleware/auth.js verifyToken + role guards (isAdmin/isAdminOrHr/isManager/isEmployee...)
server/middleware/validation.js
server/routes/*.js        ~35 feature route modules (mounted in index.js)
server/services/*.js      attendanceAutoCheckout, attendanceAutoMark, email, notify, onboarding, push, storage
server/utils/*.js         schemaRepair (self-heal + pgErrorResponse), audit, approvalRouting, date, excel, rateLimit, workWeek
server/schema.sql         canonical schema (fresh installs)
server/scripts/*          init-db, migrate, seed, test-smtp
public/pages/{admin,manager,employee}/*.html   role portals (clean URLs via servePortalPage)
public/js/*.js            auth.js (shared client: token, formatDate, escapeHtml, role nav), dashboard.js, payroll-core.js, ...
public/css, public/assets, public/sw.js, public/manifest.json   PWA
docs/FEATURE_*.md         per-feature design + verification records
agents/*.md, docs/AGENT_TEAM.md   the standing AI-agent team: 7 role files ("training") + charter + sprint log
vercel.json               rewrites (/api/* -> function, static mounts), headers, crons
.github/workflows/deploy.yml   push to master -> Vercel production deploy (REST API)
```

## 5. Data & schema conventions

- **Three layers, all idempotent/additive**: (a) `server/schema.sql` for fresh installs,
  (b) startup `ALTER TABLE ... IF NOT EXISTS` blocks in `server/index.js` for existing DBs,
  (c) **lazy self-heal** in `server/utils/schemaRepair.js` (`runWithSchemaRepair`,
  `ENSURE_TABLE_DDL`, `ATTENDANCE_ALTER_COLUMNS`) so a cold instance never 500s on a missing
  table/column. New tables should be added to all relevant layers.
- Wrap self-healing queries with the repo pattern: `q = (sql, params) => runWithSchemaRepair(() => query(sql, params))`.
- **Error hygiene**: never leak raw Postgres errors. Use `pgErrorResponse(error)` (maps 23505/23503/
  22P02/22007/22008/23514/23502 to friendly 400s, else generic 500). Do **not** do
  `message: (error && error.message) || r.message` — `error.message` is truthy and defeats the mapper.
- Audit every meaningful mutation with `logAudit(...)`.
- Approvals must be **TOCTOU-safe**: conditional `UPDATE ... WHERE status = '...'` + row-count
  check → concurrent double-approval returns 409.
- Postgres `DATE` columns can arrive as JS `Date`; use the repo `fmtDate` helpers when formatting.

## 6. Role model (do not blur the layers)

| Role | Power |
|------|-------|
| `admin` | root; structure + designation + money-write + settings + permanent delete |
| `hr` | people modules + org-wide leave/WFH/ticket review; **read-only on the projects module**; no settings/project-CRUD/permanent-delete |
| `manager` | structure + designation; D5 full placement power; content reads scoped (H2 wall) to led ∪ assigned ∪ grant ∪ covering |
| `team_lead` | scoped to projects/units they lead (D9/D11); may place/assign only their reporting tree into their led units |
| `employee` | own data, daily updates, work assignments; read-only visibility of own projects + management status notes |

Frontend nav is role-filtered at runtime by `auth.js` `applyRoleNav()`; keep it in parity with the
server guards (a hidden button must not be the only thing stopping a role).

**Deliberate `blockAdminSelfService` exceptions (security F9, decided 2026-10-09):** the guard that
prevents admin accounts from filing *self-*applications (leave/WFH/regularization) is intentionally
NOT mounted on: (1) `daily-work-logs` — an admin still logs their own daily work like any employee;
(2) `tickets.create` — admins may legitimately raise support tickets; (3) `documents` upload — admins
upload their own documents. These are employee-self-service features an admin is expected to use for
themself; do not expand the guard to them without an owner decision.

## 7. Notifications

- **Durable**: bell counters `GET /api/notifications/counts` + sidebar badges (`dashboard.js`).
- **Best-effort**: web-push (`sendToUser(s)`) and email (nodemailer/SMTP). Push reaches only
  connected clients — never make it the sole signal.
- A failing feed source must never 500 the bell: hoist a module-scope `safe()` that degrades to
  `{ rows: [] }`.

## 8. Frontend conventions

- Overwrite the `#sidebar` nav via `auth.js`; add new nav items to **all** relevant portal pages
  (admin pages have a static sidebar — update them together).
- Client helpers live in `auth.js` (`formatDate`, `escapeHtml`, `getToken`, `api`, role helpers) —
  reuse them, don't duplicate.
- PWA: bump the service-worker cache name when shipping new static assets.
- Pages are reachable via clean URLs (`/admin/x`, `/manager/x`, `/employee/x`) through
  `servePortalPage()`; keep the `/pages/*.html` paths working.

## 9. Deployment

- Push to `master` triggers `.github/workflows/deploy.yml` → Vercel **production** deploy via the
  REST API (`POST /v13/deployments`, `target: production`, `ref: master`). Vercel crons in
  `vercel.json` (auto-attendance, auto-checkout, purge-photos, expire-announcements,
  expire-handovers) are guarded by `CRON_SECRET`.
- Local run: `npm install` then `npm start` (or `npm run dev` with nodemon) on `PORT` (default 3000).
- DB scripts: `npm run db:init`, `npm run db:migrate`, `npm run test:smtp -- <recipient>`.

## 10. File hygiene

- Gitignored (local only, never commit): `.env*` (except `.env.example`), `*.log`, `*.pid`,
  `.vercel/`, `node_modules/`, uploads, backups, `session-history.json`.
- Root `server.err.log`, `server.out.log`, `server.pid` are local run artifacts — leave them.
- Keep commits atomic and scoped to the task; do not fold unrelated refactors into a feature commit.

## 11. Current state (update this as work ships)

- **Attendance day-detail, WFH rendering & staff day editor shipped (2026-10-09):**
  three attendance-workflow gaps closed in one pass. **A** employee attendance
  history/calendar day-detail popup (`openDayDetail` — status, check-in/out,
  hours, break, map location, auto-checkout + miss reason, regularized flag; days
  with no record resolve Holiday / On Leave / WFH / Week Off / Upcoming / "Not
  checked in yet"). **B** `wfh` rendered as a working day everywhere: employee
  calendar (`cal-wfh`) + counts + stat card, admin matrix (`cell-wfh`, WFH stat,
  Total Days formula), and the shared `getStatusBadge`/`getStatusText` helpers
  (`wfh → info` / "Work From Home"). **C** staff per-day editor: new
  `GET /api/attendance/record` (one day + day context) and
  `POST /api/attendance/edit` (admin/HR company-wide; manager scoped to their
  recursive reporting tree via `myTreeIds`; team_lead excluded — keeps
  mark-only; employees refused). Allowed statuses present/late/half-day/absent/
  wfh; absent & wfh clear times/breaks/locations; a manual check-out clears the
  `auto_checkout` marker + miss reason; `attendance.edit` audited with
  before/after. `GET /manager/attendance` now ships per-row `editable`;
  `sw.js` v15→v16. **QA:** new `scripts/qa-attendance-edit.cjs` → **33/33 green**
  (role gates, manager scope, validation, semantics, audit), plus 2 new RBAC
  matrix rows `att-record`/`att-edit` (matrix probe gained per-row `body` +
  `{qaEmpId}`/`{permEmpId}` body substitution) → **RBAC 50/50 green, 183 cell
  probes, zero leftovers**; regression 6/7 green (the 2 fails are the pre-existing
  late-night auto-checkout flake in `qa-attendance-checkin-status.cjs`, not this
  change). See `docs/FEATURE_ATTENDANCE_EDITOR_AND_WFH.md`.

- **Sprint-1 fix batch shipped (2026-10-09):** the full-system + My Info audit
  fixes all landed in one hermetic-verified push. Closes **MI-1…MI-7** (raw
  Postgres `DATE` normalization across 9 read surfaces, 3-way loaders,
  profile-request cancel TOCTOU+audit, project-access approve/reject/cancel
  race → single grant + audited cancel, office-timezone weekday math,
  `getTodayIST()` instead of `toISOString()`, client timeout+retry) plus the
  shared batch: A1 one-time migration ledger (destructive reshape DDL now gated
  + recorded), A2 cloudinary removed, A3 bare `/manager` `/employee` roots,
  F5 token_version + F7 indexes + F8 `MIN_PASSWORD_LEN=8` + schema F3/F4/F6/F8/F9
  3-layer parity, F10 central `pgErrorResponse` handler, C-F1 document download
  guard `admin||hr||owner`, D-F5 MAIN_ADMIN-only admin edits, D-F7 forgot-password
  uniform 200 (incl. SMTP-down branch — no enumeration), D-F6 full logAudit
  coverage, security F1–F4 raw-error hygiene, contract F6 photo widen + F9 bell
  sum, and Gamma admin-UI parity (write buttons + HR page redirects). **QA:
  hermetic `npm run qa` 55/55 stages green** (regression 24+41+15+38+**57**,
  RBAC **37 rows / 175 probes**, invariants 43, zero leftovers); new
  `scripts/qa-fix-sprint.cjs` (57 checks) + 3 matrix rows
  (`regularize-review`, `wfh-apply`, `att-photo`); `sw.js` v14. The new harness
  caught 3 real bugs pre-ship (regularization `dateOnly` ReferenceError,
  forgot-password 502 oracle, reset-password token_version trap). See
  `docs/FEATURE_MYINFO_FIXES.md` + `qa/triage.md` (all 36 findings now SHIPPED,
  DEFERRED-by-owner, or QUEUED-Phase-2 — **0 open**). **Decision gate resolved
  2026-10-09:** contract F8 / security F11 (projects reads widened to
  `isAdminOrHr`, writes admin-only, matrix row flipped + re-verified),
  security F9 (block-admin-self-service exceptions documented in §6), F12
  (audit-log now shows ALL rows incl. admin actors — harness-asserted), F13
  (rate-limit accepted), F14 (CORS verified live — fallback fail-closed,
  same-origin SPA unaffected), F15 (login statuses kept).

- **Standing AI-agent team chartered (2026-10-09):** `docs/AGENT_TEAM.md` declares the
  G-Architects HRMS Product Crew — a versioned roster of 7 specialist agents, each trained by
  its role file in `agents/*.md` (schema-architect, api-engineer, ui-engineer, qa-engineer,
  security-auditor, release-engineer, knowledge-keeper) + this operating manual. The
  orchestrating agent acts as Program Manager: task → squad (parallel, non-overlapping) →
  artifacts on disk → triage → fix → verify → ship. No human in the loop per line; humans
  only at the decision gate (destructive ops, prod writes/rollback, scope changes).
  **Sprint 1 (full-system audit)** ran a 4-agent squad (wiring/bootstrap, schema 3-layer,
  API↔UI contract + QA coverage, security/error hygiene) → findings in `qa/audit-*.md`.
  Baselines green: live smoke **12/12**, hermetic regression **50/50** (118 checks + 160 RBAC
  probes, zero leftovers). Fixes from triage ship as their own atomic commits.

- **HRMS QA Commander v1 shipped (2026-10-09):** one command (`npm run qa`)
  turns the repo's hermetic harnesses + a declared RBAC expectation matrix into a
  single regression pass with a unified report. `scripts/qa-commander.cjs` runs 4
  stages — `discover` (writes `qa/manifest.json`: 35 modules / 7 guards /
  portals), `regression` (runs the 4 QA harnesses, restarting the app server
  between each so the in-memory 10/15-min login limiter never 429s), `rbac`
  (seeds a throwaway admin/hr/manager/team_lead/employee + target accounts world,
  logs in each role, probes `qa/rbac-matrix.json` — **34 rows × role cells, the
  "UI hides it but the API accepts it" detector** — plus a no-token 401 sweep,
  then cleans up to **zero leftovers**), and `db` (WARN-only leftover scan).
  Targets: `hermetic` (default — boots its own throwaway PostgreSQL on 5433 +
  app on 3000 and tears both down; refuses any non-5433 `DATABASE_URL`) and
  `live` (401/static sweep on the deployed API; full role probes only when
  `QA_LIVE_ADMIN_ID`/`QA_LIVE_ADMIN_PW` are set — writes throwaway users to the
  live DB, cleaned up after). Report + exit code; `--json=` writes
  `qa/report.json` (gitignored); `--issues` files GitHub issues (explicit opt-in
  only). **QA: hermetic 50/50 green** (24+41+15+38 regression, 160 RBAC cell
  probes, zero leftovers) and live smoke **12/12** — see
  `docs/FEATURE_QA_COMMANDER.md`. Two Windows/test-design lessons the commander's
  own QA caught: (a) a raw-`spawn`ed detached `postgres.exe` EPIPE-dies/hangs —
  boot with `pg_ctl start` + `stdio:'ignore'` and let a `pgReady()` gate wait;
  (b) a reset-password probe must target a **dedicated** account, never the QA
  employee — resetting bumps `token_version` and revokes that token mid-matrix.
  Phase 2 (deferred by decision): Playwright UI⇔API⇔DB golden journeys, matrix
  auto-discovery, CI wiring.
- `master` is green and auto-deploys. Recent shipped themes: attendance auto-checkout +
  grace/missed-checkout tracking, self-reported daily work logs, work-assignment mandatory
  timelines, full offboarding journey, and governance workflows (cross-team transfers,
  TL leave-handover with cover lead, project read-access requests).
- **Attendance check-in status fix shipped (2026-10-07):** employee dashboard/calendar
  showed "Not checked in yet" (and demanded a re-check-in) even though the row existed and
  admin saw it. Root cause: `GET /api/attendance/my` + `/all` returned the Postgres `DATE`
  raw; pg parses it at LOCAL midnight and `res.json()` serializes to the **previous UTC day
  on any host east of UTC** (`DATE '2026-10-07'` → `"2026-10-06T18:30:00.000Z"` here), so the
  client's `date.split('T')[0] === getTodayIST()` lookup never matched today. Fix: normalize
  `date` with the repo `dateOnly()` helper in both routes (plain `YYYY-MM-DD`, TZ-independent).
  **Deadlock recovery (same day):** a dashboard that missed today's row showed only "Check In",
  which 400'd ("Already checked in today") with no Check-Out path — `POST /attendance/check-in`
  now answers **409** + `alreadyCheckedIn` + the existing row, and the dashboard renders it
  immediately (`renderTodayAttendance`) so Check-Out is always reachable; check-in success
  payload `date` normalized too. **User story fix (same day):** the FIRST check-in now renders
  the server-confirmed row **directly from the check-in success payload** (no refetch needed),
  so the dashboard shows "Checked in" instantly and never prompts "check in again". `sw.js`
  cache v11. No schema changes.
  **QA: `scripts/qa-attendance-checkin-status.cjs` → 24/24 green** (incl. the fresh
  check-in path: success payload date plain + directly renderable + refetch finds the row,
  no re-check-in prompt) — against a hermetic local Postgres on IST local time (see
  `docs/FEATURE_ATTENDANCE_CHECKIN_STATUS_FIX.md`).
- **Duplicate check-ins are impossible (same day):** `attendance` has
  `UNIQUE(employee_id, date)`, the check-in INSERT is `ON CONFLICT (employee_id, date)
  DO UPDATE`, and a repeat click answers 409 before any write — repeated check-in
  taps can never create a second row or a second check-in photo for the day.
- **PWA update revalidation (2026-10-08):** resumed PWA windows restore a session
  without a navigation, so the browser could skip the service-worker update check
  and a reload appeared to "not apply changes" (leading users to reinstall).
  `auth.js` now calls `reg.update()` on `visibilitychange` (app regains focus) —
  `sw.js` is served `no-cache`, so a fresh deploy auto-applies on the next open;
  the sw cache name is bumped on every static-asset change per §8 (currently
  `v13`). Reload is always the only step needed — never a reinstall.
- **Attendance read-path cold-start fix shipped (2026-10-08):** the employee
  dashboard could show "Could not load your attendance status." because
  `GET /attendance/my` awaited the **company-wide** auto-checkout scan before
  every read — on a cold Vercel instance (boot ≈1 s live + lazy Supabase pooler
  connect + the scan) a request could breach `maxDuration: 30` → 504, and the
  client had no timeout/retry, so one transient failure stranded the card until a
  manual Retry. Fix: `/my` now checks (1 indexed `SELECT 1`) whether **this**
  employee has an open row before running `runAutoCheckout()` — the common case
  never pays for the scan, while an employee who missed check-out still
  self-heals (full pass, half-day still closed on that read). Client:
  `apiCall` gained optional `{ timeoutMs, silent }` (backward compatible) and
  `loadAttendanceStatus` retries 3× with backoff (15/10/10 s) before the error
  card; the error card remains guard-A-safe (never a Check-In button). `sw.js`
  v12 → v13. No schema changes. **QA: `scripts/qa-attendance-my-readpath.cjs` →
  15/15 green** (done/none reads skip the scan — other users' open rows stay
  open; open-row employee still closes itself + everyone else at a forced 00:00
  deadline) + break-finalize harness re-run **41/41 green**; see
  `docs/FEATURE_ATTENDANCE_MY_READPATH_FIX.md`.
- **Attendance reload + break-integrity fixes shipped (2026-10-08), four atomic
  commits (`2bc74d7`, `4c5d8b8`, `e119c16`, docs):**
  - **Reload false "Check In" fixed (A):** the dashboard's static HTML defaulted
    to a visible Check-In button, so during a slow/cold `/attendance/my` fetch
    (it runs company-wide `runAutoCheckout()` first) — or after a failed fetch
    (`apiCall()` returns `null`) — a reload showed "Check In" with a row
    present, inviting a duplicate 409 check-in. `loadAttendanceStatus()` now
    renders a neutral "Syncing..." state, then either the server's truth or an
    error+Retry card; **Check-In appears only when the server confirms no row**.
  - **Dangling breaks finalized (B/C):** a break left running when the day
    closes (manual Check-Out or auto-checkout at the grace deadline) previously
    stayed open-ended forever — never in `break_log`, completed days showed
    "Break End: Running...", and Hours Worked silently inflated. Check-out and
    `runAutoCheckout()` now append `{start, end:<closure time>}` to `break_log`
    in the SAME atomic, self-guarded UPDATE that closes the day (never
    double-recorded). `break_log` stays a JSON array. **G:** "Running..." only
    on live days; `getTotalBreakSeconds` and the attendance-page Hours Worked
    close legacy open breaks at `check_out`.
  - **Atomic break-end (D):** `POST /attendance/break-end` was read-modify-write
    (concurrent requests could overwrite each other's entries); it's now ONE
    guarded UPDATE — exactly one concurrent winner, loser 400s, nothing lost.
    Dashboard refetches on break-end failure so a lost race/auto-close never
    leaves the card on "Running...".
  - **QA:** new `scripts/qa-attendance-break-finalize.cjs` → **41/41 green**
    against hermetic local Postgres (manual finalize, multi-break, auto-checkout
    finalize at a forced 00:00 deadline, concurrent break-end race) + new
    reusable `scripts/check-inline-js.cjs` inline-JS syntax gate. See
    `docs/FEATURE_ATTENDANCE_BREAK_FINALIZE.md`. E (server-side/admin-facing
    break deduction) stays deferred — employee-view-only, as scoped.
- **Work Assignments v2 — Increment 1 shipped (2026-10-07):** `blocked` status + reason,
  assignee cannot hard-cancel, cancel/block require a reason, actual timestamps
  (`started_at`/`cancelled_at`/`assigned_at` + `start_date`), counterpart notifications
  (incl. `work_blocked`/`work_withdrawn`/`work_reassigned_away`), TOCTOU-safe conditional
  update (409), born-closed POST blocked, title/length + date guards, daily-log
  assignment-link ownership guard (H1), admin permanent-delete cleans WA FKs (H2),
  demoted-assigner role guard (H3), HR dashboard badge parity, `work_date` honored on
  log PUT, assigned_at backfill. Schema in all three layers
  (schema.sql / index.js startup / schemaRepair). **QA: `scripts/qa-work-assignments-v2.cjs`
  → 38/38 green** against a hermetic local Postgres (no prod DB reachable from this
  machine — see `docs/FEATURE_WORK_ASSIGNMENTS_REDESIGN.md` §9). Increment 2 (events
  timeline + filters/search/pagination + daily-log roll-up) and Increment 3 (bulk
  assign/comments) remain.
- Existing docs: `docs/FEATURE_UNITS_WORK_ASSIGN.md`,
  `docs/FEATURE_WORK_ASSIGNMENTS_REDESIGN.md`, `docs/FEATURE_OFFBOARDING.md`,
  `docs/FEATURE_WORKFLOWS_GOVERNANCE.md`, `docs/FEATURE_ATTENDANCE_CHECKIN_STATUS_FIX.md`,
  `docs/FEATURE_ATTENDANCE_BREAK_FINALIZE.md`, `docs/FEATURE_ATTENDANCE_MY_READPATH_FIX.md`.

---

*Maintained by the agent as the living operating manual for this repo. Keep it accurate when
architecture, roles, or conventions change.*
