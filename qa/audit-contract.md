# QA Audit — API↔UI Contract & QA Coverage

**Audit date:** 2026-10-09
**Repo:** G-Architects HRMS (C:\Users\boyap\G-Architects_HRMS)

**Method:** Enumerated every client call site (`apiCall(...)` / `fetch(...)` / `downloadWithAuth(...)`
across `public/js/*.js` + `public/pages/**/*.html` — ~300 matches) and every server definition
(`router.(get|post|put|delete)` across `server/routes/*.js` — 231 definitions behind the 35 mounts in
`server/index.js:36-70`), then matched method+path and read the `res.json(...)` body against the exact
property the client dereferences for 24 representative payloads (attendance, leave, payroll, employees,
work-assignments, notifications, projects, manager, onboarding, team-updates, daily-work-logs, auth).
Role parity was checked by reading `server/middleware/auth.js` guards next to `applyRoleNav()` /
`requireAdmin()` and the per-page button markup. Coverage was built from `qa/manifest.json`,
`qa/rbac-matrix.json`, `qa/report.json`, `qa/report-live.json` and `scripts/qa-*.cjs`. Everything below is
quoted from source; anything not directly read is marked **SUSPECTED** with its check step.

---

## Findings

### F1 — HR can list and permanently delete every employee's document, but cannot download any of them
**[high] [CONFIRMED]**

**Where:** `server/routes/documents.js` (`GET /all` L47, `GET /:id/download` L105-133, `DELETE /:id/admin` L167),
`public/pages/admin/documents.html` (L122, L166-167, L189, L194), `public/js/auth.js` `applyRoleNav()` L400-401.

**What:** The vault read + admin delete are HR-capable, the file read is not.

```js
// documents.js:47
router.get('/all', verifyToken, isAdminOrHr, async (req, res) => {
...
// documents.js:167
router.delete('/:id/admin', verifyToken, isAdminOrHr, async (req, res) => {
...
// documents.js:115-116  (inside GET /:id/download)
const isAdminUser = req.user.role === 'admin';
let canAccess = isAdminUser || doc.employee_id === req.user.id;
// L117: only then  if (!canAccess && (req.user.role === 'manager' || req.user.role === 'team_lead'))
```

The admin Documents page (nav item `/admin/documents` is **not** in the HR hide set) lists every row and
renders both buttons unconditionally:

```html
<!-- documents.html:166-167 -->
<button class="btn btn-sm btn-secondary" onclick="downloadDoc(${doc.id})" title="Download">...
<button class="btn btn-sm btn-danger" onclick="deleteDoc(${doc.id})" title="Delete">...
```
```js
// documents.html:189 / 194
downloadWithAuth('/documents/' + id + '/download', name);
apiCall(`/documents/${id}/admin`, 'DELETE')
```

**Why it matters:** HR clicks Download → 403, surfaced as an error toast carrying the server text
*"Access denied"* (`auth.js:243-249` — `downloadWithAuth` reads `j.message`), while the adjacent Delete for
the *same row* succeeds and destroys the file + storage object. That is a destructive-capability/read-capability
inversion, and it contradicts the
guard's own contract comment in `server/middleware/auth.js:110-115`: *"HR handles the people modules:
… letters, onboarding, **documents** and attendance reviews."* The repo's own convention elsewhere is
`role === 'admin' || role === 'hr'` (`employees.js:435`, `payroll.js:1279`) — `documents.js:115` is the
one place that drops `hr`.

**Fix direction (not applied):** `const isAdminUser = req.user.role === 'admin' || req.user.role === 'hr';`
— or, if HR really must not read personal files, take delete away too (`DELETE /:id/admin` → `isAdmin`).

---

### F2 — HR is shown Add/Edit/Delete buttons on four admin modules whose write APIs are admin-only
**[medium] [CONFIRMED]**

**Where:** `public/js/auth.js` `applyRoleNav()` L390-420 + `requireAdmin()` L297-305 vs
`server/routes/{departments,designations,holidays,announcements}.js`.

**What:** The nav filter hides only three items for HR; the four structure/broadcast pages stay visible
and are the only role gate on the page:

