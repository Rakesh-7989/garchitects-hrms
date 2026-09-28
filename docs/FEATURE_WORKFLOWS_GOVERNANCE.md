# Workflow Release — Governance Features (A/B/C)

> Audit record for the three governance workflows shipped on `master` (`125e9ae`):
> **A** cross-team transfer requests · **B** TL leave-handover with cover lead ·
> **C** project read-access request / approval / grants.
>
> Preceded by a deep-dive (notifications/push capabilities, `work_assignments`
> schema, `schemaRepair` self-heal, employee read-scoping routes) and a plan
> reviewed with the user, then implemented per the repo's step-by-step rule
> (deep-dive → plan → implement), with syntax gates and a live QA harness.

---

## 1. Why these workflows ship

The existing modules give leads the *structure* to place people into projects
and units, and employees a *daily-update* loop. What was missing — and what
this release adds — are the three cross-cutting **governance** actions that a
studio lead/manager actually performs every week:

| Id | Workflow | Outcome |
|----|----------|---------|
| A | Cross-team employee transfer requests | An employee moves **teams** (reporting manager changes) with the **source TL's release approval** |
| B | TL leave / absence handover | An absent lead names a **cover lead** (must accept) who can **read + post status updates** on their projects for the window — *not* restructure them |
| C | Project read-access request/approval | Anyone may **request read access** to a project they don't lead / aren't assigned to; a whole-project lead or manager/admin approves; **employees** actually see the granted project in My Projects + status-update feed |

### Governance model this is built on (established in prior sessions)

- **manager / admin** — structure + designation powers (place, assign leads)
- **team_lead** — led-units placement/updates for their own projects
- **HR** — read-only on the projects module (monitor views only)
- **employee** — daily updates + see own projects/status

---

## 2. Feature A — Team Transfers (`/api/team-transfers`)

### Rules
- **Creator**: `team_lead` / `manager` / `admin` only. **HR** = read-only monitor.
  **Employees** = 403 (a transfer is always requested by a lead/manager).
- **Target**: any *active* employee who reports to a *different* current RM
  (not yourself, not an admin).
- **Approver**: the employee's **CURRENT** reporting manager, or any
  **manager/admin** (oversight). The request's `from_tl_id` snapshot must still
  equal `employees.reporting_manager_id` — otherwise **stale** (400) and the
  requester must raise a fresh request.
- **Duplicate guard**: one pending request per (employee, requester).
- **Approve** → `employees.reporting_manager_id = to_tl_id` (the reporting tree
  moves; the requester can now place/assign work).
- **Cancel**: requester, `from_tl`/`to_tl` participants, or admin.
- **Notifications**: web push (best-effort) to source TL + managers/admins on
  request, and to requester/employee/oversight on approve; bell
  `pendingTransfers`.

### Endpoints
| Route | Access |
|---|---|
| `GET /api/team-transfers/my` | TL/manager/admin (their raised + to-release requests) |
| `GET /api/team-transfers` | manager/admin/hr monitor |
| `GET /api/team-transfers/candidates` | TL/manager/admin (active employees in other RM teams) |
| `POST /api/team-transfers` | TL/manager/admin |
| `POST /api/team-transfers/:id/approve` / `reject` | current RM or manager/admin |
| `POST /api/team-transfers/:id/cancel` | requester/RM/admin |

---

## 3. Feature B — Team Handovers (`/api/team-handovers`)

### Rules
- **Creator**: the **absent TL** (self) or **manager/admin on their behalf**.
  HR read-only; employees 403.
- **Cover lead**: any *active* `team_lead` / `manager` (≠ absent). Must
  **accept** → `pending` → `active` (window `[start_date, end_date]`).
- **Overlap guard**: no pending/active handover for the same absent+cover pair
  in an overlapping window.
- **Cover powers while active** (the important guard): inherited **READ** +
  **status-update authoring** on the absent lead's led projects only —
  via `coversProjectArea()` in `project-leads.js`. **Structural powers**
  (`/place`, designate, transfers) stay **lead-only** — a cover TL has no
  `project_leads` row, so `POST /projects/:id/employees` refuses them.
