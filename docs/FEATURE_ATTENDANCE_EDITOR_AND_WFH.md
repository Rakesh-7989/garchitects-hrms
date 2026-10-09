# Feature — Attendance day-detail, WFH rendering & staff day editor

**Shipped:** 2026-10-09 · **Owner:** agent · **Status:** shipped + hermetic-verified

This batch closes three long-standing gaps in the attendance workflow so it
matches the desired model: **check-in with office-time + grace**, an
**employee-facing day-detail popup** (calendar + history), and **staff
editing** of a single attendance day (admin/HR company-wide, manager scoped).

---

## 1. What was wrong

| # | Symptom | Root cause |
|---|---------|-----------|
| B | An approved **Work-From-Home day counted as Absent** on the employee page (calendar + counters) and showed a raw `wfh` / `?` on admin surfaces. | `wfh` status had no branch in the employee day classifier or the shared badge helpers; it fell through to the absent tally. Admin matrix had no `wfh` label/class/count either. |
| A | An employee could see a day in the calendar/list but **could not open that day** to inspect check-in, check-out, hours, break, location, leave/WFH/holiday kind, or the auto-checkout flag. | No day-detail surface existed; cells/rows were inert. |
| C | An admin/HR/manager had **no way to correct a single attendance day** (status + times + remarks). Only coarse "mark present / mark absent" existed. | No server endpoint and no UI editor. |

**WFH policy (unchanged, now rendered correctly):** WFH is a **working day** —
it is present-like, never absent. An approved WFH request writes an
`attendance` row with `status='wfh'` (`server/routes/wfh.js`).

---

## 2. Changes

### 2.1 Employee attendance page (`public/pages/employee/attendance.html`)

- **Day-detail popup** — clicking any calendar cell or any history row opens
  `#dayDetailModal` for exactly that date: **Status**, **Check In / Check Out**,
  **Hours Worked** (live `~`-prefixed for today), **Break**, **Location** (map
  link), **Auto check-out + miss reason**, and **Regularized** flag. Days with
  no record resolve their kind: Holiday, On Leave (Paid/LOP), WFH, Week Off,
  Upcoming, or "Not checked in yet" for today.
- **WFH rendering** — `.cal-wfh` (light + dark) and a `wfh` branch; WFH days
  are counted as present and shown as "Work From Home".
- Summary line + stat cards now include a **Work From Home** card and fold WFH
  into **Total Present Days**.
- `.cal-cell.clickable` cursor/hover affordance on every clickable cell.

### 2.2 Shared client helpers (`public/js/dashboard.js`)

- `getStatusBadge()` → `wfh: 'info'`.
- `getStatusText()` → `wfh: 'Work From Home'`.
- (Used by the employee page, admin recent logs, and any consumer of the shared
  helpers.)

### 2.3 Admin attendance page (`public/pages/admin/attendance.html`)

- `.cell-wfh` (light + dark), `statusLabels.wfh`, `getStatusForDisplay('wfh')
  = 'WFH'`, a **WFH stat** tile, a legend entry, and `wf`/`grandWfh` counters.
- **Total Days** formula now includes WFH: `p + l + (h*0.5) + lv + w + hv + wf`.
- **Edit Attendance** (toolbar) and a per-row **Edit** button in *Recent Logs*
  open `#editAttendanceModal`.
- The edit modal shows the **day type context** (holiday/weekoff/leave/WFH/
  today/future), a status selector, check-in/check-out (hidden for absent/WFH),
  and remarks.

### 2.4 Manager team page (`public/pages/manager/my-team.html`)

- Team Attendance cells for **editable** members become click-to-edit and open
  `#teamAttEditModal` (same shape as the admin modal).
- `todayKey` now uses `getTodayIST()` (was UTC `toISOString()`), so "today" is
  correctly editable all day in IST.
- WFH rows already rendered as `P`; the legend now states `P=Present (incl.
  WFH)`.

### 2.5 Backend (`server/routes/attendance.js`)