```js
// auth.js:400-401
} else if (user.role === 'hr') {
    ['/admin/project-management','/admin/audit-logs','/admin/settings'].forEach(p => hide.add(p));
// auth.js:297-305
function requireAdmin() {
    if (!checkAuth()) return false;
    const user = getCurrentUser();
    if (!user || !['admin', 'hr', 'manager'].includes(user.role)) { ... }
```
```js
// server/routes/departments.js:23, designations.js:22, holidays.js:84, announcements.js:100
router.post('/', verifyToken, isAdmin, async (req, res) => {
```
```html
<!-- departments.html:63 (same pattern: designations.html:63, holidays.html:63, announcements.html:63) -->
<button class="btn btn-primary" onclick="openModal()"><i class="fas fa-plus"></i> Add Department</button>
<!-- departments.html:179 -->
const result = id ? await apiCall(`/departments/${id}`, 'PUT', data) : await apiCall('/departments', 'POST', data);
```

No role gate exists on any of those four pages (grep over `public/pages/admin` for `role ===` / `getCurrentUser().role`
finds only: data filters in `designations.html:170`, `onboarding.html:324/361/362/370`, `payroll-generate.html:310/657`,
and the deliberate permission gates in `employees.html:462/1076`, `payroll.html:200` (`.pp-admin-only` hidden for HR),
`project-management.html:1593-1657`). `departments`, `holidays`, `announcements` have zero role checks;
`designations`' only match is an employee-list filter.

**Why it matters:** HR fills the modal, submits, and gets a red *"Access denied. Admin role required."*
toast. The server boundary is correct (`qa/rbac-matrix.json` rows `departments|designations|holidays|announcements`
declare `hr: 403`), so this is a UX/parity defect — but it is the exact failure class the matrix says the
system intends to avoid: *"this filter only stops a role from seeing/clicking pages whose APIs would 403
for it"* (`auth.js:385-386`).

---

### F3 — My Team renders Regularization Approve/Reject for HR/manager/team_lead; the API is admin-only
**[medium] [CONFIRMED]**

**Where:** `public/pages/manager/my-team.html` L461-464, L1003-1030 vs `server/routes/regularization.js` L133-137.

**What:** The pending list is deliberately role-scoped *to include* HR/manager/TL:

```js
// regularization.js:90-95
if (!['admin', 'hr', 'manager', 'team_lead'].includes(req.user.role)) {
    return res.status(403).json({ success: false, message: 'Access denied' });
}
...
if (req.user.role === 'admin' || req.user.role === 'hr') { rows = await q(`... WHERE r.status = 'pending' ...`)
```
…but the decision endpoint is admin-only, and the UI gates nothing:

```js
// regularization.js:133-137
router.post('/:id/review', verifyToken, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Only Admins can approve or reject attendance regularizations.' });
```
```js
// my-team.html:462-463  (card actions, no role condition)
'<button class="btn btn-sm btn-success" onclick="openRegDecision(' + r.id + ', \'approved\')">... Approve</button>' +
'<button class="btn btn-sm btn-danger" onclick="openRegDecision(' + r.id + ', \'rejected\')">... Reject</button>' +
// my-team.html:1030
data = await apiCall('/regularization/' + id + '/review', 'POST', { status, review_note: remarks });
```

**Why it matters:** `My Team` is the landing page for `manager` (auth.js:29) and is linked for HR and
team_lead (auth.js:362; `/manager/my-team` is static in every admin sidebar, e.g. `admin/dashboard.html:25`).
HR/manager/TL open the modal, confirm, and get the server's 403 as an error toast (my-team.html:1042).
A workflow that looks granted is refused — and the matrix has no row that would catch it
(`regularize` row only probes `POST /api/regularization`).

---

### F4 — 16 of 35 route modules have zero automated coverage (no harness, no RBAC matrix row)
**[medium] [CONFIRMED]**

**Where:** `qa/manifest.json` (35 modules, `harnesses` = 4, `rbacRows: 34`), `qa/rbac-matrix.json`,
`qa/report.json` (`"totals": { "checks": 50, "passed": 50, "failed": 0 }`).

