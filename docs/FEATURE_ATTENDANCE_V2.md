# Attendance v2 — Late/Early Justifications, Break Camera Tracking & Report (2026-11-04)

**Status:** shipped (branch `feat/attendance-v2`, commits `85a20cb` + `32a8ca1`, pushed to `master`).
**Trigger:** founder request — read + implement the following four items end-to-end.

## What shipped

### Phase 1 — Salary basis (payroll)
- `computeAttendanceSummary()` now returns **`working_days` = the calendar working days** of the
  month (week offs + declared holidays excluded). Per-day divisor on the payslip is that number
  (e.g. 31-day month with 4 Sundays + 2 holidays → `total_days: 31`, `working_days: 25`). The old
  "calendar total days as divisor" behavior is replaced.
- Mid-month joiners keep the `effStart` classification window (unpaid days before joining = LOP),
  fully compatible with the fixed working-day basis.
- `sandwich_leave_days` is now passed to `computeTotals`, and the attendance-validity gate allows
  it (sandwich leave can exceed a working-day identity) so valid payslips are no longer rejected
  (false 400 "Attendance calculation is incorrect").
- UI (`payroll-generate.html`) derivation text, PDF "Working Days" label, and the client mirror
  (`payroll-core.js`) all updated to the working-day basis.
- **No backfill** — already-processed payslip rows are untouched; this governs runs from the
  next payroll execution.

### Phase 2 — Late check-in → reason → TL/Manager review
- `attendance_justifications` table (3 schema layers + `schemaRepair` self-heal): one row per
  (attendance, kind); kind ∈ `late` | `early_checkout`; status `pending|approved|rejected`;
  `UNIQUE (attendance_id, kind)`; re-filing overwrites with `ON CONFLICT DO UPDATE`.
- Check-in past office start + grace (live: **10:00 + 15 min**) still returns `status: 'late'`,
  and now also returns `requiresReason: true` when so.
- **Check-out is blocked** (`400 requiresLateReason: true`) until the employee files a reason;
  any reason with ≥ 5 chars is accepted and stored pending review.
- The dashboard pops a mandatory reason modal right after a late check-in and re-opens it from the
  today-status banner until a reason exists.
- Review queues: `GET /api/attendance/justifications` (admin/hr company-wide; TL/Manager scoped
  to their tree) and `POST /api/attendance/justifications/:id/review` (approve → day counts
  `present`; reject + `late` → day counts `absent`; reject + `early_checkout` → stays
  `half-day`). TOCTOU-safe conditional update → concurrent double-review returns 409.
- Surfaces on admin/attendance.html ("Pending Attendance Reasons", company-wide) and on
  manager/my-team.html ("Attendance Reasons" tab, tree-scoped, badge).

### Phase 3 — Early checkout & missed checkout
- Early checkout (before `office_end_time`, live **18:30**): checkout is blocked until a reason is
  filed (`400 requiresEarlyReason: true`); with no manager approval, the day is downgraded to
  **half-day** at checkout time. Reason approval via the same justification review flow →
  day counts `present`.
- Missed checkout (auto-checkout at `office_end_time` + `checkout_grace_minutes`, live **120**):
  existing rule kept — **first miss = warning; second miss in a calendar month = half-day**,
  then a warning email goes to admin/HR and the day-marking notifies the employee.
- Check-in is blocked for admin accounts as before; checkout photo must exist as before
  (photo enforced) — reason modal reuses the same flow.

### Phase 4 — Break camera tracking + report
- Break **out** and **in** now require a camera selfie, parity with check-in/out. Photos are
  stored in `attendance_photos` (`type` check widened to `'check_in' | 'check_out' | 'break_out' | 'break_in'`;
  startup migration drops + re-adds the check constraint). Break end pairs the latest outstanding
  `break_out` photo into the `break_log` entry (`{ start, end, out_photo, in_photo }`), so the
  admin view can always correlate out/in frames.
- **Report button** on the employee dashboard (always visible): anyone — employee, TL, manager,
  HR — can report an unauthorized break on any colleague with a ≥ 5-char note. Self-report
  refused; inactive employees refused.
- `break_reports` table (3 layers + self-heal), `POST /api/attendance/break-report` notifies
  admins (log + alert). `GET /api/attendance/break-reports` — admin/hr company-wide; TL/Manager
  their tree. `PUT /:id/review` — admin/hr only, marks reviewed (admin note; no automatic penalty;
  reporter gets a confirmation notification).
- Admin surface on admin/attendance.html: "Break Reports" card with a review modal.

### Phase 5 — Release hygiene
- `sw.js` bumped to **v18**; inline-JS gate passes on all three changed pages; boot smoke OK.
- Docs: this file + `AGENTS.md` §11.

## Verification
- Live GETs (admin session): `/api/attendance/justifications` → 200 `{success:true, justifications:[]}`;
  `/api/attendance/break-reports` → 200 `{success:true, reports:[]}`;
  `/api/attendance/my` → 200; `/api/payroll/attendance-summary?employee_id=1&month=10&year=2026`
  → **200 `{"working_days":25, ...}`** (31 − 4 Sundays − 2 holidays); regression `/api/projects`
  200, `/api/announcements` 200; unauth → 401; bogus params → 400.
- Static pages `/admin/attendance`, `/manager/my-team`, `/employee/dashboard`, `/sw.js` → 200;
  login page console clean under CSP.
- `node --check` on all changed server files OK; boot smoke against an unreachable DB OK (no
  require-time errors).

## Not verified / caveats
- **No live writes were performed** (would have notified real employees). Every new write path
  (break report, justification filing, review approve/reject, early-checkout downgrade, cron
  `sweep-late`) is code-reviewed and boot-tested, not execution-tested; hermetic PG is not
  available on this machine.
- The break-out/in camera flow is wired end-to-end but the camera UX was not exercised behind
  real camera permissions on this session (backend fully exercised by code review + boot smoke).
- `sweep-late` cron entry added to `vercel.json` but the first live run lands tonight 21:30 IST
  (iterate on failures, if any, after observing).
- Late reason modal uses the same camera-free UX as the check-out reason gate; the `requiresReason`
  flag gates the checkout button client-side and the server enforces regardless of UI state.
