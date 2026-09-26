# Feature Design — Units (sub-projects) + Work Assignments + Overtime removal

**Repo:** G-Architects HRMS · **Branch:** master (auto-deploys to https://garchitects-hrms.vercel.app)
**Status:** Proposed — waiting on 4 design decisions before implementation (marked ⚠ below)

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
| P5 | Work assignments: schema + route + scope | 🔜 next |
| P6 | Work assignments UI (employee My Work + team-lead assign) | 🔜 next |

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