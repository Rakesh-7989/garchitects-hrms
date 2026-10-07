# Feature Design — Work Assignments Redesign (v2)

**Repo:** G-Architects HRMS · **Branch:** master (auto-deploys)
**Status:** 🔧 In progress — Phase 0 + **Increment 1 shipped**; independent audit folded in 2026-10-07; Increment 2 (timeline + roll-up + filters) pending.
**Related:** `docs/FEATURE_UNITS_WORK_ASSIGN.md` (original Work Assignments spec + decisions D3/D11).

---

## 1. Why this redesign

The Work Assignments module (shipped 2026-09-26) is sound in its core idea but accrued
incremental debt and one production-breaking defect. This redesign fixes the foundation,
makes an assignment a **readable work thread** (not just a status row), and adds the
filters/roll-ups a real studio manager needs — **without breaking existing rows**.

### 1.1 Defects confirmed and fixed (Phase 0, commit `167b621`)

| Id | Defect | Fix |
|----|--------|-----|
| W-01 | `PUT /api/work-assignments/:id` destructured `req.body` without `startDate` but referenced it at the start-date guard → `ReferenceError` → **500 on every Edit** by assigner/admin (POST was fixed in `c99f518`; PUT was missed). | Added `startDate` to the destructure; the "cannot be cleared" guard now works. |
| W-02 | Overdue computed against UTC (`new Date().toISOString().slice(0,10)`) on My Work + Team Work → wrong for ~5.5 h/day IST. | Now uses `getTodayIST()` (auth.js). |

### 1.2 Independent audit (2026-10-07) — findings folded into Increment 1

A backend/security read of the module (no files modified by the auditor) ranked no Critical
issues; the worst are cross-user *metadata* disclosure and a standing privilege-retention
hole. The following were **fixed in Increment 1**:

| Id | Finding | Fix shipped in Increment 1 |
|----|---------|---------------------------|
| H1 | `daily_work_logs.assignment_id` accepted from anyone about anything (IDOR + cross-scope leak of assignment title/assigner + FK oracle) | Link is now server-validated: must be the caller's **own** assignment, else 404/400. |
| H2 | Admin permanent employee delete 500s: `work_assignments` FKs (`assigned_by/assigned_to NOT NULL`, no `ON DELETE`) not cleaned in the purge txn | `DELETE FROM work_assignments WHERE assigned_by=$1 OR assigned_to=$1` added to the permanent-delete transaction (audited). |
| H3 | A demoted manager/TL keeps full edit/reassign/delete power over rows they created (PUT/DELETE had no role gate) | Non-assignee PUT/DELETE now require a current manager-level role; D11 scope re-checked even when clearing `projectId`. |
| M1 | TL could clear `projectId` and skip the D11 boundary check | Scope now evaluated against the **final** project (`pu.proj ?? row.project_id`). |
| M2 | Read-then-write with no precondition → concurrent edits both win | TOCTOU-safe `UPDATE … WHERE id AND status = <validated>` + `rowCount` check → 409. |
| M3 | `due >= start` compare silently skipped on partial edits (`string < Date` is always false) | Uses `dateOnly()` on both operands. |
| M4 | `completed_at` rewritten by unrelated edits (and no-op re-save) | Only touched on an actual `→completed` transition; preserved on no-op. |
| M5 | POST accepted a born-closed status; terminal rows unrecoverable | POST now only accepts `assigned/in_progress/blocked`. (Reopen edges remain out of scope.) |
| M6 | Status change notified **only** the assigner; DELETE/reassign silent | Status change notifies the **counterpart**; DELETE notifies the assignee (`work_withdrawn`); reassign notifies the previous owner (`work_reassigned_away`). |
| M9 | Title length / `work_date` format / project-unit pairing gaps → 500s or inconsistent rows | Title ≤200/255 checks; `work_date` validated via `dateOnly()`; log project/unit pairing validated; `22001` added to shared `pgErrorResponse`. |
| M10 | HR org-wide counts computed server-side but dashboard.js parked HR in the employee branch → dead badges | HR now takes the admin counts branch (Team Work badge works). |
| M11 | Editing a log silently unlinked a closed assignment; `work_date` was a silent no-op on PUT | Closed-but-owned links are preserved in the UI and accepted server-side; PUT now updates `work_date`. |
| M12 | `assigned_at` backfilled with migration instant; `index.js` layer incomplete | One-off `assigned_at = created_at` repair (idempotent); `start_date`/`assigned_at` + `daily_work_logs` block added to the startup migration so all three layers agree. |
| L7/L8 | Dead `managerIdsOf` import; unguarded `colMap` key | Import removed; unmapped change keys are now skipped loudly. |

---

## 2. Locked decisions (expert-owned, 2026-10-07)

These are decided — implementation proceeds without re-asking.

