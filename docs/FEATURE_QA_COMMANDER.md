# FEATURE — HRMS QA Commander (agentic QA orchestrator, v1)

Shipped: 2026-10-08 · `scripts/qa-commander.cjs` + `qa/rbac-matrix.json` + docs in
one atomic commit. Zero new dependencies (uses `bcryptjs`, `pg`, global `fetch`,
and the existing harnesses).

## 1. What it is

A single command that turns the repo's existing hermetic QA harnesses + the
declared RBAC expectation matrix into one regression pass with a unified report:

```
node scripts/qa-commander.cjs                 # full hermetic self-check
node scripts/qa-commander.cjs --target=live   # live smoke (+ role probes w/ creds)
npm run qa                                    # same as the first
```

It is the orchestration layer of the repo's QA story:

```
                 HRMS QA Commander
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
   Discovery        Regression        RBAC Matrix
 (manifest.json)   (4 .cjs harnesses)  (34 rows × roles)
        │                │                │
        └────────────────┼────────────────┘
                         ▼
                  DB invariant scan
                         ▼
                  unified report (PASS/FAIL + exit code)
                         │
                         ▼
              optional: gh issue filing (--issues)
```

## 2. Why it exists

- The repo already had **5 hermetic harnesses**, explicit **role guards**
  (`verifyToken`, `isAdmin`, `isAdminOrHr`, `isManager`, `blockAdminSelfService`),
  and a working hermetic-Postgres QA recipe — but no orchestrator: every run was
  manual, and the guards were only ever exercised *by accident*, never probed as a
  systematic matrix.
- The de-facto regression suite needed 4+ server restarts (the login rate limiter
  is a per-process 10/15-min bucket; the suite needs ~20 logins), which the
  commander now handles automatically.

## 3. Stages

### discover
Reads `server/index.js` route mounts, `server/middleware/auth.js` exports, and
`public/pages/*` portals → writes `qa/manifest.json` (gitignored, regenerated).
The machine-readable map of the API surface.

### regression
Runs each `scripts/qa-*.cjs` harness as a child process, captures its
`N passed, M failed` summary, and **restarts the app server between harnesses**
so the in-memory login limiter never 429s the suite. Exit nonzero + a failing
harness = regression FAIL.

### rbac
- Seeds a throwaway role world (`admin`, `hr`, `manager`, `team_lead`,
  `employee` + a dedicated `permEmp` for the permanent-delete row) directly in the
  (hermetic) DB with bcrypt hashes.
- Logs in each role via the real `/api/auth/login`, then fires every cell of
  `qa/rbac-matrix.json` (34 rows: employees, attendance, payroll, leave, manager
  surface, notifications, projects, settings, audit, regularisation,
  announcements, designations/departments/holidays, documents, onboarding,
  profile-updates …).
- Cell semantics: `403` = exact forbidden status (the **"UI hides it but the API
  accepts it"** detector — a guard that returns anything else for a forbidden role
  fails); `"allow"` = authorized call must not return 401/403/404/5xx (a 500 or a
  misplaced 403 is caught too); absent cell = not asserted (scope-dependent rows
  where a downstream team-tree 403 is legitimate — only the employee-forbidden
  cell is meaningful there).
- Also runs a **no-token 401 sweep** (protected endpoints must answer 401, never
  200/5xx).
- Probes discovered during authoring are annotated in the matrix where intent is
  verified, e.g. `notifications/counts` employee→403 is *by design*
  (`dashboard.js` routes employees to `/announcements/unread-count` +
  `/notifications/unread-count`), and attendance `check-in` blocks admin with 400
  inside the route (a convention divergence from `blockAdminSelfService`'s 403,
  noted for a future consistency pass).
- Cleans the world up and proves **zero QA leftovers**.

### db (WARN-only)
Scans for leftover `qa%` employees / attendance / notifications rows. Reported but
never fails the run (avoids false reds from old manual runs; tighten later).

## 4. Targets

### hermetic (default)
Boots its **own** throwaway PostgreSQL 16 cluster (port 5433) + app server
(port 3000) when free, loads `server/schema.sql` (comment-stripped), runs the
stages, then tears the whole stack down. **Safety:** refuses to boot or seed if
`DATABASE_URL` is not a QA-5433 URL, and refuses to touch a foreign Postgres
already on 5433 — hermetic mode can never write to any other database. If 5433
and 3000 are already up, the running stack is reused and not torn down
(`--no-teardown` keeps a self-managed stack alive for debugging).