**What:** The only regression harnesses are `qa-attendance-checkin-status.cjs` (24),
`qa-attendance-break-finalize.cjs` (41), `qa-attendance-my-readpath.cjs` (15) and
`qa-work-assignments-v2.cjs` (38) — i.e. **attendance + work-assignments only**. The RBAC matrix adds 34
rows over 18 modules. The union leaves these 16 modules with nothing: `auth, cron, daily-work-logs,
letters, project-access, project-documents, project-leads, project-reports, project-status-updates,
project-updates, push, team-handovers, team-transfers, team-updates, tickets, wfh`.

**Why it matters:** `wfh` and `tickets` are core org-wide approval flows that mirror `leave` (which at
least has 2 rows) yet have **no** assertion at all; the whole recent governance bundle
(team-transfers / team-handovers / project-access / project-leads / project-updates / project-status-updates /
project-documents) is uncovered. `cron` is security-relevant (CRON_SECRET guard unprobed). Also,
**`work-assignments` has a 38-assertion harness but 0 matrix rows**, so its role guards can regress
silently even while the harness stays green.

---

### F5 — No automated UI↔API contract test exists, which is why F1–F3/F6/F7 can regress silently
**[medium] [CONFIRMED]**

**Where:** `package.json` scripts.

**What:**
```json
"scripts": { "start": ..., "dev": ..., "db:init": ..., "db:migrate": ..., "test:smtp": ...,
             "qa": "node scripts/qa-commander.cjs", "qa:live": ..., "qa:json": ... }
```
`devDependencies` = `nodemon` only; `glob {test,tests,e2e}/**/*` → *No files found*.

**Why it matters:** every existing gate is API-level (`qa-commander` hermetic regression + RBAC matrix) or
static syntax (`scripts/check-inline-js.cjs` — present in `scripts/` but not wired to any `package.json`
script). Nothing drives the browser, so nothing asserts *"this button exists for role X and its endpoint
allows role X"* — the entire finding class found today (UI promises vs server guard) is structurally
invisible to CI.

---

### F6 — HR gets a 403 (generic error) when viewing check-in photos on the admin Attendance page
**[low] [CONFIRMED]**

**Where:** `server/routes/attendance.js:922` vs `public/pages/admin/attendance.html` L582-588, L624-630;
`/admin/attendance` is absent from the HR hide set (`auth.js:400-401`).

```js
// attendance.js:922
router.get('/photo/:token', verifyToken, isAdmin, async (req, res) => {
```
```js
// attendance.html:624, 627-630
const res = await fetch('/api/attendance/photo/' + encodeURIComponent(token), { headers: {...} });
if (res.status === 401) { ... }
if (!res.ok) { const msg = res.status === 404 ? 'Photo expired or already viewed' : 'Failed to load photo';
```

**Why it matters:** the page shows the In/Out photo buttons to every viewer (`if (a.photo_token) { ... photoBtns.push(...)}`),
HR included; a 403 is neither 401 nor 404 so it renders as *"Failed to load photo"* with no hint that the
role is the problem. Either the button should be admin-only or the guard should be `isAdminOrHr` like the
rest of the attendance read surface (`/all`, `/export`).

---

### F7 — UI role gating is nav-hiding only: hidden admin pages remain reachable by typed URL
**[low] [CONFIRMED]**

**Where:** `public/js/auth.js` `applyRoleNav()` L390-420 (cosmetic, `catch (e) { /* navbar filtering is cosmetic only */ }`)
+ `requireAdmin()` L297-305 + `server/index.js` `servePortalPage()` L89-100 (serves the HTML with **no**
role check).

**What:** `applyRoleNav` only does `a.style.display = 'none'`; `requireAdmin()` admits `admin|hr|manager`
to *every* admin page. So an HR user who types `/admin/project-management` loads the page, which then
calls `GET /api/projects` (`project-management.html:573`) → `router.get('/', verifyToken, isAdmin, ...)`
(`projects.js:108`) → 403 and an empty/erroring page. Same for a manager opening `/admin/departments`.

