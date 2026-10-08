# QA Audit — Employee "My Info" Portal (9 pages)

**Role:** QA Engineer agent · **Date:** 2026-10-09 · **Repo state:** read-only audit (only this file written; app not run)

**Scope:** the nine pages of the employee sidebar's *My Info* section
(`public/pages/employee/dashboard.html:72-81`) — `profile`, `onboarding`, `my-projects`,
`my-work`, `attendance`, `regularization`, `leave`, `wfh`, `payslips`
(all under `public/pages/employee/`).

**Method:** static point-by-point read of each page against its server routes across five
dimensions — **A** client↔server contract, **B** server guards/scoping/error hygiene,
**C** date-safety, **D** role/parity, **E** error-paths — plus a full `apiCall` inventory of
the nine pages (43 call sites). Prior audits (`qa/audit-contract.md`, `qa/audit-security.md`,
`qa/audit-schema.md`) are **folded in, not re-derived**; §5 lists every prior F-number this
report references instead of restating.

---

## 1. Summary — page × dimension

Legend: ✅ sound · ⚠ new finding (MI-x) · ◆ carries a prior-audit defect (referenced, not re-counted)

| Page | A contract | B server guards | C dates | D roles/parity | E error-paths | Verdict |
|---|---|---|---|---|---|---|
| **profile** | ✅ | ⚠ MI-3 | ⚠ MI-1 | ✅ | ✅ | **Issues (2)** |
| **onboarding** | ✅ | ✅ | ✅ | ✅ | ✅ | **Sound** |
| **my-projects** | ✅ | ⚠ MI-4 | ⚠ MI-1, MI-6 | ✅ | ⚠ MI-2 | **Issues (4)** |
| **my-work** | ✅ | ✅ | ⚠ MI-1 | ✅ | ✅ | **Issues (1)** |
| **attendance** | ✅ | ✅ | ⚠ MI-1, MI-5 | ✅ | ⚠ MI-2 | **Issues (3)** |
| **regularization** | ✅ | ◆ sec-F6 (create unaudited — not re-counted) | ⚠ MI-1 | ✅ (F3 is manager-side only — §3-D) | ✅ | **Issues (1)** |
| **leave** | ✅ | ✅ | ⚠ MI-1, MI-5 | ✅ | ⚠ MI-2 | **Issues (3)** |
| **wfh** | ✅ | ✅ | ◆ schema-F6 (consumer via `formatDate`, §5) | ✅ | ✅ | **Sound (carries F6)** |
| **payslips** | ✅ | ✅ | ✅ | ✅ | ✅ | **Sound** |

**Totals: 7 findings — 4 MEDIUM · 3 LOW · 0 HIGH/CRITICAL.** 6 of 9 pages carry at least one
new finding; 3 pages (onboarding, payslips, wfh) are sound for this audit's scope. No
dimension-A (contract shape) and no dimension-D (role/parity) defects found.

---

## 2. Findings

