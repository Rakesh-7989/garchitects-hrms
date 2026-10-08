# FEATURE — Attendance reload state, dangling-break finalization & atomic break-end

Shipped: 2026-10-08 · Four focused commits (A → B/C+G → D → docs), each with
its own QA, one per SDLC pass:

| Commit | Scope |
|--------|-------|
| `2bc74d7` | A — reload no longer shows a false "Check In" (three-state card) |
| `4c5d8b8` | B/C + G — dangling breaks finalized at check-out & auto-checkout; "Running..." + Hours Worked render fixes |
| `e119c16` | D — break-end is atomic (concurrent requests never lose an entry) |
| (this)   | docs + AGENTS.md |

## 1. Reported problem

On a page reload the employee dashboard showed **"Check In" again** even though
the employee was already checked in, and pressing it 409'd. Reloads after a
brand-new check-in also re-prompted a check-in.

## 2. Root cause of the reload bug (verified)

The static HTML defaults to the Check-In button visible; `loadAttendanceStatus()`
was the ONLY thing that replaced it with the real state:

- `/api/attendance/my` runs company-wide `runAutoCheckout()` before reading, so
  a cold Vercel instance can take seconds. During that window the wrong state
  ("Check In") was on screen.
- If the fetch failed, `apiCall()` returned `null` and nothing rendered — the
  **default** Check-In button stayed visible forever with a row present.
- HTTP caching was ruled out: live header check of `/api/attendance/my` shows
  `Cache-Control: public, max-age=0, must-revalidate` + content ETag,
  `X-Vercel-Cache: MISS`.

So the bug was a **client render-state gap**, not logic: the fixed assumption
was that the default HTML button would be replaced by data; when the fetch was
slow or absent, a false action was shown.

## 3. Fix A — three-state attendance card (dashboard.html)

`loadAttendanceStatus()` now renders one of three states and **never shows
Check-In until the server actually confirms no row for today**:

1. `setAttendanceLoading()` — first load / after an action resets the card to a
   neutral "Syncing attendance status..." (all buttons hidden).
2. The resolved render (`renderTodayAttendance`) — the server's truth.
3. `setAttendanceError()` — fetch failed and nothing rendered yet: an error
   message + Retry button (never Check-In).

If a row was already rendered and a later refetch fails, the current render is
kept (no degrade to Check-In). `apiCall` still returns `null` on network error;
the card now degrades to error/retry instead of the misleading default.

## 4. Fix B/C — dangling breaks are finalized when the day closes

**Story:** an employee starts a break and never ends it, then the day closes —
manually ("Check Out") or via auto-checkout at the grace deadline. Pre-fix the
server closed the day but left `break_start` set forever: the break never
landed in `break_log`, a COMPLETED day showed "Break End: Running...", and
"Hours Worked" on the attendance page silently inflated (open breaks were not
subtracted there).

**Fix (server):**

- `POST /api/attendance/check-out` and `runAutoCheckout()` now finalize a
  running break into `break_log` as `{ start, end }` in the **SAME atomic
  UPDATE** that closes the day (`end` = check-out time / deadline time).
- The append is self-guarded — it only fires while `break_start IS NOT NULL
  AND break_end IS NULL` at UPDATE time — so a break ended concurrently is
  never double-recorded.
- `break_log` stays a JSON **array**: the empty/NULL branch wraps the new
  entry in brackets, the append branch splices before the closing bracket.
- Params are passed strictly matching the placeholders (node-postgres errors
  on unused trailing params: `bind message supplies N parameters, but prepared
  statement requires M` — caught during QA and fixed).

**Fix (UI):**

- Dashboard: "Running..." only on **live** days (`!row.check_out`); completed
  days show the real total from `break_log`.
- Dashboard `getTotalBreakSeconds()`: a legacy dangling break on a completed
  day is counted up to `check_out` (was: up to `now`, inflating the ticker).
- Employee attendance page "Hours Worked": subtracts a legacy open break up to
  `check_out` on completed days.

## 5. Fix D — atomic break-end

The old break-end was read-log → push → overwrite-write: two concurrent
requests (double-tap, or racing an auto-checkout) could silently overwrite
each other's entries.

`POST /api/attendance/break-end` is now **one guarded UPDATE**: the new entry
is appended in SQL (self-guarded CASE; array stays a JSON array) and the WHERE
guard (`check_out IS NULL AND break_start IS NOT NULL AND break_end IS NULL`)
means exactly one concurrent request wins; the loser answers `400 Break already
ended` (message re-used for the lost race; day-closed races hit the same path).
The dashboard break-end failure branch now refetches, so a lost race or a day
auto-closed mid-break never leaves the card stuck on "Running...".

## 6. Verification

### QA harness — `scripts/qa-attendance-break-finalize.cjs` → **41/41 green**

Hermetic local Postgres 16 on port 5433 (per the repo QA recipe; this machine
is IST-prone so all date handling is timezone-independent), 4 logins per run —
**restart the server between reruns** (login limiter is in-memory, 10/15 min).

Groups:

1. **Manual finalize (fin):** check-in → break-start → check-out. Asserts the
   response row and `GET /attendance/my` show `break_start`/`break_end` NULL,
   `break_log` length 1, and the entry's `end` equals the check-out time.
2. **Multi-break (multi):** two full break cycles → `break_log` length 2, both
   with start/end; check-out appends nothing extra.
3. **Auto-checkout (auto):** settings pinned to a 00:00 deadline
   (`office_end_time=00:00`, `checkout_grace_minutes=0`) so `runAutoCheckout`
   always fires; seeded open row with `break_start='13:00'` → auto-closed at
   `00:00:00`, `auto_checkout=true`, break finalized `{start:13:00:00,
   end:00:00:00}`.
4. **Atomic break-end race (race):** break #1 ended normally; break #2 ended
   by **two concurrent** break-end requests → exactly one 200 + one 400,
   `break_log` keeps **both** entries (nothing lost), `break_start` cleared,
   check-out appends nothing extra.

During QA a harness-settings bug was caught (the auto group left the deadline
at 00:00, so `runAutoCheckout` auto-closed the race group's row mid-flow — the
race assertions passed because of that, proving the finalize path also worked
end-to-end; the harness now restores manual-safe settings between groups).

### Syntax gates

`node --check` on both server files; `scripts/check-inline-js.cjs` (new, added
with fix A) on `dashboard.html` / `attendance.html` — all green.

## 7. Files touched

- `public/pages/employee/dashboard.html` — three-state card, "Running..." guard,
  `getTotalBreakSeconds` check-out closes, break-end reconcile refetch
- `public/pages/employee/attendance.html` — Hours Worked open-break subtraction
- `server/routes/attendance.js` — check-out finalize + atomic break-end
- `server/services/attendanceAutoCheckout.js` — auto-checkout finalize
- `scripts/qa-attendance-break-finalize.cjs` — new QA harness (41/41)
- `scripts/check-inline-js.cjs` — inline-JS syntax gate (reusable)
- `docs/FEATURE_ATTENDANCE_BREAK_FINALIZE.md`, `AGENTS.md` §11 — this record

## 8. Out of scope (note)

- The half-day rule still counts check-in→check-out raw minutes (breaks do not
  reduce it) — unchanged product behavior.
- Server-side/admin-facing break-hour deduction ("E" from the audit) remains
  employee-view-only; can be revisited if the founder wants admin-visible net
  hours.