**Why it matters:** no data exposure (the API boundary holds — this matches the matrix expectations), but
roles land on broken pages instead of a redirect. Note the asymmetry: `team_lead` is not in `requireAdmin`,
so it *is* bounced (`window.location.href = '/employee/dashboard'`) — the redirect behaviour already exists,
it is just not applied per-page.

---

### F8 — Doc-vs-API drift on HR's projects-module access
**[low] [SUSPECTED]**

**Where:** `AGENTS.md` §6 role table vs `server/routes/projects.js:108` vs `qa/rbac-matrix.json` row `proj-list`.

**What:** the matrix already records it as a review item:
> `"note": "DOC-VS-API REVIEW ITEM: AGENTS.md role model says hr has 'read-only on the projects module',
> but GET /api/projects is isAdmin-only and no hr UI page calls it - recorded as fact, not a runtime bug"`

Confirmed from source that `router.get('/', verifyToken, isAdmin, ...)` (`projects.js:108`) and that the
only caller of `GET /api/projects` is `project-management.html` (L573, L732) — an admin page HR is not
navigated to.

**Why it matters:** either the role model (doc) or the guard (API) is wrong. **Check step:** product-owner
decision — (a) widen `GET /api/projects` to `isAdminOrHr`, or (b) edit `AGENTS.md` §6 to say HR is
read-only on *assigned/led* projects via `/api/projects/my`. Until then the doc can mislead future changes.

---

### F9 — Admin/HR bell badge omits `pendingRegularizations` because the client recomputes the total
**[low] [CONFIRMED]**

**Where:** `server/routes/notifications.js:101,109,111` vs `public/js/dashboard.js:532`.

```js
// notifications.js:101,109,111
pendingRegularizations: parseInt(pendingRegularizations.rows[0].count),
counts.total = counts.pendingLeaves + ... + counts.pendingRegularizations + ... ;
res.json({ success: true, counts });
```
```js
// dashboard.js:532 (admin/hr branch) — pendingRegularizations is absent from the sum
count = data.counts.pendingLeaves + data.counts.pendingWfh + data.counts.pendingProfileUpdates + data.counts.announcementsUnread + data.counts.pendingTickets + (parseInt(data.counts.openWorkAssignments) || 0) + ...
```
`grep counts.total` over `public/` → *No matches found* — the server-computed `total` is never used.

**Why it matters:** pending regularization reviews (admin-only to action, per F3) never light up the bell
or any sidebar badge (`loadSidebarCounts` has no regularization entry either), so approvals can sit unseen.

---

## API↔UI endpoint cross-check table (compact)

Server key → client dereference, quoted from both sides. "MATCH" = path, guard and response key agree.

