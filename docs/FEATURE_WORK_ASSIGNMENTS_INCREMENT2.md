# Work Assignments Increment 2 — Activity timeline, filters/search/pagination, daily-log roll-up (2026-11-04)

**Status:** shipped (branch `feat/work-assignments-incr2`, merged to `master` `d444872`).
**Closes:** Increment 2 from `docs/FEATURE_WORK_ASSIGNMENTS_REDESIGN.md` (D-A4, D-A8, D-A9).
Increment 3 (bulk assign, comments) remains.

## What shipped

### Server (`server/routes/work-assignments.js`)
- New table **`work_assignment_events`** (activity trail) in all three schema layers
  (`server/schema.sql`, `server/index.js` startup migration, `schemaRepair` `ENSURE_TABLE_DDL`).
  `assignment_id` is nullable + `ON DELETE SET NULL` so deleting an assignment keeps its trail.
- Event writes: `created` (POST), `status` moves with reason (PUT + approve), `edit` (field
  changes), `reassigned` (owner changed), `deleted` (pre-delete). Best-effort — an event write
  can never break the business op (wrapped in try/catch + self-heals the table).
- **`GET /:id/events`** (assigner / assignee / admin / hr) — joined actor names, newest 200.
- **`GET /:id/logs`** (same gate) — linked `daily_work_logs` roll-up: `total` count + 5 most
  recent (work_date/title/description/project/unit).
- **Filters/search/pagination** on `GET /` and `GET /my` (defaults unchanged for legacy
  callers): `?status= ?assignedTo= ?projectId= ?priority= ?q=` (escaped ILIKE on
  title/description) `?overdue=1` (IST due<today, non-terminal) `?limit=` (≤100) `?offset=`,
  and `total` in the response.
- **Role scoping on `GET /`** (privacy gap closed in passing): admin/hr see org-wide;
  manager/team_lead see only assignments they created; **employees get 403** (use `GET /my`).
  This matches the route's documented contract that the code failed to enforce.

### UI
- `/manager/team-work.html`: filter bar (status chips incl. server-side **Overdue**, priority /
  assignee / project selects, debounced **search**, **Clear**), **Load more** pagination
  (25/page + "Showing X of Y"), and an **Assignment Detail drawer** — click the card title area
  → slide-in panel with meta, action buttons, **Timeline** (events) and **linked daily logs**
  roll-up. `Escape` / overlay click closes the drawer.
- `/employee/my-work.html`: per-card **Timeline** toggle (lazy-loaded `/events` inline).
- `public/sw.js` cache bumped to **v17** (static pages shipped).

## Verification (live, production)
- `GET /api/work-assignments` → 200, `total: 6` (org-wide admin view).
- `?limit=2` → 2 rows; `?offset=2&limit=2` → next page (ids 21…, disjoint pages).
- `?priority=normal&limit=2` → 200 filtered; `?q=villa` → 200, `total: 4`.
- `?overdue=1` → 200 `total: 0` (valid, empty); `?priority=bogus` → **400**.
- `GET /api/work-assignments/23/events` → 200 (0 events — events record from this release forward;
  table self-healed on first read).
- `GET /api/work-assignments/23/logs` → 200 `total: 0 recent: []`.
- Unauthenticated `/events` → **401**.
- Regression: `/api/projects` 200, `/api/announcements` 200, `/api/employees` 200, `/sw.js` → v17.
- Syntax gates: `node --check` (routes/index/repair) ✓; inline-JS gate on both pages ✓;
  boot smoke with intentionally-unreachable DB ✓ (no require-time crash).

## Not verified / caveats
- No hermetic PG harness on this machine (local PostgreSQL not installed) — write paths
  (event inserts across POST/PUT/approve/DELETE, notifications fan-out) were **code-reviewed
  but not executed**; they should be exercised on the next staging/hermetic run.
- Live **writes were deliberately not performed** (would have notified real employees).
- Employee-role 403 on `GET /` and team-lead scope were verified by review only (no employee
  credentials were used).
