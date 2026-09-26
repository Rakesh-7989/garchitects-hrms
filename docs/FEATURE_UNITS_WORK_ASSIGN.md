# Feature Design — Units (sub-projects) + Work Assignments + Overtime removal

**Repo:** G-Architects HRMS · **Branch:** master (auto-deploys to https://garchitects-hrms.vercel.app)
**Status:** ✅ **Implemented + verified live (2026-09-26)** — overtime removed, Units (P1–P4), Work Assignments (P5–P6) and Assignment Awareness — widgets + bell + reports (P7) shipped to master. Design decisions D1–D4 locked (below).

---

## 1. Overtime removal

The company does not use overtime, so remove it entirely. Confirmed blast radius (grep):

| File | Change |
|------|--------|
| `server/schema.sql` (attendance, ~L109) | remove `overtime_hours` column (keep `hours_worked`/breaks) |
| `server/routes/attendance.js` | stop computing OT on clock-out (L155/166/181), reset to 0 (L311/351), drop from SELECT (L374) |
| `public/pages/employee/attendance.html` | remove "Overtime" column (L315/362) |
| `public/pages/employee/dashboard.html` | remove "Overtime" stat card (L175), today-status row (L155/387), monthly OT sum (L657–659) |

No payroll/reports/lists reference overtime — clean cut.
⚠ **Decision D4:** drop the DB column too (startup migration) vs keep-but-ignore. Recommended: **drop** (all values are 0).

---

## 2. Units (sub-projects) — the core feature

### 2.1 Concept
A project contains several **Units** — the physical/functional sub-divisions of the work
(e.g. for architecture: *Tower A / Tower B / Plot 12 / Floor 3 / RERA-phase 2 / Interior wing*).
Employees are assigned to a project **and** to the specific unit(s) they work in.
Every daily update records **which project** and **which unit** the work happened in.

### 2.2 Data model (additive; existing data keeps working)

```sql
-- NEW table
CREATE TABLE IF NOT EXISTS project_units (
    id           SERIAL PRIMARY KEY,
    project_id   INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name         VARCHAR(150) NOT NULL,        -- "Tower A", "Plot 12", "Interior wing"
    code         VARCHAR(30),                  -- optional short code "U1", "T-A"
    description  TEXT,
    status       VARCHAR(20) DEFAULT 'active', -- active | inactive
    created_at   TIMESTAMP DEFAULT NOW(),
    updated_at   TIMESTAMP DEFAULT NOW(),
    UNIQUE(project_id, name)
);
CREATE INDEX IF NOT EXISTS idx_project_units_project ON project_units(project_id);

-- Extend the two existing tables (nullable so legacy rows stay valid)
ALTER TABLE project_employees     ADD COLUMN IF NOT EXISTS unit_id INT REFERENCES project_units(id) ON DELETE SET NULL;
ALTER TABLE project_daily_updates ADD COLUMN IF NOT EXISTS unit_id INT REFERENCES project_units(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_project_employees_unit ON project_employees(project_id, unit_id);
CREATE INDEX IF NOT EXISTS idx_pdu_unit ON project_daily_updates(unit_id);
```

⚠ **Decision D1 — units per employee:** can one employee work in **multiple units on the same
project**?
- Recommended **YES** → relax `UNIQUE(project_id, employee_id)` to
  `UNIQUE(project_id, employee_id, unit_id)` (idempotent drop+add in the startup migration;
  Postgres treats NULLs as distinct so legacy "no unit" rows keep working).
- If NO → keep the existing unique and store only a single unit on the assignment.

⚠ **Decision D2 — daily-update model (LOCKED):** no uniqueness — an employee may log
**multiple updates per day**, each tied to the unit they worked in (site visit in Tower A
→ that unit's update; drafting in Tower B → that unit's update; another category later
→ another update). Every update carries `unit_id` (nullable). `UNIQUE(project_id,
employee_id, update_date)` is dropped in the startup migration.

### 2.3 API surface

```
project-units (new, mounted at /api/projects/:projectId/units)
  GET    /api/projects/:projectId/units                  admin — list units (+ assigned count)
  POST   /api/projects/:projectId/units                  admin — create unit {name, code?, description?}
  PUT    /api/projects/:projectId/units/:unitId          admin — rename / update
  DELETE /api/projects/:projectId/units/:unitId          admin — delete (assignments merged to no-unit
                                                          when possible, else dropped; updates keep history,
                                                          see §6 note)

project assignment (extended)
  POST   /api/projects/:projectId/employees   body: { assignments: [{ employeeId, unitId|null }] }
         (backwards-compatible with existing { employeeIds } array)
  GET    /api/projects/:projectId/employees   now returns unit_id + unit_name per row
  GET    /api/projects/:projectId/units/:unitId/employees   — roster of one unit
  DELETE unchanged

project updates (extended)
  POST/PUT  /api/project-updates   body gains unitId (nullable)
  GET       /api/project-updates   rows gain unit_id + unit_name; filter ?unitId=

project reports (extended)
  /api/project-reports/overview    per-project gains units_count; recentUpdates gain unit_name
```

### 2.4 UI

**Admin — `project-management.html`**
- Each project card/detail gains a **Units** expander: list units, add (name/code), rename, delete (confirm).
- **Assign Employees** modal: employee row gains a **Unit** dropdown (project's units + "No unit").
- **Daily Update** modal: **Unit** dropdown (populated from the selected project's units).
- Overview section: card shows units count.

**Employee — `my-projects.html`**
- Per-project card lists the project's units under the employee's assignments.
- **Post Daily Update** form: after project selection, a **Unit** dropdown appears
  (only that project's units, populated on project change — exactly the described UX).
- Update feed shows the unit badge.

---

## 3. Work assignments (Team Lead / Manager assigns work)

### 3.1 Foundation (already in the DB)
`employees.reporting_manager_id` exists → a ready-made **team hierarchy**:
- `team_lead` → their **direct reporters** (`reporting_manager_id = self`)
- `manager` → the full **subtree** under them (recursive)
- `hr` / `admin` → anyone
- Employee → sees **own** assigned work only

### 3.2 Data model

```sql
CREATE TABLE IF NOT EXISTS work_assignments (
    id            SERIAL PRIMARY KEY,
    project_id    INT REFERENCES projects(id) ON DELETE SET NULL,
    unit_id       INT REFERENCES project_units(id) ON DELETE SET NULL,
    assigned_by   INT NOT NULL REFERENCES employees(id),
    assigned_to   INT NOT NULL REFERENCES employees(id),
    title         VARCHAR(200) NOT NULL,
    description   TEXT,
    priority      VARCHAR(10) DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
    due_date      DATE,
    status        VARCHAR(20) DEFAULT 'assigned'
                  CHECK (status IN ('assigned','in_progress','completed','cancelled')),
    completed_at  TIMESTAMP,
    created_at    TIMESTAMP DEFAULT NOW(),
    updated_at    TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_wa_assignee  ON work_assignments(assigned_to, status);
CREATE INDEX idx_wa_assigner  ON work_assignments(assigned_by, status);
CREATE INDEX idx_wa_project   ON work_assignments(project_id);
```

Audit trail: new entity type `work_assignment` with `work.assign` / `work.update_status` /
`work.cancel` actions (audit_logs already generic).

### 3.3 API surface (new route `server/routes/work-assignments.js`, mounted at /api/work-assignments)

| Endpoint | Who | Behavior |
|---|---|---|
| `GET /` | isManager (scope-filtered) | admin/hr: all; manager: subtree; team_lead: direct reporters only for the *assigned_to side*; also visible: anything the caller *assigned* |
| `GET /my` | any auth | the caller's own assignments |
| `POST /` | isManager | create; server enforces scope (assignee must be in caller's allowed set) |
| `PUT /:id` | caller or scoped assigner | update fields/status; **assignee may only change status** (assigned→in_progress→completed / cancel) |
| `DELETE /:id` | assigner (scope) | delete/withdraw assignment |

Validation: assignee must be `status='active'`; project/unit must exist and match each
other (unit belongs to project); duplicate open assignment (same assignee+project+title)
warns instead of double-inserting.

⚠ **Decision D3 — scope:** confirm the hierarchy rule above (team_lead → direct reporters,
manager → subtree, hr/admin → anyone).

### 3.4 UI

- **Employee dashboard / My Projects:** new **"My Work"** list — open assignments with
  title, project/unit, priority, due date; buttons **Start / Mark Complete / Cancel**.
- **Team Lead & Manager:** **"Team Work"** section — their reporters' assignments;
  **Assign work** modal (reporter dropdown, project, unit, title, description, priority,
  due date) + live status columns.
- **Admin:** full assignment overview; edit/delete any.

---

## 4. Implementation plan (phases, each verify-gated)

| Phase | Scope | Gate |
|---|---|---|
| **P0** | Write `docs/` design (this doc) + confirm decisions | user sign-off |
| **P1** | Overtime removal (schema, attendance routes, 2 pages) | `node --check`, grep no `overtime`, build unaffected |
| **P2** | Units: schema/migration + `project-units` routes + extension of projects/updates/reports routes | API live tests vs deployed preview |
| **P3** | Admin UI: units expander, assign modal unit dropdown, update modal unit dropdown, overview units count | qa-assets + manual |
| **P4** | Employee UI: unit badge on cards, unit dropdown in update form, feed badge | qa-assets + manual |
| **P5** | Work assignments: schema + route + scope enforcement tests | API tests |
| **P6** | Work assignments UI (employee My Work + team-lead assign modal + admin overview) | manual + demo |
| **P7** | Full gate: qa-routes / qa-assets / ts-node syntax / smoke, one atomic commit, push master | live verification |

All migrations live in the app's **startup migration + `schema.sql`** pattern (idempotent
`IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`; only the unique-constraint relax for D1 and the
overtime column drop are destructive and gated on your D1/D4 answers). Commit is **atomic**
(server+UI together) so no transient broken state during Vercel deploy.

---

## 5. Open decisions (⚠) — RESOLVED 2026-09-26

| # | Question | Locked answer |
|---|----------|---------------|
| **D1** | Employee in multiple units per project? | **Yes** → unique relaxed to two partial indexes (one no-unit row per project+employee, one row per project+employee+unit) |
| **D2** | Daily updates per day | **Multiple** — every update is an insert tied to a unit; no per-project-day uniqueness |
| **D3** | Assignment scope | **No restriction** — any team_lead/manager/hr may assign to any active employee (reporting tree not enforced) |
| **D4** | `attendance.overtime_hours` | **Drop** column + remove all computation/UI |

## 6. Implementation status

| Phase | Scope | Status |
|---|---|---|
| P1 | Overtime removal (schema, attendance route, 2 pages) | ✅ shipped + verified live 2026-09-26 |
| P2 | Units schema/migration + routes (units CRUD, unit-aware assignment/updates/reports) | ✅ shipped + verified live 2026-09-26 |
| P3 | Admin UI (units expander, assign/update unit dropdowns, overview units count) | ✅ shipped |
| P4 | Employee UI (unit badges on cards/feed, unit dropdown in daily form) | ✅ shipped |
| P5 | Work assignments: schema + route + scope | ✅ shipped + verified live 2026-09-26 |
| P6 | Work assignments UI (employee My Work + team-lead assign) | ✅ shipped + verified live 2026-09-26 |

**Unit-delete fix (commit `72f3638`, live-verified):** `ON DELETE SET NULL` on
`project_employees.unit_id` collides with the partial unique `uq_project_employees_no_unit`
when the employee already has a no-unit assignment on the project (SET NULL would create a
second NULL row → 23505). The DELETE-units handler now clears assignment references first:
null-out when no other no-unit row exists, otherwise drop the assignment row (updates keep
history via their own SET NULL FK). Fresh `schema.sql` inits get the same protection because
the merge runs at every unit delete regardless of FK action.

**Live verification (2026-09-26, qa-units-final.mjs):** units CRUD + rename, per-unit employee
assignment (legacy NULL row + multiple unit rows coexist), **two same-day updates** on
different units (D2), `?unitId=` filter, PUT update unit change, foreign-unit rejection (400),
referenced-unit deletes (both assignment-only and with daily updates), `GET /projects/my`
units array for an assigned employee (verified via throwaway employee QA0001, permanently
deleted after), employee-side POST with unitId, and full live-DB cleanup (0 leftover units /
updates). Overtime: `attendance.overtime_hours` dropped by the startup migration (runs in the
same ordered block as project_units creation, confirmed present) and zero `overtime` refs
remain in `public/`.

**Work assignments — server (commits `b2a16dc` + `83c03e7`, live-verified with qa-wa-live.mjs):**
table section 23 + startup migration; `server/routes/work-assignments.js` mounted at
`/api/work-assignments` — GET (admin/hr: all + filters; manager/team_lead: own-created),
GET /my (any auth), POST (isManager, D3 any active employee, dup-open 409, unit↔project 400,
title 400), PUT (assignee status-only with legal moves + terminal-state locks; assigner/admin/hr
full edit), DELETE (assigner/admin). `schemaRepair.js` self-heals `work_assignments` +
`project_units` (and aligns `project_employees`/`project_daily_updates` heals to the D1/D2 shape)
so a cold-instance first request can never 500 on a missing table. Full live matrix green:
create (no-project + project+unit, names joined, assigned_by=admin), dup 409, foreign unit 400,
missing title 400, GET / + status filter, GET /my, assignee assigned→in_progress→completed
(completed_at set) + illegal move 400 + title-edit 400 + cancel, assignee delete 403, admin
full edit + delete, full cleanup (0 rows left, QAWA1 deleted).

**Work assignments — UI (commit `e1da3c9`, live-verified with qa-wa-ui-live.mjs):**
- Employee **My Work** (`public/pages/employee/my-work.html`, `/employee/my-work`): own
  assignments via GET /my with Open/In Progress/Completed/Overdue stat cards, status filter
  chips, priority/due/project-unit/assigner meta, and Start / Mark Complete / Cancel actions
  (legal moves only; completed_at shown when done). Nav item "My Work" added to all 14
  employee pages.
- **Team Work** (`public/pages/manager/team-work.html`, `/manager/team-work`): role-guarded
  (admin/manager/team_lead/hr). Assign Work modal (active-employee picker from
  `/employees/directory` — admin/hr/manager see all, team_lead sees direct reports; project
  picker from new GET `/api/work-assignments/projects`; unit picker dependent on project via
  existing `/projects/:id/units`), status filter chips, Edit (legal status targets only) for
  assigner/admin/hr, Withdraw for assigner/admin. Admin/hr see every assignment; manager/team_lead
  see only what they created (D3). Server routing: `/manager/my-team` became `/manager/:page`
  via `servePortalPage('manager')`; "Team Work" nav item added to `my-team.html` + all 18 admin
  pages; auth.js auto-shows the Team Work link for admin/manager/team_lead/hr.
- Live: both pages serve 200, picker endpoints authorized (401 without token), full UI-driven
  lifecycle POST→PUT(completed)→DELETE round-trips with 0 rows left afterwards.

## 7. Assignment awareness — widgets + bell + reports (commit `ba5307c`, SQL fix `dfd9c5a`)

Make the new Work Assignments module visible and actionable across the app. **Live-verified 2026-09-26
with qa-awareness-live.mjs (23/23 pass).**

| Piece | Where | What |
|---|---|---|
| **My Work widget** | Employee dashboard (all roles) | Open / In Progress / Overdue counts + top-3 urgent items → `/employee/my-work`. Data: `GET /work-assignments/my` (already live). |
| **Work Assignments Pulse** | Employee dashboard, roles admin/manager/team_lead/hr only (`#managerWorkCard`) | Team-scope stats (Open/In Progress/Completed/Overdue — overdue = `due_date < today IST` on non-terminal) + recent 5 rows → `/manager/team-work`. Data: `GET /work-assignments`. |
| **Work Assignments card** | Admin dashboard (`#adminWaList`) | Company-wide stat chips + recent-8 table (assignee avatar/name, title+project/unit/due, status badge) → Team Work. Data: `GET /work-assignments` (admin sees all). |
| **Bell + sidebar badges** | `dashboard.js` + `GET /notifications/counts` | New `openWorkAssignments` count (admin/hr: all open; manager/team_lead: own-created — same D3 scope as `GET /`). Added to the admin/manager bell total AND to a **Team Work** sidebar nav badge (`loadSidebarCounts`). |
| **Work Assignments report** | Admin Reports page + new `GET /api/reports/work-assignments` (isAdmin) | Status summary chips (Total/Open/In Progress/Completed/Cancelled), **By Employee** (open/completed/total, sorted open-first), **By Project** (open/completed/total), **Recent 10** (title, assignee, assigner, project, status, due). |

**Bug found + fixed during live QA:** the report route first returned 500 — Postgres rejected the
aggregate queries because `SELECT` carried `wa.assigned_to` (by-Employee) and `wa.project_id`
(by-Project), which are not in `GROUP BY` and not functionally dependent → whole `Promise.all`
rejected (fix `dfd9c5a` drops the unused columns). Verifier confirms the completed-state move
(assigned→completed) is reflected in `byStatus` immediately after the PUT.

No schema change (all reads reuse the existing `work_assignments` + `employees` + `projects`).

## 8. Delegated project/unit assignment — "Team Projects" (P8)

**Decision D5 (locked):** project/unit assignment is **D3-unrestricted** — any
`team_lead` / `manager` / `hr` / `admin` may assign **any active employee** into **any
project / any unit** (same freedom as Work Assignments). No hierarchy scope check.

Previously `POST/DELETE/GET /api/projects/:projectId/employees` + units CRUD were
**`isAdmin`-only** — team leads/managers had no way to place their people on projects.
P8 opens the three project-employee endpoints to `isManager` and adds a dedicated
manager-portal page. Project CRUD + units CRUD remain **admin-only** (structure stays
admin-controlled; P8 delegates *membership/placement* only).

| Piece | Detail |
|---|---|
| **Server** (`server/routes/projects.js`) | `GET/POST /:projectId/employees` + `DELETE /:projectId/employees/:employeeId` → `isAdmin` → `isManager`. New **`GET /api/projects/options`** (`isManager`, registered before `/:id`): minimal picker `[{id,name,status,units[]}]` via `json_agg` LEFT JOIN, so manager UIs get all projects + their units in one call. Audit `project.assign`/`project.unassign` unchanged. |
| **New page** `/manager/team-projects` | `public/pages/manager/team-projects.html` (servePortalPage pattern). Project picker (options) → stat chips (members / units / in-unit / no-unit) → roster table (`GET /:projectId/employees`) with Remove; **Assign Employees** modal: unit dropdown (that project's units, optional) + employee multi-select + search (`/employees/directory`) → `POST {assignments:[{employeeId,unitId}]}`. Role-guarded to admin/manager/team_lead/hr. |
| **Nav** | `#teamProjectsLink` added beside Team Work on `team-work.html`, `my-team.html`, `my-work.html` (auto-shown via `auth.js` for admin/manager/team_lead/hr) **and** on all 18 admin sidebar pages (always visible, like Team Work). |

**Remove-membership note:** the DELETE route matches `project_employees.employee_id`
(employee **row id**), while the roster exposes `employee_id` as the **code string** —
the page must pass `m.id` (row id) to `/employees/:id`, not the code (caught during
implementation).

## 9. Project Leads — delegated project/unit ownership (P9)

**Decisions locked:**
- **D6** — designation power: **admin / manager / hr** only (team_lead cannot designate).
- **D7** — lead target role: active **team_lead or manager**.
- **D8** — lead placement scope: **my team + my units**, server-enforced on the lead
  route (`/api/project-leads/place`): a team_lead/manager may place only their
  reporting-tree employees into the project/units they lead; admin/hr bypass (they
  keep P8 power). The P8 general route stays D5-unrestricted.
- **D9** — a *whole-project* lead (unit_id NULL) owns every current **and future** unit
  (auto-follow); a *unit-scoped* lead owns only the chosen units.
- **D10** — multiple leads per project allowed; one lead may lead many projects.

| Piece | Detail |
|---|---|
| **Schema** (`project_leads`, §24 + startup migration + schemaRepair self-heal) | `(id, project_id, lead_id, unit_id→NULL=whole project, assigned_by, assigned_at)` with partial uniques `uq_project_lead_project`(project,lead) WHERE unit NULL and `uq_project_lead_unit`(project,unit,lead) WHERE unit not NULL. |
| **Route** `server/routes/project-leads.js` (`/api/project-leads`) | `POST /` designate `{projectId, leadId, unitIds[]}` (empty = whole project; all-per-unit conflicts handled); `GET /` overview; `GET /mine` (caller's led projects + units + member counts); `GET /leads-options` (active team_lead/manager); `GET /my-team` (reporting-tree picker mirroring /place enforcement; admin/hr → all active); `DELETE /:id`; `POST /place` (idempotent inserts honoring the partial uniques + audit `project.lead_designate`/`project.lead_unassign`/`project.lead_place`). |
| **UI** | `/manager/team-projects` gained a **Project Leads** panel (list + Assign Lead modal with unit checkboxes default-all; role-gated to admin/manager/hr). New **`/manager/led-projects`** page: "My Led Projects" — per led project show units + member counts, "Assign Team" modal places my reporting tree into my units (or the project itself when it has no units), refresh after placement. Nav `#ledProjectsLink` on the 4 portal pages + all 18 admin pages. |
| **No-units handling** | A unit-less project is designated as a whole-project lead (unit NULL). The lead page falls back to "Assign to Project" (no unit). Simultaneously P8/D5 already lets any managerish place any active employee into any unit-less project directly — the user-requested "units పక్కన పెడితే ఎవరు ఎవరికి ఐనా" freedom is preserved. |

### 9.1 — Team-lead scoping (`D11`, overrides D5 for team_leads; live-verified 11/11 + scope matrix)

After a live check the user asked: *"why does a team lead have broad project access — the
team lead should only assign their team into the project the admin/manager assigned to
them."* Decision `D11`: **scope the team_lead** — managers/admin/hr keep D5 full power.

| Layer | Change |
|---|---|
| `GET /api/projects/options` | For `team_lead` returns **only the projects they lead** (project-level row → project + all its units; unit rows → those units). Other roles unchanged. |
| `POST /api/projects/:id/employees` | For `team_lead`: every assignment must target a project/unit they lead **and** every employee must be in their reporting tree, else 403 (mirrors `/project-leads/place`; helpers `leadCovers`/`myTreeIds` shared from `project-leads.js`). |
| `DELETE /api/projects/:id/employees/:employeeId` | For `team_lead`: may only remove members from projects/units they lead, else 403. |
| `GET /api/notifications/counts` | New `openLeadProjects` count (DISTINCT led projects) → bell badge + sidebar badge on **My Led Projects** lights up the moment a designator assigns a lead. |
| `/manager/team-projects` UI | For `team_lead`: project picker loads via `/project-leads/mine` (led projects only; empty state explains "you are not the lead of any project yet"); employee picker loads via `/project-leads/my-team` (reporting tree). |

**Same scoping applied to work assignments (`Team Work` page)** — user confirmed "Team Work లో కూడా అదే — same":
| Layer | Change |
|---|---|
| `GET /api/work-assignments/projects` (picker) | For `team_lead`: only the projects they lead (DISTINCT lead rows). Other roles see all. |
| `POST /api/work-assignments` | For `team_lead`: the assignee must be in their reporting tree (else 403) **and** a non-null project/unit must be one they lead (else 403). A project-less task has no project boundary, so the tree rule alone applies. |
| `PUT /api/work-assignments/:id` | For `team_lead` assigners: reassignment must stay within their reporting tree; moving work onto a project/unit requires leading it (else 403). |
| `GET /api/projects/:id/units` | For `team_lead`: within a project they lead, only their covered units (whole-project row → all; unit rows → those units only); with no lead rows in that project they are just a member → all units unchanged. |
| `/manager/team-work` UI | `team_lead` employee picker loads via `/project-leads/my-team` (reporting tree); project dropdown gets a disabled "No projects assigned to you yet" placeholder when empty. |

Consequence: a team_lead with **no** designated project can no longer assign anyone
anywhere (previous D5 gap closed); once admin/manager designates them, the project
appears in Team Projects + My Led Projects and they can place their team into it.

---

## 10. Phase A — Security & data-integrity hardening (professional audit, commit `813ea0c`)

Full-module audit (2026-09-26) => prioritised fixes, live-QA'd 23/23:

| Finding | Fix |
|---|---|
| `must_change_password` enforced client-side only; a temp password stayed usable via the API forever | **Server-side lock** in `verifyToken`: non-admin accounts flagged `must_change_password` may only reach the password/account surface (`/auth/me`, change/set-password, logout, profile-photo, profile-request); everything else → `403 code=PASSWORD_CHANGE_REQUIRED`. |
| `POST /api/payroll/render-pdf` SSRF: any authenticated user could inject `company.logo_url` pointing at an internal address + unbounded download | Guard → `isManager`; company details always fetched from the DB (`getCompanyData()`), client-supplied company ignored; logo downloader gets a 3 MB sanity cap. |
| `BEGIN/COMMIT` on the pool helper in leave/wfh cancel + regularization review → each statement could run on a different connection, silently breaking atomicity | Converted to a single checked-out `getClient()` connection with `ROLLBACK` on error + `release()` in `finally`. |
| Hardcoded OTP pepper literal in source | `OTP_PEPPER || JWT_SECRET`, fails closed if neither set. |
| Audit-log gaps on mutating routes | `logAudit` added for leave approve/reject/cancel, wfh approve/reject/cancel, regularization review. |

## 11. Phase B — Role model: HR + team-lead scoping everywhere (audit follow-up)

User decisions (2026-09-26): **HR = Manager + HR-modules** • **scope the team_lead
everywhere (D11 rule)** → commit below is live-QA'd.

### 11.1 New middleware `isAdminOrHr` (admin OR hr)

HR now manages the people modules; money-write ops and structural settings stay admin-only:

| Module | HR gets | Stays admin |
|---|---|---|
| employees | list, export, create, import, update, reset-password, pause/resume/hold/unhold/abscond/terminate/rehire, soft-delete, full PII incl. salary on `GET /:id` | **permanent delete** (`DELETE /:id/permanent`) |
| payroll | VIEW: `GET /all`, `GET /:id`, `GET /:id/pdf`, `/export`, `/attendance-summary` | **generate, generate-bulk, delete**, render-pdf (elevated `isManager`) |
| reports | dashboard/employees/attendance/work-assignments | — |
| profile updates | list, approve, reject | — |
| letters | generate | — |
| onboarding | templates CRUD, process list/tasks, start, reopen, export | — |
| documents | `GET /all`, admin delete | — |
| attendance | `GET /all`, `/export`, `/late-count` | — |

### 11.2 Team-lead scope extended to the remaining broad modules (D11 everywhere)

| Endpoint | Change |
|---|---|
| `POST /api/attendance/mark-present`, `mark-absent` | For `team_lead`: target must be in own reporting tree (`myTreeIds`), else 403. |
| `GET /api/attendance/monthly` | For `team_lead`: matrix covers only their reporting tree; managers/HR/admin see all. |
| `GET /api/project-reports/overview`, `/activity` | For `team_lead`: only projects they lead (any project_leads row); recent updates/docs + activity scoped to those projects. Managers/HR/admin see all. |

### 11.3 TOCTOU approvals closed + audit logging on the real approval flow

Leave/WFH/ticket approvals now use a **conditional UPDATE** (`AND status = 'pending'` /
`AND status IN ('open','in_progress')`) plus a row-count check → concurrent double-approval
returns `409` instead of applying twice. Applied to `manager.js` leaves/wfh/tickets and the
admin-path approve routes in `leave.js`/`wfh.js`. Also added the previously-missing
`logAudit` calls to `manager.js` (leave/wfh approve+reject, ticket respond) — that is the
real day-to-day approval flow and used to write zero audit rows.