| # | Module | Client call (file:line) | Server route + guard | Server key → client read | Verdict |
|---|--------|--------------------------|----------------------|--------------------------|---------|
| 1 | auth | `employee/leave.html:173` `apiCall('/auth/me')` | `auth.js:375` `verifyToken` | `{success, user}` → `data.user` (L175) | MATCH |
| 2 | attendance | `employee/dashboard.html:780` `/attendance/my?month&year` | `attendance.js:443` `verifyToken` | `{attendance: result.rows}` (L487) → `data.attendance.length` (L782) | MATCH |
| 3 | attendance | `admin/attendance.html:554` `/attendance/all?limit=20` | `attendance.js:493` `isAdminOrHr` | `{attendance: result.rows}` (L535) → `data.attendance` (L555) | MATCH |
| 4 | attendance | `admin/attendance.html:624` `fetch('/api/attendance/photo/'+token)` | `attendance.js:922` `isAdmin` | blob → 403 for HR (only 401/404 handled) | **MISMATCH → F6** |
| 5 | leave | `employee/leave.html:226` `/leave/my` | `leave.js:212` `verifyToken` | `{leaves: result.rows}` (L224) → `data.leaves` (L229) | MATCH |
| 6 | leave | `employee/dashboard.html:800` `/leave/balance` | `leave.js:419` `verifyToken` | `{balances}` (L447) → `data.balances` (L802) | MATCH |
| 7 | leave | `admin/leave.html:181` `/leave/all` | `leave.js:230` `isAdminOrHr` | `{leaves, counts}` (L261) → `data.leaves` (L181-196) | MATCH |
| 8 | payroll | `employee/payslips.html:183` `/payroll/my` | `payroll.js:1013` `verifyToken` | `{payslips: result.rows}` (L1030) → `d.payslips` (L193) | MATCH |
| 9 | payroll | `admin/payroll.html:357` `/payroll/all?...` | `payroll.js:1040` `isAdminOrHr` | `{payroll: result.rows}` (L1068) → `d.payroll` (L358) | MATCH |
| 10 | payroll | `payroll-core.js:142` `GET /payroll/:id/pdf` | `payroll.js:1275` `verifyToken` + `fetchPayslipWithProfile(id, req.user.id, isPrivileged)` (L505 `AND p.employee_id = $2` when not privileged) | scoped PDF stream | MATCH |
| 11 | employees | `admin/employees.html:491` `/employees?limit=1000` | `employees.js:56` `isAdminOrHr` | `{employees, pagination}` (L121-130) → `data.employees` (L493) | MATCH |
| 12 | employees | detail views (manager pages) `GET /employees/:id` | `employees.js:428` `verifyToken` + `admin\|hr` else recursive subtree (L435-451) | `{employee}` w/o `password_hash` | MATCH |
| 13 | manager | `manager/my-team.html:245` `/manager/today` | `manager.js:54` `isManager` | `{date, members}` (L127) → `data.members` (L251) | MATCH |
| 14 | manager | `manager/my-team.html:443` `/manager/regularizations/history` | `manager.js:427` `isManager` | `{requests}` → `histData.requests` (L468) | MATCH |
| 15 | projects | `employee/my-projects.html:220` `/projects/my` | `projects.js:52` `verifyToken` | `{projects: result.rows}` (L117) → `data.projects` (L224) | MATCH |
| 16 | project-status-updates | `employee/my-projects.html:234` `/project-status-updates?limit=200` | `project-status-updates.js:99` | `{updates: result.rows}` → `su.updates` (L235) | MATCH |
| 17 | work-assignments | `manager/team-work.html:233` `/work-assignments` | `work-assignments.js:89` `isManager` | `{assignments: result.rows}` → `data.assignments` (L239) | MATCH |
| 18 | work-assignments | `manager/team-work.html:354` `/work-assignments/projects` | `work-assignments.js:128` `isManager` | `{projects: result.rows}` (L141/147) → `data.projects` (L357) | MATCH |
| 19 | notifications | `dashboard.js:530` `/notifications/counts` | `notifications.js:111` `isManager` | `{counts:{12 keys, total}}` (L95-109) → `data.counts.*` (L532) | MATCH (total unused → **F9**) |
| 20 | notifications | `dashboard.js:145` `/notifications/feed?limit=25` | `notifications.js:378` | `{feed}` (L353) → `feed.feed` (L149) | MATCH |
| 21 | notifications | `dashboard.js:548` `/notifications/unread-count` | `notifications.js:417` `verifyToken` (all roles) | `{count: parseInt(...)}` (L423) → `direct.count` (L551) | MATCH |
| 22 | announcements | `dashboard.js:547` `/announcements/unread-count` | `announcements.js:30` | `{count}` (L43) → `ann.count` (L550) | MATCH |
| 23 | onboarding | `admin/onboarding.html:341` `/onboarding/processes/:id/tasks` | `onboarding.js:241` `isAdminOrHr` | `{process, tasks, progress}` (L262-267) → `d.process`/`d.tasks`/`d.progress` (L346/356/353) | MATCH |
| 24 | team-updates | `manager/my-team.html:1113` `/team-updates/summary` | `team-updates.js:280` | `{expected, reported, not_reported, unseen_total}` (L333-341) → `data.unseen_total` (L1118) | MATCH |
| 25 | team-updates | `employee/my-projects.html:503` `/team-updates/me` | `team-updates.js:360` | `{non_working_day, exempt_reason, expected, reported, update_count, hours, cutoff_time}` (L402-412) → same keys (L507-534) | MATCH |
| 26 | daily-work-logs | `admin/dashboard.html:526` `/daily-work-logs/team?limit=200` | `daily-work-logs.js:96` inline role scope: `admin\|hr` → all, `manager\|team_lead` → `myTreeIds`, else 403 (L104-113) | `{logs: r.rows}` (L117) → `data.logs` (L531) | MATCH |
| 27 | documents | `admin/documents.html:122` `/documents/all` + `:189` download + `:194` admin delete | `documents.js:47` `isAdminOrHr` / `:105` `verifyToken`+admin-or-owner-or-subtree / `:167` `isAdminOrHr` | `{documents}` matches; download 403 for HR | **MISMATCH → F1** |
| 28 | departments | `admin/departments.html:179` `POST/PUT /departments` | `departments.js:23/36` `isAdmin` | 403 for HR | **MISMATCH → F2** |
| 29 | designations | `admin/designations.html` (add/edit) | `designations.js:22/36` `isAdmin` | 403 for HR | **MISMATCH → F2** |
| 30 | holidays | `admin/holidays.html` (add/edit) | `holidays.js:84/124` `isAdmin` | 403 for HR | **MISMATCH → F2** |
| 31 | announcements | `admin/announcements.html:258/269` `POST/DELETE` | `announcements.js:100/173` `isAdmin` | 403 for HR | **MISMATCH → F2** |
| 32 | regularization | `manager/my-team.html:1030` `POST /regularization/:id/review` | `regularization.js:133` inline `role !== 'admin'` | 403 for HR/manager/TL | **MISMATCH → F3** |
| 33 | projects | `admin/project-management.html:573` `GET /projects` | `projects.js:108` `isAdmin` | 403 for HR via typed URL | **F7 / F8** |
| 34 | letters | `admin/employees.html:1365` `fetch(API_URL+'/letters/generate')` | `letters.js:108` `isAdminOrHr` + `letterLimiter` | PDF buffer | MATCH |
| 35 | settings / reports | `admin/settings.html:433/469/487`, `admin/dashboard.html:262/432`, `admin/reports.html:322` | `settings.js:6` `GET /company` `verifyToken` + `:30/:54` `PUT` `isAdmin`, `reports.js:7/66/81/103` `isAdminOrHr` | `{company,settings}` / report payloads (read keys verified) | MATCH |
| 36 | exports | `downloadWithAuth` → `/attendance/export` `attendance.js:783`, `/leave/export` `leave.js:456`, `/onboarding/export` `onboarding.js:501`, `/payroll/export` `payroll.js:1130`, `/employees/export` `employees.js:270`, `/documents/:id/download`, `/payroll/:id/pdf` | all `isAdminOrHr` (document/payroll pdf scoped) | XLSX/PDF streams | MATCH |