| ID | Sev | Dim | Page(s) | Evidence (`file:line`) | Impact | Fix |
|---|---|---|---|---|---|---|
| **MI-1** | MEDIUM | C | attendance, leave, my-work, my-projects, regularization, profile (6 of 9) | `holidays.js:64` (`SELECT *`, raw `DATE`) → `attendance.html:262`, `attendance.html:428`, `leave.html:165`; `leave.js:214-224` raw → `attendance.html:172-173`; `work-assignments.js:31-32` raw `start_date/due_date` → `my-work.html:201`, `my-work.html:370`, `my-work.html:421`; `daily-work-logs.js:54` `dw.*` raw → `my-work.html:370`; `projects.js:45` raw `start_date/end_date` → `my-projects.html:270`; `project-updates.js:81-94` raw `update_date` → `my-projects.html:426`; `project-access.js:116` raw `g.expires_at` → `my-projects.html:608`; `regularization.js:71` `SELECT r.*` → `regularization.html:365`; `auth.js` `/auth/me` raw DOB → `profile.html:358` | Raw `DATE` serializes at server-local midnight → UTC ISO. String-slice consumers yield **previous-day dates** on any server east of UTC (IST dev machine — the incident recorded in AGENTS §11); `my-work.html:201` flips "overdue" a day early on such hosts. Production (Vercel/UTC) currently safe. Extends audit-schema **F6** beyond its leave/WFH scope (§5). | Normalize every `DATE` with `dateOnly()` in the route SELECT/serializer — the model already in-repo: `attendance.js:486,534` (`server/utils/date.js`). One-line change per site. |
| **MI-2** | MEDIUM | E | attendance, leave, my-projects | `attendance.html:236`→`311-312`; `leave.html:191`→`210-211`; `leave.html:164-166` (→ `283-292`); `my-projects.html:224-227`; `my-projects.html:234-235`; `my-projects.html:397-399`; `my-projects.html:504`; `my-projects.html:598-599` | On a failed fetch (HTTP error bodies are returned **un-toasted** by `apiCall`, `auth.js:197-199`), the pages render a *false fact* instead of an error: "No attendance records for this period", "**No leave types configured**", "no projects assigned", My-Updates card hidden, daily-report banner never shown, management status notes silently absent — and a failed `/holidays` load makes the **sandwich-leave warning vanish** (`HOLIDAY_DATES=[]`), so the employee under-estimates the deduction. No page ever goes fully blank (see §3-E), but transient failure is indistinguishable from permanent truth. | Three-way branch every loader: `data == null` → explicit Retry card; `!data.success` → error card with the server message; empty array → empty state. Prioritize `leave.html:191` and `leave.html:164`. |
| **MI-3** | MEDIUM | B | profile (server: `auth.js`) | `auth.js:826-829` SELECT checks `status='pending'`, then `auth.js:835-839` runs `UPDATE … SET status='cancelled'` **unconditionally** (no `AND status='pending'`, no row-count check); create route `auth.js:739` and cancel `auth.js:824` have **no `logAudit`** (only `auth.js:289,308,342,555` log) | TOCTOU: an employee's cancel racing an admin's approval can overwrite `approved → cancelled` after the PII write already happened (or leave the request state inconsistent with reality), violating AGENTS §5's conditional-update rule. The mutation is also invisible to the audit trail — `profile-request` create/cancel are **missing from audit-security F6's list** (§5). | `UPDATE … WHERE id=$1 AND employee_id=$2 AND status='pending'` + `rowCount` check → 409 on race (the repo model: `leave.js:383` `FOR UPDATE` + status check); add `logAudit` to create + cancel. |
| **MI-4** | MEDIUM | B | my-projects (server: `project-access.js`) | `project-access.js:255-258` SELECT pending → approve: INSERT grant `:292-296` + `UPDATE … WHERE id=$2` `:297` (no status guard, no row count); reject `:274` and cancel `:264` likewise unguarded; cancel branch `:260-265` has **no `logAudit`** while approve `:298`, reject `:275`, revoke `:334` all do | Two concurrent approvals both pass the pending check → **two `project_access_grants` rows** for one request, both callers get 200; approve∥cancel can leave an active grant under a `cancelled` request. Violates AGENTS §5. Cancel is the unaudited hole in an otherwise audited workflow. | Take the conditional `UPDATE … AND status='pending'` first, check `rowCount` (loser → 409), then insert the grant — in one transaction; add `logAudit` to cancel. |
| **MI-5** | LOW | C | attendance, leave | `leave.html:261` + `leave.html:272` (`isWeekOff(start)` via `getDay()` on a UTC-parsed date), `leave.html:276-280` (fallback weekday loop); `attendance.html:320` + `attendance.html:364` (`d.getDay()` for the Day column); root helper `formatDate` at `auth.js:318-324` (`new Date()` + `toLocaleDateString`) | Weekday/weekday-rendered dates computed in **browser TZ**: correct for IST/UTC users, wrong for a browser west of UTC (previous day's weekday — wrong "start falls on weekly off" warning; wrong Day column; `formatDate` on date-only keys shifts a day). Distinct mechanism from F6 (browser-TZ, not server-TZ — see the direction note in §5). | Parse date-only keys without TZ conversion (split `YYYY-MM-DD` into numbers, or render at local noon / use `getUTCDay()`); make `formatDate` date-only-aware. |
| **MI-6** | LOW | C | my-projects | `my-projects.html:627` `new Date().toISOString().substring(0, 10)` for the "today" gate on access-request dates — while the same page already uses the correct helper at `my-projects.html:260` and the helper's own doc-comment forbids exactly this pattern (`auth.js:326-331` `getTodayIST`) | UTC "today" ≠ IST "today" between 00:00–05:30 IST → client-side date validation is off by one in that window. Advisory only — the server re-validates expiry vs IST (`project-access.js:208` `dateOnly(…) <= istDateString()`), so no server-side impact. | Use `getTodayIST()` (already imported/used on the same page at `:260`). |
| **MI-7** | LOW | E | all 9 | `auth.js:166-170` (timeout only when `opts.timeoutMs` is passed) — **zero** of the 43 `apiCall` sites in the nine pages pass it (only `dashboard.html:487` does, with retries) | A hung/slow request (cold Vercel instance — a failure mode already recorded and fixed for the dashboard in AGENTS §11) leaves loaders spinning with no timeout and no Retry affordance, indefinitely on an open socket. | Pass `{ timeoutMs: 15000 }` on page-initial loads (or add a default timeout + Retry in `apiCall`), mirroring `dashboard.html:482-487`. |

### 2b. Finding detail — MI-1 instance map (server raw `DATE` → client consumer)

| Server serves raw `DATE` | Client consumer on a My Info page | Client mechanism | Breaks when |
|---|---|---|---|
| `holidays.js:64` `SELECT * FROM holidays` (has `fmtDate` at `:12` but only create/audit paths use it — `:36,:146,:190`) | `attendance.html:262`, `attendance.html:428`, `leave.html:165` | `.split('T')[0]` / `.substring(0,10)` | **Server** east of UTC |
| `leave.js:214-224` `SELECT la.*` (audit-schema F6's route) | `attendance.html:172-173` `expandLeaveDays()` — a consumer F6 did **not** list (F6 cites only `manager/my-team.html:547-548`) | `.split('T')[0]` | server east of UTC |
| `work-assignments.js:31-32` (shared `SELECT`) | `my-work.html:201` (`due_date.slice(0,10) < getTodayIST()` — mixed clocks), `my-work.html:370,421` (`work_date`) | `.slice(0,10)` | server east of UTC |
| `daily-work-logs.js:54` `SELECT dw.*` (writes normalize at `:137,:177`; reads don't) | `my-work.html:370`, `my-work.html:421` | `.slice(0,10)` | server east of UTC |
| `projects.js:45` (no `dateOnly` anywhere in the file) | `my-projects.html:270` | `.slice(0,10)` | server east of UTC |
| `project-updates.js:81-94` | `my-projects.html:426` | `.slice(0,10)` | server east of UTC |
| `project-access.js:116` raw `g.expires_at` (route *imports* `dateOnly` at `:26` but not for this SELECT) | `my-projects.html:608` | `.slice(0,10)` | server east of UTC |
| `regularization.js:71` `SELECT r.*` | `regularization.html:365` `formatDate(r.date)` | `formatDate` (browser TZ) | browser west of UTC |
| `auth.js` `/auth/me` DOB | `profile.html:358` (guarded by `.includes('T')`, still TZ-dependent when present) | `.split('T')[0]` | server east of UTC |

**Answer to the F6 spot-check (must-verify item):** `leave.html` and `wfh.html` do **not**
contain the literal `split('T')[0]`-on-raw-leave-date pattern. They consume F6's raw
`DATE`s through `formatDate()` instead — `leave.html:237-238,243` and `wfh.html:170-171,176` —
which is the browser-TZ-west variant (MI-5), not the string-slice variant. The string-slice
variant *does* appear on an employee page via a leave-route consumer: `attendance.html:172-173`
(listed above). One additional slice on these two pages: `leave.html:165` slices raw
holidays (same class, MI-1). The underlying routes remain F6's finding and are not
re-reported.

### 2c. Answer to the F3 spot-check (must-verify item)

The employee **regularization page shows no approve/reject UI**: it renders status badges
only (`regularization.html:360-362`) plus the reviewer's note (`regularization.html:368`),
and calls only `POST /regularization` + `GET /regularization/mine`
(`regularization.html:334,351`). The Approve/Reject buttons that trigger F3 live solely on
`public/pages/manager/my-team.html:461-464,1003-1030`. **Employee side of F3: sound**;
F3 remains a manager-portal finding. `/regularization/mine` is self-scoped
(`regularization.js:74-76` `WHERE r.employee_id = $1`).

---

## 3. Verified sound (what was checked and passed)

### A — Client↔server contract
All 43 `apiCall` sites in the nine pages resolve to routes whose response keys match the
client reads. Specifically verified for endpoints `audit-contract.md` did **not** row:
`regularization/mine → requests` (`regularization.js:78` ↔ `regularization.html:354`),
`wfh/my → wfhRequests` (`wfh.js:249` ↔ `wfh.html:163`),
`project-access` `projects/requests/grants` (`project-access.js:61,102,127` ↔
`my-projects.html:546,557,598`), `daily-work-logs → logs` (`daily-work-logs.js:85` ↔
`my-work.html:355`), `onboarding/my → process/tasks` (`onboarding.js:53` ↔ `onboarding.html:184`),
`payroll/my → payslips` (`payroll.js:1030` ↔ `payslips.html:193`),
`project-updates → updates` (`project-updates.js:95` ↔ `my-projects.html:397`).
The rest are already proven MATCH by `audit-contract.md` contract rows 1, 2, 5, 6, 8, 10,
15, 16, 25 (`:288-330`).

### B — Server scoping / guards (read and confirmed)
- `leave.js:220-222` (`/my`) and `leave.js:432-438` (`/balance`) self-scoped; `leave.js:383,409`
  cancel is the repo's **TOCTOU model** (`FOR UPDATE` + status check + `logAudit`) — the pattern
  MI-3/MI-4 should copy.
- `payroll.js:1020` `WHERE p.employee_id = $1`; `payroll/:id` via `fetchPayslipWithProfile`
  scoping (`payroll.js:1258`).
- `work-assignments.js:86-95` `/my` assignee-scoped; PUT has assignee/editor guard
  (`:319-328`), assignee-status-only restriction (`:370-374`), TOCTOU 409 (`:467-473`),
  `logAudit`.
- `daily-work-logs.js:166-169,212-215` owner guards + FK-oracle guard (`:28-36`) + full audit
  trail (`:151,:197,:216`).
- `attendance.js:568-570` miss-reason own-row guard, `:571-573` `auto_checkout` guard,
  `:579-583` `logAudit`.
- `onboarding.js:96-103` complete: own-process + `assignee_role='employee'` guard.
- `project-updates.js:46-49` employee GET = **own rows only** (not org-wide); PUT owner/admin
  guard `:238-241` + audit `:265`.
- `project-status-updates.js:49-58` scopes employees to assigned/granted projects.
- `projects.js:52-117` `/my` = assigned ∪ active grants.
- `project-access.js:208` expiry validated server-side against IST; `:261-263` cancel
  requester-or-admin; `:269-271` approve approver-scope (MI-4 covers the *race*, not the guard).
- `auth.js:739` profile-request create has `blockAdminSelfService` (audit-security F9 confirms
  the mount).
- **No employee page calls any admin/HR-only endpoint** (full `apiCall` inventory §2-A;
  `/payroll/all`, `/leave/all`, `/attendance/all`, `/regularization/pending`,
  `/regularization/:id/review` never called from these pages).

### C — Date-safety (the parts that are right)
- Attendance reads are normalized server-side (`attendance.js:486,534` `dateOnly()`), so the
  many `.split('T')[0]` sites on `attendance.html:264,321,389,426` are no-ops on plain
  `YYYY-MM-DD` — **the model the other routes should follow**.
- `my-projects.html:260` defaults the update date to `getTodayIST()`; `getTodayIST` itself
  documents the trap (`auth.js:326-331`).
- `leave.html:261-292` sandwich/business-day math round-trips consistently for IST/UTC
  browsers (weekday direction issue only → MI-5).

### D — Role / parity
- F3 answered in §2c — employee page sound.
- Frontend nav is role-filtered by `auth.js` `applyRoleNav()`; the nine pages expose only
  self-service actions (apply/submit/cancel-own/edit-own/complete-own), each with a matching
  server guard listed in §3-B. No page renders a hidden admin affordance that the server would
  then 403 (the F2/F7 class from `audit-contract.md` is admin-portal-side, not here).

### E — Error-paths: no page can go silently blank
Every loader renders data, an explicit error state, or an explicit empty state — verified
explicit error states at `profile.html:342-348,441,480,585`, `onboarding.html:179-181`,
`payslips.html:189-191,231-233,251`, `my-work.html:207-210,350-353`,
`regularization.html:372-374`, `wfh.html:181-183`, `leave.html:248-249`
(history), `attendance.html:413-415` (miss-reason toast with server message), and
`my-projects.html:547-549` (access-panel projects). `apiCall` itself toasts network errors
(`auth.js:202-207`) and redirects on 401 (`auth.js:175-182`). The residual silent window is
**HTTP-error bodies with JSON** (returned un-toasted, `auth.js:197-199`) → that is exactly
what MI-2 enumerates; MI-7 covers the no-timeout stall.

---

## 4. Coverage note — which of these nine pages have automated proof

Source: `qa/audit-contract.md:338-377` (coverage table + totals), `qa/rbac-matrix.json`
(34 guard rows + 4 no-token 401 sweeps), `scripts/qa-*.cjs` (4 harnesses).

| Page (key endpoints) | Matrix rows | Harness | Gap rating |
|---|---|---|---|
| **attendance** — `/attendance/my`, `/holidays`, `/leave/my`, `/attendance/miss-reason` | `att-my` + `att-checkin`/`att-checkout` + 401 sweep on `/attendance/my` | `qa-attendance-checkin-status` (24), `qa-attendance-break-finalize` (41), `qa-attendance-my-readpath` (15) | **LOW** — best-covered module; `miss-reason` itself has no row/harness assertion |
| **my-work** — `/work-assignments/my`, `PUT /work-assignments/:id`, `/daily-work-logs` CRUD | **none** for both modules | `qa-work-assignments-v2` (38) covers work-assignments only | **MEDIUM ×2** — harness green but 0 guard rows (work-assignments); daily-work-logs ownership guards entirely unprobed |
| **my-projects** — `/projects/my`, `/project-status-updates`, `/project-updates`, `/team-updates/me`, `/project-access/*` | `proj-my` only | none | **HIGH ×4** — `project-updates`, `project-status-updates`, `project-access`, `team-updates` have **zero rows and zero harnesses** (audit-contract `:365-371`) — the read logic feeding every project card is unasserted |
| **leave** — `/leave/balance`, `/leave/types`, `/leave/my`, `POST /leave/apply` | `leave-apply` (+401 sweep), `leave-list` (admin surface) | none | **MEDIUM** — balance/my/types/history reads untested (`:343`) |
| **wfh** — `/wfh/my`, `POST /wfh/apply` | **none** | none | **HIGH** — entire employee WFH flow unasserted (`:344`) |
| **regularization** — `POST /regularization`, `GET /regularization/mine` | `regularize` (POST only, `rbac-matrix.json:30`) | none | **MEDIUM** — `/mine` self-scoping + admin-only review (F3) unprobed (`:373`) |
| **payslips** — `/payroll/my`, `/payroll/:id` | `payroll-list`/`payroll-gen` (admin surfaces only) | none | **MEDIUM** — employee read scoping (`:1020`) unprobed (`:345`) |
| **profile** — `/auth/me`, `/auth/profile-request[+/cancel]`, `/auth/profile-requests`, `/auth/set-password` | **none** (auth module has no rows) | none (login implicit) | **MEDIUM** (auth `:374`) — profile-request lifecycle (create → approve → cancel, i.e. MI-3's race) wholly unprobed |
| **onboarding** — `/onboarding/my`, `POST /onboarding/tasks/:id/complete` | `onboarding-tasks` (forbidden cells only) | none | **MEDIUM** — employee complete path skipped by design (`:358`) |

Cross-cutting: `audit-contract` **F4** (16 modules zero coverage) and **F5** (no UI↔API
contract test exists anywhere) explain why the gaps above persist — none of MI-1…MI-7 would
survive a single contract/harness pass per page.

---

## 5. Folded in from prior audits (referenced, NOT re-reported)

| Prior finding | Relevance to these 9 pages |
|---|---|
| **audit-schema F6** (raw `DATE` on leave/WFH routes, `split('T')` off-by-one) | Root cause behind the wfh/leave `formatDate` consumers and `attendance.html:172-173`; **MI-1 extends the same class** to holidays/work-assignments/daily-work-logs/projects/project-updates/project-access/regularization/auth-DOB rather than restating F6. **Direction correction:** F6's text (`audit-schema.md:125`) says the breaking host is *west* of UTC — for the string-slice mechanism the breaking **server** is one whose local offset is **east** of UTC (IST dev machine → `DATE '2026-10-07'` → `'2026-10-06T18:30Z'`, the exact AGENTS §11 incident). West-of-UTC applies to the *browser-side* `formatDate`/`getDay` variant → MI-5. |
| **audit-security F6** (unaudited applies: leave `:48`, wfh, regularization `:16`) | Still open on these pages' apply flows — **not duplicated**. MI-3 adds `auth.js` `profile-request` create/cancel (missing from F6's table); MI-4 adds `project-access` cancel. |
| **audit-security F10** (~20 route files bypass `pgErrorResponse`) | Applies to routes these pages hit with generic `500 'Server error'` catches (`holidays.js:77`, `regularization.js:81`, `payroll.js:1033`, `attendance.js:587`, `auth.js:844`) — no leak, just bypasses the mapper; folded, not re-counted. |
| **audit-contract F3** (manager My Team shows Reg. Approve/Reject; API admin-only) | Employee side verified **sound** (§2c) — no approve/reject UI on `regularization.html`. |
| **audit-contract F4 + F5** (zero coverage modules; no contract tests) | Quantified per page in §4. |
| **audit-contract F9** (bell badge omits `pendingRegularizations`) | Approver-side visibility issue (admin/manager bell), outside these nine pages — noted for completeness. |
| **AGENTS §11 attendance dateOnly + dashboard timeout/retry precedents** | The two in-repo fixes that MI-1 and MI-7 ask other pages/routes to follow. |

---

*Maintained as the My Info section's QA record. Refresh when any of the nine pages, their
routes, or the coverage table changes.*