| # | Decision | Choice |
|---|----------|--------|
| **D-A1** | Add a `blocked` status with a reason? | **Yes.** Studio work blocks on client approvals / site readiness. Adds `blocked` + `blocked_reason`. |
| **D-A2** | Who may cancel? | **Assigner / admin only**, with a required `cancel_reason`. The **assignee cannot hard-cancel**; they may start, complete, or mark blocked. (Stops silent disappearance of assigned work.) |
| **D-A3** | Can the assignee edit fields? | **No.** Assignee = status moves only (as today). Assigner/admin retain full edit. |
| **D-A4** | Activity timeline? | **Yes.** New `work_assignment_events` table, appended on create + every status/field change. Visible to assigner, assignee, admin, hr. |
| **D-A5** | Comments thread? | **Not now.** Timeline + Daily Work Logs cover collaboration; revisit only if asked. |
| **D-A6** | Actual vs planned dates? | Keep `start_date`/`due_date` as **planned**. Add explicit **actual** `started_at`, `cancelled_at`. Stop `COALESCE`-ing planned ≠ actual. |
| **D-A7** | Overdue definition | `due_date < today (IST)` AND status not terminal (`completed`/`cancelled`). `blocked` still counts as overdue. |
| **D-A8** | Team Work UI | Server-side **filters** (status, assignee, project, priority) + **search** + **pagination**; assignment **detail drawer** with timeline + linked daily-log roll-up. |
| **D-A9** | Daily-log integration | Roll up **count + most recent** linked `daily_work_logs` onto the assignment detail (read-only). Daily logs have no hours column, so no hour totals. |
| **D-A10** | Bulk assign / subtasks | **Deferred** to a later phase — keep this redesign tight. |
| **D-A11** | Migration posture | **Additive only.** `schema.sql` + startup migration + `schemaRepair` self-heal; every new column nullable/defaulted; existing rows render null-safe. No destructive change. |
| **D-A12** | Priority levels | Keep `low / normal / high / urgent`. |

---

## 3. Status state machine (after redesign)

```
assigned ──▶ in_progress ──▶ completed
   │             │  ▲            ▲
   │             ▼  │            │
   │          blocked ───────────┘
   │             │
   ▼             ▼
cancelled ◀──────┘        (cancelled reachable from assigned/in_progress/blocked, by assigner/admin only)

terminal: completed, cancelled (no outgoing moves; reactivation is out of scope)
```
- **Assignee** legal moves: `assigned→in_progress`, `assigned→blocked`, `in_progress→completed`, `in_progress→blocked`, `blocked→in_progress`, `blocked→completed`. (`→cancelled` is **not** assignee-allowed.)
- **Assigner / admin / hr** may additionally `→cancelled` (reason required) and full-edit.
- No-op moves allowed (idempotent PUT).

---

## 4. Data model changes (additive)

```sql
-- work_assignments (additive; legacy rows keep NULLs and render fine)
ALTER TABLE work_assignments ADD COLUMN IF NOT EXISTS blocked_reason  TEXT;
ALTER TABLE work_assignments ADD COLUMN IF NOT EXISTS cancel_reason   TEXT;
ALTER TABLE work_assignments ADD COLUMN IF NOT EXISTS started_at      TIMESTAMP;   -- set on first in_progress
ALTER TABLE work_assignments ADD COLUMN IF NOT EXISTS cancelled_at    TIMESTAMP;   -- set on cancel
-- status CHECK gains 'blocked'
ALTER TABLE work_assignments DROP CONSTRAINT IF EXISTS work_assignments_status_check;
ALTER TABLE work_assignments ADD CONSTRAINT work_assignments_status_check
  CHECK (status IN ('assigned','in_progress','blocked','completed','cancelled'));

-- NEW: activity trail
CREATE TABLE IF NOT EXISTS work_assignment_events (
    id            SERIAL PRIMARY KEY,
    assignment_id INT NOT NULL REFERENCES work_assignments(id) ON DELETE CASCADE,
    actor_id      INT REFERENCES employees(id) ON DELETE SET NULL,
    type          VARCHAR(30) NOT NULL,   -- created | status | edit | reassigned | commented
    from_status   VARCHAR(20),
    to_status     VARCHAR(20),
    note          TEXT,
    created_at    TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wae_assignment ON work_assignment_events(assignment_id, created_at DESC);
```

Placed in **all three layers**: `server/schema.sql`, startup migration in `server/index.js`,
and `schemaRepair.js` (`ENSURE_TABLE_DDL` + `PROJECT_MODULE_COLUMNS` for `work_assignments`).

---

## 5. API changes (backwards compatible)

| Route | Change |
|-------|--------|
| `GET /` / `GET /my` | SELECT gains `blocked_reason`, `cancel_reason`, `started_at`, `cancelled_at`. Accept `?q=` search, `?priority=`, `?limit=`/`?offset=` (default limit keeps response size bounded). |
| `POST /` | unchanged contract; writes a `created` event; notifies assignee. |
| `PUT /:id` | Assignee restricted to the legal status moves (D-A2/A3); `cancel` requires `cancelReason`; `blocked` requires `blockedReason`; writes a `status`/`edit` event; notifications on status change. |
| `DELETE /:id` | assigner/admin only (unchanged) + writes a final `deleted` audit event. |
| `GET /:id/events` | **new** — activity timeline (assigner, assignee, admin, hr). |
| `GET /:id/logs` | **new** — linked daily-work-log roll-up (count + recent), scoped like the assignment. |