**Sweep note:** every distinct client path first-segment maps to one of the 35 mounts in
`server/index.js:36-70`; the four raw `fetch()` calls (`/api/attendance/photo/:token`,
`/api/documents/upload`, `/api/auth/profile-photo` ×2) and the `forgot-password`/`verify-reset-otp`/
`reset-password`/`set-password`/`profile-request(s)` auth calls all resolve to defined routes
(`auth.js:71/130/176/665/739/804/824`, `documents.js:61`, `attendance.js:922`). **No orphan client
endpoint was found.** Residual risk: paths built from template literals with computed segments were
spot-checked, not exhaustively proven — see F5 (no contract test).

---

## QA coverage table (module | harness | matrix row ids | gap)

Gap scale: **HIGH** = no automated coverage of a role-scoped or governance write flow ·
**MEDIUM** = matrix-only / partial coverage (business logic + unprobed cells) ·
**LOW** = matrix row over a small, simple surface.

| Module | Harness | Matrix row ids | Gap |
|--------|---------|----------------|-----|
| attendance | qa-attendance-checkin-status (24), qa-attendance-break-finalize (41), qa-attendance-my-readpath (15) | att-all, att-my, att-export, att-checkin, att-checkout, att-markpresent, att-markabsent | **LOW** — best-covered module |
| work-assignments | qa-work-assignments-v2 (38) | *(none)* | **MEDIUM** — harness green but 0 guard rows; role regression invisible |
| employees | — | emp-list, emp-create, emp-resetpwd, emp-permdelete | MEDIUM — import/status/reset flows untested |
| leave | — | leave-list, leave-apply | MEDIUM — approve/reject, balance, export untested |
| **wfh** | — | *(none)* | **HIGH** — org-wide apply/approve flow entirely unasserted |
| payroll | — | payroll-list, payroll-gen | MEDIUM — pdf/zip/export/attendance-summary untested |
| documents | — | docs-all | MEDIUM — download/delete **scoping** unprobed (F1 class) |
| departments | — | departments | LOW — POST only; PUT/DELETE untested |
| designations | — | designations | LOW — POST only |
| holidays | — | holidays | LOW — POST only |
| announcements | — | announcements | LOW — POST only; audience targeting untested |
| reports | — | reports-dash | MEDIUM — 3 of 4 report endpoints unprobed |
| audit-logs | — | audit-logs | LOW |
| **letters** | — | *(none)* | **MEDIUM** — document issuance + rate limiter untested |
| settings | — | settings-timing | MEDIUM — `PUT /settings/company` untested |
| profile-updates | — | profile-updates | MEDIUM — approve/reject untested |
| notifications | — | notif-counts, notif-requests | MEDIUM — feed/unread-count/mark-read untested |
| **tickets** | — | *(none)* | **HIGH** — create/respond/close flow entirely unasserted |
| onboarding | — | onboarding-tasks (forbidden cells only) | MEDIUM — authorized cells skipped by design |
| manager | — | mgr-team, mgr-today, mgr-leaves | MEDIUM — histories + tickets/wfh endpoints untested |
| **cron** | — | *(none)* | **MEDIUM** — `CRON_SECRET` guard + scheduled job behaviour unprobed (security-relevant) |
| push | — | *(none)* | LOW — opt-in infra |
| projects | — | proj-my, proj-list, proj-create | MEDIUM — units / `:id` / employees untested |
| **project-reports** | — | *(none)* | **HIGH** |
| **project-leads** | — | *(none)* | **HIGH** — D9/D11 placement power unasserted |
| **project-updates** | — | *(none)* | **HIGH** |
| **project-status-updates** | — | *(none)* | **HIGH** — management notes read by employees |
| **project-documents** | — | *(none)* | **HIGH** |
| **team-transfers** | — | *(none)* | **HIGH** — governance workflow |
| **team-handovers** | — | *(none)* | **HIGH** — cover-lead workflow |
| **project-access** | — | *(none)* | **HIGH** — request/grant workflow |
| **team-updates** | — | *(none)* | **HIGH** — daily-report cutoff/expected logic unasserted |
| daily-work-logs | — | *(none)* | MEDIUM — `/team` scoping + ownership guard (H1) untested |
| regularization | — | regularize (POST only) | MEDIUM — pending scoping + admin-only review (F3) unprobed |
| auth | — | *(none; login exercised implicitly by every harness)* | MEDIUM — forgot/reset OTP, password-change lock, `token_version` untested |

