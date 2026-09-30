# Feature: Offboarding journey (shipped 2026-09-30)

## What

A full employee **offboarding** journey mirroring the existing onboarding flow.
The schema always reserved `employee_processes.type = 'offboarding'` ("kept for a
future offboarding flow"); this release wires that type end-to-end.

## Model

| Table | Change |
|-------|--------|
| `hr_task_templates` | **+ `type` column** (`VARCHAR(20)` default `'onboarding'`, CHECK `in ('onboarding','offboarding')`) + index `(type, is_active)`. Templates are now per-journey. |
| `employee_processes` | unchanged — CHECK already allowed `'offboarding'`, `UNIQUE (employee_id, type)` already guaranteed one journey per employee per type. |
| `process_tasks` | unchanged — journey tasks copied from templates at start. |

Migration is additive + idempotent (`server/index.js`): existing onboarding
templates keep `type='onboarding'`. Fresh installs get both default checklists
via `server/schema.sql`; the runtime self-seed (`services/onboarding.js`
`ensureTemplatesSeeded(type)`) covers migrated DBs per type. For live DBs that
lazily created `hr_task_templates` **before** this release (no `type` column),
`schemaRepair` self-heals the missing column on the first type-aware call
(42703 → `ALTER TABLE hr_task_templates ADD COLUMN IF NOT EXISTS type ...` +
type index) — no manual `db:migrate` needed. Verified live end-to-end
(2026-09-30): seeds 7 offboarding + 6 onboarding templates, start/complete/
reopen flows, per-type exports, and both pages serve the new tabs.

## Default offboarding checklist (7 tasks, copied at start)

1. Return company assets (laptop, ID card, access badge) — admin
2. Revoke office email & tool access — admin
3. Hand over project files & working documents — employee
4. Complete knowledge-transfer / handover notes — employee
5. Office clearance (desk, keys, parking) — employee
6. Final settlement — leave balance, advances & dues — admin
7. Apply for relieving letter & experience certificate — employee

## API surface

All existing routes stay backwards-compatible (`type` defaults to
`onboarding`); every one now accepts `?type=offboarding` (GET) / `body.type`
(POST):

| Route | Change |
|-------|--------|
| `GET /onboarding/my` | `?type=` filter (default onboarding) |
| `GET /onboarding/processes` | `?type=` filter |
| `GET /onboarding/processes/:id/tasks` | any journey type (was onboarding-only) |
| `POST /onboarding/processes/:id/tasks` | any journey type (was onboarding-only) |
| `POST /onboarding/tasks/:id/complete` | works for offboarding tasks; push/audit text per type |
| `POST /onboarding/tasks/:id/reopen` | audit per type |
| `POST /onboarding/start/:employeeId` | `body.type` starts onboarding **or** offboarding |
| `GET /onboarding/templates` | `?type=` filter + per-type seed |
| `POST /onboarding/templates` | `body.type` |
| `PUT/DELETE /onboarding/templates/:id` | audit per template type |
| `GET /onboarding/export` | `?type=` filter; workbook name/subtitle per type |

Audit actions: `offboarding.start / task_complete / task_reopen / task_add /
template_create / template_update / template_disable` (mirror of `onboarding.*`).

## UI

- **Admin** (`public/pages/admin/onboarding.html`): Onboarding | Offboarding
  toggle; per-type tracker table, checklist modal, template manager, "Start
  Offboarding" modal (active non-admin employees without an existing
  offboarding journey), type-aware export.
- **Employee** (`public/pages/employee/onboarding.html`): Onboarding |
  Offboarding toggle; per-type progress hero + checklist; "Mark Done" for
  employee-assigned tasks. The "visit My Profile" tip only shows for
  onboarding.

## Notes

- Offboarding is started explicitly by admin/HR (never auto-started).
- Recommended trigger: start while the employee is still **active** (serving
  notice) so they can complete their `employee` tasks before the last working
  day. Once terminated, the account can no longer log in and HR completes the
  remaining employee tasks on their behalf (admin can complete any task).
- Terminated/paused employees are not offered in the "Start Offboarding"
  candidate list (candidates are `status=active`, `role != admin`).