- **Manager/admin notified at every step** and may **cancel** anytime;
  absent/cover involved leads may cancel pending/active too.
- **Lazy expiry**: active rows with `end_date` in the past are flipped to
  `ended` on the next read (`expirePastHandovers`).
- Views: covered projects appear in `GET /project-leads/mine` with a
  `coveringFor` header (rendered on My Led Projects as a read-only banner).

### Endpoints
| Route | Access |
|---|---|
| `GET /api/team-handovers/my` | TL/manager/admin (as absent or cover) |
| `GET /api/team-handovers` | manager/admin/hr monitor |
| `GET /api/team-handovers/covers-options` / `leads-options` | pickers for the create form |
| `POST /api/team-handovers` | TL (self) / manager/admin (any absent lead) |
| `POST /api/team-handovers/:id/accept` / `decline` | the cover lead only |
| `POST /api/team-handovers/:id/cancel` | involved leads / manager/admin |

---

## 4. Feature C — Project Access (`/api/project-access`)

### Rules
- **Requester**: any authenticated user.
- **Scope**: `role` (grant mirrors the requester's own role level via
  `mapRoleToLevel`) or `extended` (requires `requested_role` ∈
  employee | team_lead | manager; product cap — extended cannot exceed a
  designated role bucket and is audited).
- **Approver**: the project's **whole-project lead** (`unit_id IS NULL`), or any
  **manager/admin**. A unit-level lead is *not* an approver (deliberate).
- **Reject / cancel**: approver can reject; requester or admin can cancel.
- **Grant**: soft-revokable (`revoked_at`, no hard delete) by grantor /
  whole-lead / manager / admin. Optional future `expires_at`.
- **Enforcement bite (honest scope)**: a grant adds the project to the
  employee's `GET /projects/my` (as `viaGrant: true`) and to their
  `GET /project-status-updates` read scope. **Manager-class reads are already
  open today** — the approval + grant trail still applies to everyone, but for
  manager-class users the *read restriction* is future hardening, not a change
  shipped here. This is stated in the code header and in §7.
- **Bell**: `pendingAccessRequests` (TL → only whole-led projects; manager-class
  → all pending).

### Endpoints
| Route | Access |
|---|---|
| `GET /api/project-access/projects` | anyone (active catalog) |
| `GET /api/project-access/requests` | mine (anyone) / `?scope=incoming` (approver-scoped) |
| `GET /api/project-access/grants/my` | my active grants |
| `GET /api/project-access/grants` | manager/admin/hr (all); TL (whole-led only) |
| `POST /api/project-access/requests` | anyone (duplicate-pending guard) |
| `POST /api/project-access/requests/:id/approve` / `reject` | whole-lead / manager / admin |
| `POST /api/project-access/requests/:id/cancel` | requester / admin |
| `DELETE /api/project-access/grants/:id` | grantor / whole-lead / manager / admin |

---

## 5. Data model (additive, lazy-healable)

Four tables appended to `server/schema.sql` (§§25–27) **and** to
`server/utils/schemaRepair.js` `ENSURE_TABLE_DDL` so they self-heal on any
instance, like every other module table:

- `team_transfer_requests (id, employee_id→, from_tl_id→, to_tl_id→, reason,
  status check pending|approved|rejected|cancelled, decided_by, decided_at,
  created_at)` + 3 indexes
- `team_handovers (id, absent_tl_id→, cover_tl_id→, start_date, end_date,
  reason, status check pending|active|declined|cancelled|ended, requested_by,
  decided_by, decided_at, created_at, ended_at)` + 2 indexes
- `project_access_requests (id, project_id→, requester_id→, reason, scope
  check role|extended, requested_role, expires_at, status check
  pending|approved|rejected|cancelled, decided_by, decided_at, created_at)` + 2
  indexes
- `project_access_grants (id, project_id→, employee_id→, granted_by, scope,
  role_level check employee|team_lead|manager, reason, expires_at, created_at,
  revoked_by, revoked_at)` + 2 indexes