**Totals:** 35 modules · 11 HIGH · 17 MEDIUM · 7 LOW · 4 harnesses · 34 matrix rows (18 modules) ·
4 no-token 401 sweeps (`attendance/my`, `leave/apply`, `payroll/all`, `employees`).

**Latest runs (baseline evidence):** `qa/report.json` hermetic → `"ok": true`, `50/50` checks
(2026-10-08, incl. `cleanup:zero-leftovers`, `db:permEmp-deleted` = 0 rows);
`qa/report-live.json` live → `12/12` with `role-probes ... skipped (no QA_LIVE_ADMIN_* creds)`.

---

## Verified sound

- **Response-shape convention is consistent.** Every checked endpoint returns `{ success: true, <key>: … }`
  and the client destructures that named key. `grep '\.rows'` over `public/` → 0 matches (the client never
  reads pg's raw `rows` wrapper), so the shape layer has no drift.
- **DATE serialization fix is intact** on both read paths: `attendance.js:486` and `:534` both
  `r.date = dateOnly(r.date)` before `res.json`, and the client still matches on
  `a.date.split('T')[0] === getTodayIST()` (`employee/dashboard.html:787-788`).
- **Scope-correct "get by id" reads:** `GET /api/employees/:id` (admin/hr, else recursive reporting subtree),
  `GET /api/payroll/:id/pdf` (`AND p.employee_id = $2` unless privileged), `GET /api/documents/:id/download`
  (admin/owner/subtree — HR being the exception, F1). No unscoped PII read was found on these three.
- **`GET /api/daily-work-logs/team`** is role-scoped inline (`admin|hr` → all, `manager|team_lead` →
  `myTreeIds`, else 403) — matches what `admin/dashboard.html:526` expects for an admin viewer.
- **Bell routing by role is deliberate and correct:** `manager|team_lead|admin|hr` → `/notifications/counts`
  (`isManager`), employees → `/announcements/unread-count` + `/notifications/unread-count` (both `verifyToken`,
  both `{count}`) — matches the matrix's `notif-counts` "VERIFIED-INTENT" note.
- **Onboarding checklist contract** `{process, tasks, progress}` verified in both directions
  (`onboarding.js:241-267` ↔ `onboarding.html:341-356`).
- **Export/download endpoints all exist and are guarded:** `/attendance/export`, `/leave/export`,
  `/onboarding/export`, `/payroll/export`, `/employees/export`, `/documents/:id/download`, `/payroll/:id/pdf`,
  `/letters/generate` — all `isAdminOrHr` (except the two scoped ones above).
- **Manager decision endpoints used by My Team are role-correct for leaves/WFH:** `PUT /api/manager/:type/:id`
  sits behind `isManager` (`['admin','manager','team_lead','hr']`, `auth.js:128`), so only regularization
  (F3) diverges from what the page renders.
- **Q:** `team_lead` never sees the admin sidebar (it is routed to `/employee/dashboard` and neither the
  employee nor manager sidebars contain `/admin/*` links), so `applyRoleNav()` having no `team_lead` branch
  causes no visible break.

---

## Summary: 9 findings (1 high, 4 medium, 4 low)

| ID | Sev | Status | One-liner |
|----|-----|--------|-----------|
| F1 | high | CONFIRMED | HR can list + permanently delete documents but `GET /:id/download` excludes `hr` → 403 on read |
| F2 | medium | CONFIRMED | HR sees Add/Edit/Delete on departments/designations/holidays/announcements; all writes are `isAdmin` → 403 |
| F3 | medium | CONFIRMED | My Team shows Regularization Approve/Reject to HR/manager/TL; `/regularization/:id/review` is admin-only |
| F4 | medium | CONFIRMED | 16/35 modules have zero harness + zero RBAC row (wfh, tickets, letters, all project-*/team-* governance) |
| F5 | medium | CONFIRMED | No UI↔API contract test anywhere (no `test` script, no runner, no e2e) — the root cause of F1/F2/F3/F6/F7 |
| F6 | low | CONFIRMED | Check-in photo viewer (`isAdmin`) reachable by HR → generic "Failed to load photo" |
| F7 | low | CONFIRMED | `applyRoleNav` only hides links; hidden admin pages stay URL-reachable for hr/manager → error pages |
| F8 | low | SUSPECTED | `AGENTS.md` §6 "HR read-only on projects" vs `GET /api/projects` = `isAdmin` — needs an owner decision |
| F9 | low | CONFIRMED | Admin/HR bell sum drops `pendingRegularizations` (server `counts.total` includes it, client never reads it) |

**Recommended next actions (priority order):** (1) F1 one-line guard fix + a matrix row asserting
`GET /api/documents/{id}/download` per role; (2) F3 gate the buttons on `role === 'admin'` or widen the
review guard, plus a `regularize-review` matrix row; (3) F2 either hide the four pages for HR or promote
those writes to `isAdminOrHr` — and update `qa/rbac-matrix.json` to match whichever is chosen; (4) close
the F4 HIGH cells (wfh + tickets first, then the governance bundle) and add a `work-assignments` guard row;
(5) F5 — a thin Playwright smoke that clicks each role's visible buttons and asserts no 403 toast would
have caught F1–F3 and F6 automatically.

*Read-only audit: no source file was modified; this report is the only artifact written.*