Two new endpoints, both self-healing (`q = runWithSchemaRepair(...)`) and
error-hygienic (`pgErrorResponse`), audited with `logAudit`:

| Method | Route | Access | Purpose |
|--------|-------|--------|---------|
| GET  | `/api/attendance/record` | admin/HR company-wide; manager own tree | One day's record + day context for the modal |
| POST | `/api/attendance/edit`   | admin/HR company-wide; manager own tree | Single-day write |

- **Allowed statuses:** `present`, `late`, `half-day`, `absent`, `wfh`.
- **Access:** `admin`/`hr` any employee; `manager` only employees inside their
  recursive reporting tree (`myTreeIds`); `team_lead` is deliberately **excluded**
  (it keeps its existing mark-present/mark-absent power); employees are refused.
- **Validation:** real `YYYY-MM-DD`, not a future date, allowed status, `HH:MM`
  times, check-out strictly after check-in, check-in required for
  present/late/half-day, remarks ≤ 500 chars, target employee exists and is not
  an admin account.
- **Semantics:**
  - `absent` / `wfh` → clears `check_in`, `check_out`, break columns, locations
    and auto-checkout flags.
  - `present` / `late` / `half-day` → sets check-in (and optional check-out);
    **a manual check-out clears `auto_checkout`, `auto_checkout_at`,
    `checkout_miss_reason`, `checkout_miss_reason_at`** so a corrected day is no
    longer treated as an unverified machine close. Break columns are reset so
    hours are recomputed from the edited times.
- **Audit:** `attendance.edit` with `before` / `after` snapshots and
  `scope: create|update`.

### 2.6 Manager route (`server/routes/manager.js`)

- `GET /manager/attendance` now returns an `editable` flag per team member:
  `admin`/`hr` → all `true`; `manager` → `true` only for their reporting tree;
  `team_lead` → all `false`. (Additive — existing consumers unaffected.)

### 2.7 Service worker

- `public/sw.js` cache bumped `v15 → v16` (new static assets).

---

## 3. Verification

Hermetic QA adds `scripts/qa-attendance-edit.cjs` (registered in
`scripts/qa-commander.cjs`), which seeds a throwaway admin/manager/employee/
team_lead/non-report world and asserts:

- role gates: employee & team_lead `GET /record`/`POST /edit` → 403;
- scope: manager edits own report (200), non-report (403); admin edits anyone;
- validation: future date, disallowed status, missing check-in, check-out ≤
  check-in, malformed time → 400;
- semantics: manual check-out clears the auto-checkout markers; `absent`/`wfh`
  clear worked times/breaks; `/record` reflects the latest edit;
- an `attendance.edit` row lands in `audit_logs`.

Plus the existing regression harnesses via `npm run qa` (hermetic). See the
`[QA]` summary in the ship commit.

**RBAC matrix coverage.** Two rows were added to `qa/rbac-matrix.json` —
`att-record` (GET, all five roles asserted; manager tree-scoped → 403) and
`att-edit` (POST, valid `body` so the probe reaches the guard, forbidden cells
asserted — authorized cells write, so they stay covered by the dedicated
harness above). The commander's matrix probe now supports a per-row `body`
with `{qaEmpId}`/`{permEmpId}` substitution. Hermetic RBAC: **50/50 green,
183 cell probes, zero leftovers**.

> **Known non-code flake (pre-existing):** `scripts/qa-attendance-checkin-status.cjs`
> fails its two check-out assertions when the suite is run *after* the 21:00 IST
> auto-checkout deadline (the harness seeds an "open" day that `runAutoCheckout()`
> then closes on read). Unrelated to this feature; run the suite before 21:00
> IST or fix the harness to pin the clock.

---

## 4. Deliberate scope decisions

- **team_lead** is *not* given the rich editor (keeps mark-only) — matches the
  approved role model.
- **manager** scope is the reporting tree (not company-wide), even though the
  manager *listing* shows all employees; non-tree rows are simply not clickable
  and the API returns 403 with a clear message.
- **Future dates** are not editable via the editor (the "upcoming" matrix cell
  already blocks it).