All new reads are gated by the same access rule as `PUT` (assigner/assignee/admin/hr).

---

## 6. UI changes

### 6.1 `/manager/team-work`
- Filter bar: status chips (All/Assigned/In Progress/Blocked/Completed/Cancelled/Overdue) + **assignee**, **project**, **priority** selects + **search** box; **Load more** pagination.
- Card click → **detail drawer**: full meta, **timeline**, linked daily-log roll-up, actions (Edit/Withdraw for assigner/admin; status moves where relevant).

### 6.2 `/employee/my-work`
- Card gains status incl. **Blocked** (with reason) and a compact **timeline** on the detail view.
- Actions: **Start / Mark Complete / Blocked (reason) / Unblock**. No Cancel (D-A2).

### 6.3 Admin dashboard widget
- Add a **Blocked** count chip alongside Open/In Progress/Completed/Overdue.

---

## 7. Backwards compatibility / legacy data

- Every new column is nullable; the SELECT already `COALESCE`s legacy `start_date`/`assigned_at`, so old rows keep rendering.
- `work_assignment_events` self-heals on first write (and via `schemaRepair`), so the timeline works on a cold instance.
- Existing statuses remain valid (`assigned/in_progress/completed/cancelled`); only `blocked` is added.
- No data backfill required; events start from the redesign forward.

---

## 8. Phases & gates

| Phase | Scope | Gate |
|-------|-------|------|
| **P0** ✅ | Hotfix W-01 + W-02 | `node --check`, shipped `167b621`, deploy green |
| **P1** ✅ (as Increment 1) | Status semantics (`blocked` + reasons, cancel rules, actual timestamps) + counterpart notifications + audit hardening (H1–H3, M1–M6, M9–M12, L7/L8) across all three schema layers + UI (My Work / Team Work / admin dashboard chips) | `node --check` + inline-JS gate green; **QA harness 38/38 green** (see §9) |
| **P2** | Team Work + My Work UI redesign depth (detail drawer, timeline) — server: `work_assignment_events` + `GET /:id/events` + `GET /:id/logs` | `node --check` + inline-JS check + live QA |
| **P3** | Filters/search/pagination + daily-log roll-up | live QA |
| **P4** (later) | Bulk assign, optional comments | — |

Each phase = one atomic commit → push master → verify live.

---

## 9. Verification record

### Increment 1 (this feature) — `scripts/qa-work-assignments-v2.cjs` → **38/38 green**

**Method.** The harness seeds a throwaway world (temp admin/manager/employee/victim +
assignments + daily logs) via SQL, drives the running server's API with `fetch`
(logins + tokens + full role matrix), then deletes every temp row (direct SQL) — the
classic "roll the world back, DB stays pristine" pattern. It also exercises the H2
permanent-delete path end to end (deleting the temp assignees through the real admin
endpoint), which is exactly the purge transaction that used to 500 on the WA FKs.

**Environment honesty.** This machine had no reachable Postgres: `.env`'s
`DATABASE_URL` (127.0.0.1:5433) was down, the local `postgresql-x64-16` service on
5432 rejected the app credentials, and no prod Supabase creds exist locally. Instead
the harness ran against a **hermetic throwaway local Postgres 16** (`initdb` → load
`server/schema.sql` → boot `npm start` → run harness → `pg_ctl` stop + delete cluster).
That is real Postgres (FKs, CHECKs, TOCTOU updates, CASCADE/SET NULL all enforced),
so the route + SQL behavior is verified with true pg semantics; it is not the
deployed prod DB. Schema startup migrations also ran green against the pristine
cluster ("work_assignments ensured" / "daily_work_logs ensured", no warnings),
validating the M12 three-layer migration SQL.

**Assertions covered (38):** logins ×4 roles · manager create ×2 (201) · born-closed
POST rejected (400) · `GET /my` isolation each way · assignee start + `started_at`
(200) · block without reason (400) · block with reason + persist (200) · assignee
cancel denied (403) · assignee field-edit denied (400) · unrelated employee PUT
denied (403) · assigner cancel-without-reason (400) · unblock clears reason (200) ·
assigner cancel + `cancelled_at` (200) · terminal locked (400) · due<start (400) ·
partial due-only vs legacy start date (400) · **H1** cross-user log link (404) ·
own link (201) · log `work_date` PUT honored (200) · garbage date 400 / lenient
coercion 201 · assignee delete denied (403) · assigner delete (200) · **H2**
permanent delete of both assignees through the admin API (200) · full row purge
verified (assignments/logs/employees all 0).

**Limiter note.** The login route allows 10 attempts/15 min/IP; the harness needs 4
logins per run, so reruns within the window require a server restart (in-memory
limiter). This was hit during development and is expected behavior, not a defect.

**Not covered yet (Increment 2/3):** timeline events, filters/search/pagination,
daily-log roll-up, D11 team-lead tree/project-scope paths (need a project + leads
world), bulk assign/comments.
