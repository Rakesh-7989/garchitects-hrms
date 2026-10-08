# FEATURE — Attendance read-path cold-start fix ("Could not load your attendance status.")

Shipped: 2026-10-08 · Server + client + QA harness + docs in one atomic commit.

## 1. Reported bug

An employee reloads the dashboard and instead of their attendance status sees the
card:

> **Could not load your attendance status.**  [Retry]

("employee dashboard lo ela vachindi endhuku vachindi ani check chesi resolve cheyi.")

The card itself is not a regression — it is the honest fallback added by the
reload-state fix (fix A / `2bc74d7`) that replaced the old silent, wrong "Check In"
default. The real problem is **why the status fetch failed at all**: nothing
recovered automatically, so any single transient failure stranded the card until a
manual Retry.

## 2. Root cause (verified)

Two compounding defects:

### Server — `/attendance/my` serializes the company-wide auto-checkout scan
`GET /api/attendance/my` ran `await runAutoCheckout()` **on every read** (for every
non-admin) before selecting the employee's rows:

```js
// server/routes/attendance.js (before)
if (req.user.role !== 'admin') { await runAutoCheckout().catch(() => {}); }
```

`runAutoCheckout()` is a company-wide pass: 2 settings queries + an open-row scan
over **all** employees + per-open-row `COUNT`/`UPDATE`/`notify()`. On a cold Vercel
instance the request already pays the find-and-boot cost of the function's heavy
require chain (supabase-js, pdfkit, exceljs, web-push, …) plus the lazy Supabase
pooler connect (`connectionTimeoutMillis: 10000`); serializing the scan on top can
breach the function's `maxDuration: 30` → Vercel answers `504` (an HTML error page,
or a `5xx` JSON) → `apiCall()` returns `{ success:false, … }` → the error card.

Measured live (this fix's evidence):
- cold function boot (401 probe) ≈ **0.99 s**, warm ≈ **0.31 s** — boot alone does
  not 504; the risk is boot + pooler connect + the awaited scan, all unbounded by
  company size and paid on **every** employee read.
- workers only ever *see* this on a cold/late-heavy instance, because on a warm
  instance the scan itself is milliseconds.

### Client — no timeout, no retry, one failure sticks
`apiCall()` has no `AbortController` timeout and `loadAttendanceStatus()` made a
single attempt. One cold-start 504, one flaky network blip, one DB hiccup → the
error card stays until the user presses Retry (or reloads and gets lucky).

## 3. Fix (additive, no schema/migration)

### Server — guard the company-wide scan behind a per-employee open-row check
`server/routes/attendance.js`, `GET /api/attendance/my`:

```js
if (req.user.role !== 'admin') {
    const openToday = await query(
        'SELECT 1 FROM attendance WHERE employee_id = $1 AND date = $2 AND check_out IS NULL',
        [req.user.id, istDateString()]
    ).catch(() => ({ rows: [] }));
    if (openToday.rows.length > 0) { await runAutoCheckout().catch(() => {}); }
}
```

- **Common case** (already checked out / never checked in): one indexed `SELECT 1`
  → no open row → the company-wide scan never runs → the read is O(1) and cannot
  blow the 30 s budget on that path. This is the fix for the reported card.
- **Self-heal preserved exactly**: an employee who *does* still have an open row
  (missed check-out) still triggers the full `runAutoCheckout()` pass — closing
  their row and everyone else's past the deadline — so the half-day visibility the
  lazy self-heal exists to provide is unchanged.
- Admins already skip the scan (unchanged).

### Client — bounded timeout + retry with backoff, error card is the last resort
- `public/js/auth.js` — `apiCall(endpoint, method, body, opts)` gains two optional,
  backward-compatible options: `timeoutMs` (AbortController-based, aborts the
  fetch) and `silent` (suppresses the network-failure toast + console.error so a
  retry loop doesn't spam toasts).
- `public/pages/employee/dashboard.html` — `loadAttendanceStatus()` now makes up to
  **3 attempts** (timeouts `15000/10000/10000` ms, backoff `1 s/2 s`) before falling
  back; the error + Retry card shows only when every attempt fails. The guard from
  fix A still holds: the card is never a Check-In button, and a refetch failure
  after a row was already rendered keeps the current render.

### PWA
`public/sw.js` cache name `v12 → v13` (static assets changed — §8).

## 4. Verification record

### Environment (honesty note)
Hermetic throwaway local PostgreSQL 16 cluster (initdb `-U postgres --auth=trust
-E UTF8 --locale=C`, port 5433, matching `.env` `DATABASE_URL`), schema from
`server/schema.sql` (comment lines stripped), app via `npm start`. Host TZ = IST.
No remote/prod Postgres is reachable from this machine.

### Green evidence (post-fix)
`scripts/qa-attendance-my-readpath.cjs` (throwaway `done`/`openA`/`openB`/`none`
employees, 4 logins, deadline forced to `00:00` so `runAutoCheckout()` always fires
when invoked) — **15/15 green**:

- logins all succeed;
- **`done` (completed day) `GET /my`** → 200 success, their row returned untouched
  (`check_out 18:30:00`), and the **company-wide scan did NOT run**: `openA` and
  `openB` open rows are still `check_out IS NULL` after `done`'s read;
- **`none` (no row) `GET /my`** → 200 success with no today row, and `openA`/`openB`
  still open — second proof the scan is skipped for employees without an open row;
- **`openA` (open row) `GET /my`** → still self-heals exactly as before: its row
  closes at the forced deadline (`check_out 00:00:00`, `auto_checkout true`) **and**
  the full pass closes `openB` too — the O(1) guard never degrades the self-heal;
- cleanup verified — DB left pristine (0 QA employees, settings restored).

Run: `node scripts/qa-attendance-my-readpath.cjs` (start `npm start` first; 4
logins/run, the login limiter allows 10 per 15 min per IP — restart the server
before a rerun).

**Regression:** `scripts/qa-attendance-break-finalize.cjs` re-run against the same
build → **41/41 green** (the `/my` guard interacts correctly with the break
finalize + auto-checkout harness, including the auto group whose `/my` still
triggers the pass).

**Syntax gates:** `node --check server/routes/attendance.js`, `node --check
public/js/auth.js`, `node --check scripts/qa-attendance-my-readpath.cjs`,
`node scripts/check-inline-js.cjs public/js/auth.js public/pages/employee/dashboard.html`
→ all green.

### Client (UI-only) coverage
The retry/timeout logic is browser-only and not deterministically exercisable by a
Node harness; it is covered by the inline-JS syntax gate, close code review, and a
post-deploy live check that the new markers ship in the served `dashboard.html` /
`auth.js` (see AGENTS.md §11 for the live-verification note).

## 5. Blast radius
- Changed: `GET /api/attendance/my` now skips `runAutoCheckout()` unless the
  requester has an open row today (behavior otherwise identical — self-heal runs
  for exactly the employees who need it); `apiCall()` signature extended with
  optional `{ timeoutMs, silent }` (no existing callers change; 4th arg is new);
  employee dashboard status load retries 3× with backoff before the error card.
- Consumers (verified compatible): every other `apiCall()` call site (no 4th arg →
  prior behavior: no timeout, toasts on network error), admin/manager attendance
  routes (unaffected — they do not use `/my`), the break-finalize harness.
- Unchanged: schema, migrations, other routes, `/api/cron/auto-checkout` (still the
  daily company-wide pass), notification logic, `sw.js` only version-bumped.