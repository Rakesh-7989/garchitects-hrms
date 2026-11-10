# FEATURE — Employee 360 drill-down + project team progress (2026-11-10)

> **TL;DR** — The founder asked where you can see "one employee's attendance,
> daily reports, work logs, check-in/check-out details" and "who was assigned
> the work, and is it done" in the admin/manager portals. The honest answer
> before this release was: **nowhere in one place.** The employee's *profile*
> was viewable, but their *activity* was spread over five pages, each with its
> own filter, and the attendance register had no per-employee filter at all.
> This release ships **one per-employee drill-down** (`/admin/employee/:id` and
> `/manager/employee/:id`) that answers all of it in a single request, plus the
> **assignment progress per project member** the project pages were missing.

---

## 1. What was there before (and what was missing)

| The question | Where it lived before | Gap |
|---|---|---|
| "show me this employee's attendance" | Admin → Attendance (the month matrix, company-wide) | **no per-employee filter** — `GET /api/attendance/all` accepted `date`/`month`/`year`/`department` but **not** `employee_id`, so you had to eyeball the matrix |
| "show me this employee's check-in / check-out details" | Admin → Attendance → *Recent Attendance Logs* (the last 20 rows of the WHOLE company) | the employee's own records were not reachable |
| "show me this employee's daily work logs" | Manager → My Team → *Daily Work Logs*; Admin → Dashboard card | no per-employee view, and the API had no employee filter for an admin |
| "show me what work this person has, and what is done" | Manager → Team Work (filterable by assignee + project) | no per-employee roll-up (open vs completed) |
| "show me the employee's profile" | Admin → Employees → 👁 View (a modal) | profile only — no activity |
| "who is on this project and what have they done?" | Admin → Projects → *Assigned Employees* | the list showed **names only** — no assignment progress at all |

So the answer to "where is it?" was: *everywhere and nowhere*. A single
question ("what did this person actually do this month?") needed five pages,
five filters and a lot of scrolling — and there was no link between a project
team and the people on it.

## 2. What shipped

### 2.1 `GET /api/employees/:id/activity` — the one request that answers it all

One endpoint, one response, correctly scoped:

```jsonc
{
  "success": true,
  "employee": { /* id, code, name, designation, department, manager, joining date, status, email, phone */ },
  "period": { "year": 2026, "month": 11, "days": 30 },
  "attendance": {
    "cells":   { "3": { "status": "present", "check_in": "09:30", "check_out": "18:30", "check_in_location": "…", "photo_token": "…" } },
    "summary": { "present": 3, "late": 1, "halfDay": 0, "absent": 2, "leave": 1, "wfh": 0, "weekoff": 2, "holiday": 1, "upcoming": 0 },
    "records": [ /* the last 30 rows: times, status, remarks, location, auto_checkout, photo tokens */ ]
  },
  "work_logs":     [ /* the daily work updates (date, title, description, project, assignment) */ ],
  "assignments":   { "counts": { "open": 1, "completed": 1, "blocked": 0, "cancelled": 0, "total": 2 },
                     "open": [...], "completed": [...] },
  "leave":         [ /* recent leave applications */ ],
  "wfh":           [ /* recent WFH requests */ ],
  "projects":      [ /* the projects they are on */ ]
}
```

**Access model** (asserted by the new harness):

| Viewer | Scope |
|---|---|
| admin / hr | any employee |
| manager / team_lead | their own reporting tree (`myTreeIds`) + themselves |
| employee | themselves only |
| no token | 401 |

### 2.2 The month cells are now SHARED with the attendance matrix

The cell logic (a paid leave day is `onleave`, a LOP leave day is `absent`, a
holiday an admin marked absent is `absent`, *today* without a record is **not**
an absence, …) lived inline in `GET /api/attendance/monthly`. Copying it into a
second endpoint is exactly how two views drift apart, so it was extracted to
**`server/utils/attendanceMatrix.js`** (`buildEmployeeMonthCells` +
`summariseMonthCells`) and both endpoints call it. The matrix behaviour is
unchanged — the matrix route now builds its cells through the shared helper.

### 2.3 The page — `/admin/employee/:id` and `/manager/employee/:id`

`public/pages/employee-360.html`, one page for both portals (the API decides
what the viewer may see):

* **header** — back link, initials avatar, name, code, designation, department,
  reporting manager, joining date, status badge;
* **summary chips** — Present / Late / Half Day / On Leave / WFH / Absent /
  Open Work / Completed;