### live
Probes the deployed API (`QA_BASE_URL` or `https://garchitects-hrms.vercel.app`):
a 401 sweep on protected endpoints (guard leak detector) + 200 sweep on shell
assets. With `QA_LIVE_ADMIN_ID` / `QA_LIVE_ADMIN_PW` set, additionally seeds the
full role world through the live admin API, runs the whole matrix, and cleans up
(writes throwaway rows to the live DB — explicit opt-in only).

## 5. Report

Console table with `✔/✖` per check, `PASSED/FAILED` totals, exit code 0/1, and an
optional `--json=<path>` machine-readable report (also `npm run qa:json` →
`qa/report.json`, gitignored). `--issues` files a GitHub issue per FAILED item via
`gh` (manual opt-in; never automatic).

## 6. Verification record

### Live smoke (deployed Vercel, 2026-10-08)
`node scripts/qa-commander.cjs --target=live` → **12/12 green**:
discover (35 modules / 7 guards / portals, manifest written); 401 sweep good on
`/attendance/my`, `/leave/apply`, `/payroll/all`, `/employees`, `/audit-logs`;
200 on `/`, `/js/auth.js`, `/sw.js`, `/pages/employee/dashboard.html`. Role
probes skipped (no `QA_LIVE_ADMIN_*` creds) as designed.

### Hermetic self-check (2026-10-09)

`node scripts/qa-commander.cjs` (hermetic, own PG cluster + server) → **55/55 green,
exit 0**:

- discover: manifest written (35 modules / 7 guards / portals).
- regression: check-in status **24/24**, break finalize **41/41**, my read-path
  **15/15**, work assignments v2 **38/38**, fix-sprint audit batch **57/57** —
  with a fresh server (login-limiter reset) between each.
- rbac: 5/5 role logins; no-token sweep 4/4; **37 matrix rows / 175 cell probes
  all green** (increments: `regularize-review`, `wfh-apply`, `att-photo` from
  the fix batch); `db:permEmp-deleted` confirms the permanent-delete row actually
  removed the QA row; cleanup leaves **0 leftover rows**.
- db: 3 WARN-only scans, 0 leftovers.

**Bugs the commander's own QA caught and fixed during delivery:**

1. *Windows postgres flake* — a Node-`spawn`ed `postgres.exe` with piped stdio got
   EPIPE-terminated mid-run (harnesses crashed with `ECONNREFUSED 5433`). Fixed by
   `pg_ctl start` with **`stdio: 'ignore'`** + file-logged server spawn. The same
   panic also explained a 30 s hang: `execFileSync` waits on the stdio pipe for
   EOF, and a detached postmaster inherits the write handle — `stdio: 'ignore'`
   removes the pipe entirely (readiness is gated by `pgReady()`).
2. *token_version cascade* — the `emp-resetpwd` matrix row originally targeted the
   QA `employee` account, so HR's own authorized probe bumped `token_version` and
   revoked the employee token mid-matrix (every subsequent employee cell → 401).
   Fixed with a dedicated `targetEmp` account for `{qaEmpId}` rows.
3. *Teardown crash* — idle pg-pool clients emit an unhandled `error` when the
   postmaster dies; pool now has an error listener and is closed before PG stops.

### Syntax gates
`node --check scripts/qa-commander.cjs` green; `qa/rbac-matrix.json` parses with
34 rows + 4 no-token probes.

## 7. Blast radius
- New files only: `scripts/qa-commander.cjs`, `qa/rbac-matrix.json`; generated
  `qa/manifest.json` / `qa/report*.json` are gitignored. `package.json` adds
  `qa` / `qa:live` / `qa:json` scripts (no deps added). No server, route, schema,
  or frontend change — the commander is a test-side orchestrator.
- Existing harnesses untouched; they are run unchanged as children.
- `--issues` uses the local `gh` CLI (present on this machine); absent `gh` is
  reported, never fatal.

## 8. Phase 2 (deferred by decision)
- **Playwright golden journeys** (login → check-in/out, leave apply→approve,
  verifying UI ⇔ API ⇔ DB agreement) — new dev dependency, next phase.
- Endpoint/guard **auto-discovery** for matrix cells (v1 uses the declared,
  version-controlled matrix).
- Optional CI wiring (non-blocking sidecar job in a new workflow, then gating) —
  deliberately not in v1 until the suite is stable across several runs.
- Per-module **DB invariants** (leave balance after approval, break_log →
  hours-worked → payroll derivation) as the user's §5 describes.