Routes use the repo-standard self-healing query wrapper
`q = (sql, params) => runWithSchemaRepair(() => query(sql, params))`; all
auditable mutations call `logAudit(...)`; realtime signal is web-push
(`sendToUser`/`sendToUsers`, best-effort) + the bell.

---

## 6. Bell integration (notifications.js)

- `/counts` returns **3 new counters** — `pendingTransfers`,
  `pendingAccessRequests`, `activeHandovers` — included in `total`. Team leads
  see only items they must act on (incoming requests / whole-led access
  requests / their cover-or-absent handovers); admin/manager/hr see all.
- `/requests` feed adds 3 sections (`type: transfer | access_request |
  handover`) with deep-link URLs: `/manager/my-team?tab=transfers`,
  `/manager/team-projects`, `/manager/my-team?tab=handover`; 'extended' access
  requests carry an explicit `EXTENDED (role)` marker.
- Sidebar badge maps (`dashboard.js`) now include my-team (transfers+handovers)
  and team-projects (access+handovers) rows for both the manager branch and the
  admin branch (skip-if-absent).

---

## 7. UI mapping

| Page | Addition |
|---|---|
| `manager/my-team.html` | **Transfers** tab (create form w/ candidate picker + reason; incoming approve/reject; my requests; monitor for mgr/admin/hr; cancel) and **Handover** tab (create form w/ absent+cover pickers, dates, reason; accept/decline; active covers; monitor; cancel). HR sees monitor-only (no action buttons). Deep-link `?tab=transfers|handover`. |
| `manager/led-projects.html` | Covered (non-lead) projects render a **"Covering for …" banner** — read + status updates only; **Assign buttons hidden** (structural block mirrors the API). |
| `manager/team-projects.html` | **Project Access** panel per selected project: incoming requests (approve/reject) + active grants (revoke); approver/revoker scoping follows the API (whole-lead/manager/admin act; HR read-only). |
| `employee/my-projects.html` | **Project Access** card: catalog picker (hides already-seen / granted projects), role-level vs extended scope selector, reason; my requests (status + cancel); my grants (level, grantor, expiry). |
| `dashboard.js` | Bell badge totals + nav badges include the 3 new counters. |

---

## 8. Verification

### Syntax gates (local, before commit)
- `node --check` on all edited backend files (index.js, notifications.js,
  project-leads.js, project-status-updates.js, projects.js, the 3 new route
  files, schemaRepair.js) — clean.
- Inline-JS checker on the 4 edited HTML pages (`check-inline-js.cjs`) —
  4/4 clean.
- `node --check public/js/dashboard.js` — clean.

### Live QA (`%TEMP%\opencode\qa-workflows-live.mjs`, against prod)
Live matrix A/B/C: creation role-guards (employee 403, HR read-only 200/403),
duplicate guards (transfer + access), "already in your team" (400), unrelated
lead approve (403), **stale guard** (approve after the employee moved → 400),
overlord approve moves the reporting manager, cancel permission matrix
(outsider 403 / requester 200 / HR 403), self-forced handover for TLs, overlap
guard (400), cover-only accept (non-cover 403), **cover CAN author status
updates on the absent lead's whole-led project (**200**) yet **CANNOT place
employees into it (403)** — the structural/read split, extended-access cap
(requested_role required, `role_level=manager` grant honored), grant
enforcement (employee pre-grant sees no P1 updates → post-grant sees them;
`projects/my viaGrant` appears → disappears after revoke), revoke permission
matrix (employee 403 / HR 403 / manager 200), bell counters
(`pendingTransfers ≥ 2` for source TL, `pendingAccessRequests ≥ 1` manager vs
`0` non-whole-lead TL), 401 without token, leak-free error messages, and a
world rollback that leaves the **DB pristine** (no `QA-TR-*` leftovers).