* **month grid** — every day of the month with its status colour and the
  check-in → check-out times, with a month + year picker;
* **tabs** — Overview (profile + work counters) · Attendance (the recent
  check-in/check-out details with the hours worked, the location link and the
  check-in photo) · Work Logs · Assignments (open vs completed, with the
  project, due date and blocked reason) · Leave & WFH · Projects.

### 2.4 Entry points — where to click

| From | Where |
|---|---|
| Admin → **Employees** | the 📊 button next to 👁 View on every row |
| Admin → **Attendance** | click the **employee name** in the month matrix |
| Admin → **Reports → Work Assignments** | the employee name in *By Employee* and in *Recent Assignments* |
| Admin → **Projects** | the member name in *Assigned Employees* (now also with the progress chips) |
| Manager → **My Team** | the member name in the attendance matrix |
| Manager → **Team Work** | the assignee name on a task card |

### 2.5 Project team progress

`GET /api/projects/:projectId/employees` now also returns, per member,
`assignments_total` / `assignments_open` / `assignments_blocked` /
`assignments_completed`, and the project page renders them as
**"2/3 done" · "1 open" · "1 blocked"** chips next to each name — so "who was
assigned the work and what is done" is answered on the project screen itself.

## 3. Verification

**In Chromium (local hermetic stack, seeded admin + employee + project):**

| Probe | Result |
|---|---|
| `GET /admin/employee/:id` | renders: name, meta line, 8 summary chips, 30 day cells, 6 tabs |
| Attendance tab | 6 records with the real details: `2026-11-09 09:30 → 18:30 (9h 0m) Present`, `2026-11-07 10:20 → 18:30 (8h 10m) Present`, `2026-11-06 09:30 → 18:30 (9h 0m) Late — traffic` |
| Work Logs tab | `2026-11-08 Drafted the lobby elevation — Finished section A, section B to follow. — QA Tower A` |
| Assignments tab | *Open work 1* → "Draft the lobby elevation · In Progress · Normal · QA Tower A · due 2026-11-14"; *Completed 1* → "Site walk with the structural engineer · Completed" |
| Leave & WFH tab | the approved leave and the approved WFH |
| Projects tab | "QA Tower A — QA Client · Active" |
| console errors | **0** |

**Automated** — new `scripts/qa-employee-360.cjs` (**26/26**) wired into the QA
commander: the payload sections, the month cells (present day with its
times, late day, absent day, the summary counters), the records with the
check-in details and the location, the work logs, the assignment counters
(open 1 / completed 1 / total 2), the leave + WFH + project lists, the whole
access model (admin→anyone 200, manager→own report 200, manager→out-of-tree
403, manager→self 200, employee→self 200, employee→other 403, no token 401,
invalid id 400, unknown 404) and the project team progress counters.

New RBAC matrix row `emp-activity` (admin/hr → 200, manager/team_lead/employee
→ 403 for a target outside their scope).

Full hermetic `npm run qa`: **94/94 green** (13 harnesses, 284 RBAC cell
probes, 43 DB invariants, zero leftovers). `npm run qa:inline`: 39/39.

## 4. Files touched

| File | Change |
|---|---|
| `server/utils/attendanceMatrix.js` | **new** — the shared month-cell builder + summary |
| `server/routes/attendance.js` | the matrix now builds its cells through the shared helper (behaviour unchanged) |
| `server/routes/employees.js` | **new** `GET /:id/activity` — the drill-down payload, role-scoped |
| `server/routes/projects.js` | the project team list now carries each member's assignment progress |
| `server/routes/reports.js` | the work-assignment report carries the employee ids so the rows can link |
| `server/index.js` | the `/admin/employee/:id` + `/manager/employee/:id` routes |
| `public/pages/employee-360.html` | **new** — the drill-down page |
| `public/pages/admin/employees.html` | the 📊 entry point per row |
| `public/pages/admin/attendance.html` | the employee name links to the drill-down |
| `public/pages/admin/reports.html` | the report rows link to the drill-down |
| `public/pages/admin/project-management.html` | the member name links + the progress chips |
| `public/pages/manager/my-team.html` | the member name links to the drill-down |
| `public/pages/manager/team-work.html` | the assignee name links to the drill-down |
| `scripts/qa-employee-360.cjs` | **new** — the drill-down harness (26 checks) |
| `scripts/qa-commander.cjs` | the harness wired into the regression stage |
| `qa/rbac-matrix.json` | the `emp-activity` row |
