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
  `v11`). Reload is always the only step needed — never a reinstall.
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
  `docs/FEATURE_WORKFLOWS_GOVERNANCE.md`, `docs/FEATURE_ATTENDANCE_CHECKIN_STATUS_FIX.md`.

---

*Maintained by the agent as the living operating manual for this repo. Keep it accurate when
architecture, roles, or conventions change.*