> The harness caught **two real production defects** on the first full pass
> (both fixed in follow-up commits `d2294d7` + `c9c2412`):
> 1. **`project-status-updates.js`** — the employee GET scope pushed the
>    assigned-project and grant conditions as *two* array entries joined with
>    `AND`, making visibility the **intersection** of assigned ∪ granted. A
>    grant alone (employee not assigned) never surfaced the project's updates,
>    defeating Feature-C enforcement. Now a single `(assigned OR granted)`
>    condition.
> 2. **`notifications.js /requests`** — the new transfer/access/handover feed
>    sources called `safe()` but that helper only existed *inside* the `/counts`
>    route. Evaluating the `Promise.all` array threw `ReferenceError: safe is
>    not defined` synchronously → the whole bell feed 500'd for every role
>    (reproduced: admin AND manager). Fixed by hoisting a module-scope `safe`
>    that returns `{ rows: [] }` on a failing source (a feed source can never
>    break the bell). `/counts` keeps its local count-shaped `safe` (shadowed).
>    Post-deploy probe: `/api/notifications/requests → 200`.

> The harness was first re-run after a login-limiter debounce (the limiter is
> ~10 logins/IP/15 min; the first attempt bled the budget).

**Result (2026-09-28, live prod `garchitects-hrms.vercel.app`):** ✓ **68/68
passed, 0 failed**, including both assertions that failed pre-fix on the first
full pass (A-21 bell feed → 200 with 3 items; B-08 cover-TL authoring → 200).
DB pristine after rollback (0 `QA-TR-*` employees / 0 QA projects).

### Regression suites re-run against live prod (same day, 0 failures)
- **Split-mode** (`qa-split-mode-live.mjs`) — **29/29** — placement/lead
  scoping untouched by the governance changes.
- **Status-updates** (`qa-status-updates-live.mjs`) — **34/34** — authoring
  role-gates + GET scoping (SU-13 assigned sees 4 / SU-14 unassigned sees 0)
  preserved after the OR-grant scope fix.

### Updates-visibility UI pass (2026-09-28, no backend changes)
User asked (Telugu): "updates koda projects lo chupisthe better" — project
updates were buried behind buttons/tabs. Shipped inline visibility across the
three projects pages (commit `ca7d90b` on `master`):

| Page | What changed |
|------|--------------|
| `manager/team-projects.html` | Selected-project panel gains a **"Latest activity" strip** (newest STATUS note + newest team DAILY note) plus an **"Activity timeline"** tab that merges status notes (`/project-status-updates`) and team daily work-notes (`/project-updates`) into one chronological feed with STATUS/DAILY tags + per-unit chips. Status notes still have their dedicated tab (composer + edit/delete). Both feeds refresh after post/edit/delete. |
| `manager/led-projects.html` | Each led-project card shows an inline **"Latest activity"** strip (newest status + newest daily from the team) right on the card — no modal click needed; a small "Open updates" button still deep-links to the full modal feed. |
| `employee/my-projects.html` | The per-card **"Updates (N)"** block now renders the **full list** of management status notes for that project (scrollable, newest-first) instead of a single "Latest" line. |

Role scoping is untouched (reads only; employee cards still only surface updates
the GET scope already returns — assigned ∪ granted projects). Daily notes on
manager pages are read-only views (employees/admins author through their own
flows). Gates: inline-JS checker 3/3 clean; `formatDate`/`escapeHtml` from
`auth.js` used consistently.

---

## 9. Known, honest limits (not shipped yet)

1. **C enforcement for manager-class users** is a trail, not a read-wall yet (see
   §4). A manager/admin who is granted access is not *blocked* anywhere extra —
   their existing manager reads are unchanged. Only employee visibility gained
   real bite. Approved + noted.
2. **B lazy expiry** flips past-window active rows to `ended` on read; there is
   no cron job — a row stays `active` until someone reads it. Acceptable for a
   studio tool (banner mis-stale only if nobody visits the page).
3. **Web push** is best-effort and only reaches connected clients; the bell is
   the durable signal.
4. Transfers move the reporting tree but do **not** auto-reassign existing
   `project_employees` rows; placing the transferred employee into work is the
   requester's follow-up step (matches the "requester then assigns/places"
   requirement).

---

*Plan/discussion in Telugu with the user preceded this build; code comments and
UI copy follow the repo's Telugu-roman convention where relevant.*