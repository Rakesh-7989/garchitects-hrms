# Security & Error-Hygiene Audit — G-Architects HRMS

**Auditor:** Security & Error-Hygiene Auditor (Squad 1, Sprint 1 full-system audit)
**Date:** 2026-10-09
**Method:** static analysis only (ripgrep + targeted file reads). No runtime probing, no live/deployed
checks, no writes outside this file. Items that depend on production env vars or runtime behaviour are
marked **SUSPECTED** with the exact verification step needed.

**Scope covered:** error hygiene / leak-free errors, auth guard coverage across all route mounts,
RBAC vs `AGENTS.md` §6 role model, `blockAdminSelfService` coverage, `logAudit` coverage, rate limiting,
hardcoded secrets.

---

## Findings

### F1 — Raw Postgres error text surfaced to admin in two employee routes
**Severity:** low · **Status:** CONFIRMED
**Files:** `server/routes/employees.js:668`, `server/routes/employees.js:902`

```js
body.detail = error && error.message;
```

`error.message` here is the raw driver error (e.g. `column employees.x does not exist`, constraint
names, or — worse — SQL fragments from some drivers). It is only attached when
`req.user.role === 'admin'` (checked at the assignment site), so the recipient is a platform admin.

**Why low:** recipient is admin; no unauthenticated path. **Why still a finding:** AGENTS.md §5 says
never leak raw Postgres errors, and admin-facing leaks still expose schema/SQL detail to the largest
compromise blast radius (a stolen admin token).
**Fix:** replace with `pgErrorResponse(error).message` (or drop `detail` entirely).

---

### F2 — Onboarding start route concatenates a raw driver message
**Severity:** low · **Status:** CONFIRMED
**Files:** `server/routes/onboarding.js:353` (message built), `server/services/onboarding.js:111` (source)

```js
'Could not start ' + type + ': ' + r.error
```

`r.error = e.message` (raw). Returned to admin/HR callers on the onboarding start path.
**Fix:** log `r.error` server-side, return `pgErrorResponse(e).message`.

---

### F3 — Multer upload failures echo `err.message` to any authenticated user
**Severity:** low · **Status:** CONFIRMED
**Files:** `server/routes/documents.js:70`, `server/routes/project-documents.js:73`

```js
'Upload failed: ' + err.message
```

Unlike F1/F2 the audience here is **any authenticated user** (employee included). Multer error text
can include filesystem paths and internal detail. Reachable only with a valid token and only on the
upload path.
**Fix:** map known multer codes (`LIMIT_FILE_SIZE` → "File too large"), else generic message.

---

### F4 — Cron responses can carry a raw error string
**Severity:** low · **Status:** CONFIRMED
**Files:** `server/routes/cron.js:32`, `server/services/attendanceAutoCheckout.js:211`

`cron.js` does `res.json({ success: true, ...result })`; `attendanceAutoCheckout` returns
`{ success: false, error: <raw e.message> }` on scan failure. The caller must present a valid
`CRON_SECRET` (`isCronAuthorized`, `cron.js:11-15`, fail-closed → 401 when unset/absent), so exposure
is limited to a secret holder.
**Fix:** `pgErrorResponse` / generic string in the service's failure branch.

---

### F5 — HR can edit an admin's salary / bank / reporting structure
**Severity:** medium · **Status:** CONFIRMED
**Files:** `server/routes/employees.js:765-772` (guard), `server/routes/employees.js:537-641` (field allowlist)

The HR block inside `PUT /api/employees/:id` only triggers when the **target is an admin and the
field is `role` or `status`**:

```js
if (req.user.role !== 'admin' && target.role === 'admin' && (role !== undefined || status !== undefined))
  → 403
```

`salary`, `bank_account`, `ifsc`, `reporting_to`, `department`, `designation` etc. are all in
`EMPLOYEE_UPDATE_FIELDS` and are **not** guarded — so HR (role `hr`) can change an admin's salary and
bank details, or re-point an admin's reporting line. AGENTS.md §6 gives admin "money-write" and
"structure" as admin-only powers; HR is "people modules", not money-write over admins.
**Fix:** extend the guard to any field change on an `admin` target unless `req.user.role === 'admin'`
(keep HR able to edit non-admin people freely).

---

### F6 — Missing `logAudit(...)` on meaningful mutations
**Severity:** medium · **Status:** CONFIRMED

AGENTS.md §5 requires auditing every meaningful mutation. These writes perform **no** `logAudit` call
(verified by grepping each file for `logAudit`):

| Route file | Unaudited mutation(s) | Notes |
|---|---|---|
| `server/routes/settings.js` | `PUT /company`, `PUT /timing` (any settings write) | settings = admin-only money/org config |
| `server/routes/announcements.js` | create / update / delete | org-wide broadcast |
| `server/routes/designations.js` | create / update / delete | structure change |
| `server/routes/departments.js` | create / update / delete | structure change |
| `server/routes/profileUpdates.js` | approve / reject | approve writes **PAN + bank_account** to the employee row — high-value PII mutation, unaudited |
| `server/routes/tickets.js` | POST create, respond/update | |
| `server/routes/leave.js` | `POST /leave/apply` | decision routes *are* audited; the apply is not |
| `server/routes/wfh.js` | `POST /wfh/apply` | same pattern |
| `server/routes/regularization.js` | `POST /regularization` | same pattern |
| `server/routes/attendance.js` | `mark-present`, `mark-absent`, `reset` (admin back-dated attendance edits) | back-dated attendance edits are exactly what an audit trail is for |

**Fix:** add `logAudit` to each, actor + target id + before/after where cheap. Prioritise
`profileUpdates` approve (PII write) and the attendance back-dated edits.

---

### F7 — Public forgot-password is an account-existence oracle
**Severity:** medium · **Status:** CONFIRMED (behaviour); the *intent* of the 404 vs 200 split is
CONFIRMED as an oracle regardless of intent.
**Files:** `server/routes/auth.js:89-91` (404 for unknown id/email), `server/routes/auth.js:104-116`
(200 + `ok:true` + `emailSent` for known)

`POST /api/auth/forgot-password` is unauthenticated (limiter-guarded: `forgotLimiter` 5/15m/IP).
An unauthenticated caller can distinguish "account exists" (200) from "no such account" (404
`Invalid Employee ID or Email`) by probing Employee IDs / emails — an enumeration oracle over the
whole workforce. Rate limiting (5/15m/IP) throttles but does not remove it; distributed probing still works.
**Fix:** always return the same `200 { ok: true, message: 'If the account exists…' }`, do the lookup
silently, keep the 5/15m limiter.

---

### F8 — Inconsistent password minimums (6 vs 8 vs unconstrained)
**Severity:** low · **Status:** CONFIRMED
**Files:** `server/middleware/validation.js:14` (create → min 8), `server/routes/auth.js:601`
(change-password → min 6), `server/routes/auth.js:185` (OTP reset → min 6),
`server/routes/employees.js:918` (admin `reset-password` → **no length validation at all**)

Same account can end up with a 6-char password via change/reset while creation demands 8, and an
admin can set any length (including 1 char) via `POST /api/employees/:id/reset-password`.
**Fix:** single shared `MIN_PASSWORD_LEN` (8) constant applied on all four paths.

---

### F9 — `blockAdminSelfService` gaps (admin can self-serve writes the guard exists to stop)
**Severity:** low · **Status:** CONFIRMED
**Files:** `server/middleware/auth.js:47-57` (guard definition), route usages

Guard **is** correctly mounted on: `POST /api/leave/apply`, `POST /api/wfh/apply`,
`POST /api/regularization`, `POST /api/auth/profile-request` — and attendance check-in/check-out
blocks admin inline (`attendance.js:15`, `attendance.js:156`), with break-* indirectly unreachable
(no attendance row ⇒ no break row).

Missing (admin may self-serve a write the pattern intends to block):
- `POST /api/daily-work-logs` — admin can create own daily log (peer-reviewable self-report).
- `POST /api/tickets` — admin can raise own ticket.
- `documents/upload` — admin can upload own document.

**Judgement:** all three are low-impact self-service (arguably benign); flagged for consistency —
either mount the guard or document the deliberate exceptions in §6.

---

### F10 — ~20 DB-touching route files don't use `pgErrorResponse`
**Severity:** low · **Status:** CONFIRMED
**Files:** `server/utils/schemaRepair.js:671-700` (the mapper), 12 importers vs ~35 mounted modules

Only 12 route files import `pgErrorResponse`: `daily-work-logs`, `employees`, `project-access`,
`project-documents`, `project-leads`, `project-reports`, `project-status-updates`, `project-updates`,
`projects`, `team-handovers`, `team-transfers`, `work-assignments`. Remaining DB-touching modules
(`leave`, `attendance`, `payroll`, `documents`, `announcements`, `settings`, `tickets`, `onboarding`,
…) fall through to the global handler / local `catch` → generic 500.

**Not a leak** (generic 500 is leak-free) — but it violates the AGENTS.md §5 convention that a
23505/23503/22P02/… must become a *friendly 400*, so users see "Server error" for what is a validation
problem (e.g. a duplicate/invalid date).
**Fix:** import + wrap in the remaining DB routes, or centralise the mapping in the global error
handler (`server/index.js:109-116`) so every route inherits it.

---

### F11 — Role-model divergences *stricter* than AGENTS.md §6
**Severity:** low · **Status:** CONFIRMED as code behaviour; SUSPECTED as to whether the divergence
from §6 is intentional. Verification step: owner confirms intent, then either update the code or the
§6 table.
**Files:** `server/routes/designations.js:71-73,111-114,149-152` (and departments equivalents),
`server/routes/projects.js:107-110` (`GET /` is `isAdmin`), `server/routes/documents.js:114-116`
(download is `isAdmin`)

- §6 grants `manager` "structure + designation", but designations/departments CRUD is `isAdmin` only
  ⇒ manager cannot actually manage structure.
- §6 says HR is "read-only on the projects module", but `GET /api/projects` (list) is `isAdmin` — HR
  gets **no** project read at all (stricter than "read-only").
- `GET /api/documents/:id/download` is `isAdmin` — HR blocked despite §6 people-module read access.

None of these grant excess privilege (all are over-restrictive), so no security exposure; they are
contract drift between the guards and the documented model.
**Fix:** decide per row — align code to §6, or amend §6. Keep server guards and
`public/js/auth.js applyRoleNav()` in parity if changed.

---

### F12 — Audit-log UI hides every admin-actor row
**Severity:** low · **Status:** CONFIRMED behaviour; intent SUSPECTED.
**File:** `server/routes/auditLogs.js:52`

```js
const visibilityClause = "e.role IS DISTINCT FROM 'admin'";
```

The audit viewer (admin-only route) filters **out** all rows whose actor role is `admin`. Since admin
is the role doing most privileged mutations, the visible audit trail systematically omits exactly the
highest-privilege actions — a blind spot in the very tool used to detect abuse.
**Fix:** confirm intent with owner; if the goal was to hide admin *targets* or reduce noise, filter
differently (e.g. by event type), not by actor role.

---

### F13 — Rate limiting is in-memory per serverless instance
**Severity:** low · **Status:** CONFIRMED (documented limitation)
**Files:** `server/utils/rateLimit.js:1-5`, `server/routes/auth.js:20-55`

`loginLimiter` (10/15m/IP), `passwordLimiter` (20), `forgotLimiter` (5), `otpResetLimiter` (10),
`letterLimiter` (30), payroll `pdfRateLimit` (30/min/user) are all in-memory counters. On Vercel each
lambda instance has its own map → effective ceiling is `limit × instances`, and counters reset on
cold start. The file itself documents this.
**Not a bug** — but combined with F7 (enumeration) the practical throttle is weaker than the numbers
suggest. **Fix (optional):** store counters in Postgres/Redis, or keep as-is and treat as accepted
risk documented in §6.

---

### F14 — CORS falls back to `localhost:3000` when `ALLOWED_ORIGINS` is unset
**Severity:** low · **Status:** SUSPECTED (depends on production env)
**File:** `server/index.js:25-33`

```js
const allowed = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,...').split(',')
```

If the deployed Vercel project has **no** `ALLOWED_ORIGINS`, the API would accept requests from
`localhost:3000`. That is not directly exploitable in production (no attacker origin in the list),
but it is a misconfiguration that silently disables origin restriction and would matter for any
cookie-based flow or local-prod confusion.
**Verification step:** check the Vercel project env — `ALLOWED_ORIGINS` must be set to
`https://garchitects-hrms.vercel.app`. Local `.env` *does* define `ALLOWED_ORIGINS` (key present;
value not read), so local runs are fine.

---

### F15 — Login wrong-password response discloses account status
**Severity:** low · **Status:** CONFIRMED behaviour (appears deliberate)
**File:** `server/routes/auth.js:273-287`

On a wrong password for a *valid* account the response distinguishes
`Account not approved` / `Account inactive` from a plain bad-password error. Combined with the
bcrypt timing equalizer this is a narrow, post-credential oracle (requires knowing the password is
wrong), and it appears intentional UX for blocked users.
**Fix (optional):** return a generic "Invalid credentials" and surface account status only after
successful auth.

---

## Guard coverage table

Legend for **Role-model ok?**: ✅ consistent with AGENTS.md §6 · ⚠ divergence (see finding) · n/a not
in §6.

| Endpoint | Method | Guard(s) | Role-model ok? |
|---|---|---|---|
| `/api/auth/login` | POST | public + `loginLimiter` | n/a |
| `/api/auth/forgot-password` | POST | public + `forgotLimiter` | ⚠ F7 (enumeration) |
| `/api/auth/verify-reset-otp` | POST | public + `otpResetLimiter` | n/a |
| `/api/auth/reset-password` | POST | public + `passwordLimiter` | ⚠ F8 (min 6) |
| `/api/auth/profile` | GET/PUT | `verifyToken` + 4-field allowlist (`auth.js:429-446`) | ✅ |
| `/api/auth/profile-request` | POST | `verifyToken` + `blockAdminSelfService` | ✅ |
| `/api/auth/change-password` | POST | `verifyToken` | ⚠ F8 (min 6) |
| `/api/cron/*` (5 GETs) | GET | `isCronAuthorized` (fail-closed `CRON_SECRET`) | n/a |
| `/api/payroll/generate` + `-bulk` + `DELETE :id` | POST/DELETE | `verifyToken` + `isAdmin` | ✅ money-write admin-only |
| `/api/payroll/payslips/me` | GET | `verifyToken` (scoped by `fetchPayslipWithProfile`, `payroll.js:505`) | ✅ |
| `/api/settings/company`, `/timing` | PUT | `verifyToken` + `isAdmin` | ✅ (⚠ F6 unaudited) |
| `/api/employees/:id/permanent` | DELETE | `verifyToken` + `isAdmin` + `adminTargetGuard`/`lastActiveAdminGuard` | ✅ |
| `/api/employees/:id` | PUT | `verifyToken` + HR-block on `role`/`status` of admin target | ⚠ F5 (salary/bank not blocked for admin target) |
| `/api/employees/:id/reset-password` | POST | `verifyToken` + admin | ⚠ F8 (no min length) |
| `/api/audit-logs` | GET | `verifyToken` + `isAdmin` | ⚠ F12 (admin-actor rows hidden) |
| `/api/leave/apply` | POST | `verifyToken` + `blockAdminSelfService` | ✅ (⚠ F6 unaudited) |
| `/api/leave/:id/approve` | PUT | `verifyToken` + `isAdminOrHr` + TOCTOU 409 | ✅ |
| `/api/wfh/apply` | POST | `verifyToken` + `blockAdminSelfService` | ✅ (⚠ F6 unaudited) |
| `/api/wfh/:id/approve` | PUT | `verifyToken` + `isAdminOrHr` + TOCTOU 409 | ✅ |
| `/api/regularization` | POST | `verifyToken` + `blockAdminSelfService` | ✅ (⚠ F6 unaudited) |
| `/api/attendance/check-in` / `check-out` | POST | `verifyToken` + inline admin 400 (`attendance.js:15,156`) | ✅ |
| `/api/attendance/mark-present` / `mark-absent` / `reset` | POST | `verifyToken` (admin/HR back-dated edit) | ⚠ F6 unaudited |
| `/api/projects` | GET | `verifyToken` + `isAdmin` | ⚠ F11 (HR read-only ⇒ should read) |
| `/api/projects` (writes) | POST/PUT/DELETE | `verifyToken` + inline HR 403 (`projects.js:404,539`) | ✅ |
| `/api/project-leads` (assign) | — | `verifyToken` + `DESIGNATOR_ROLES=['admin','manager']` (`project-leads.js:27`) + inline HR 403 (`:447`) | ✅ |
| `/api/designations`, `/api/departments` | GET/POST/PUT/DELETE | `verifyToken` + `isAdmin` | ⚠ F11 (manager "structure + designation") + F6 unaudited |
| `/api/announcements` | CRUD | `verifyToken` + role-gated | ⚠ F6 unaudited |
| `/api/tickets` | POST/respond | `verifyToken` | ⚠ F6 unaudited, F9 gap |
| `/api/daily-work-logs` | POST | `verifyToken` | ⚠ F9 gap |
| `/api/documents/upload` | POST | `verifyToken` (multer) | ⚠ F9 gap, F3 leak |
| `/api/documents/:id/download` | GET | `verifyToken` + `isAdmin` | ⚠ F11 (HR blocked) |
| `/api/profile-updates/:id/approve` | PUT | `verifyToken` + admin/HR | ⚠ F6 unaudited (PII write) |
| Remaining ~200 handlers | — | `verifyToken` first | ✅ (spot-checked >15) |

**Auth-coverage result:** 231 handlers in 35 mounted files — **9 unauthenticated** (the 4 auth
limiter-guarded endpoints + 5 fail-closed cron GETs). No `router.use()` global auth; every other
handler calls `verifyToken` first.

---

## Verified sound

- **No unauthenticated data surface.** 222/231 handlers require `verifyToken`; the 9 exceptions are
  deliberately public (rate-limited auth flows) or `CRON_SECRET`-gated fail-closed (401 when unset).
- **No hardcoded secrets.** No credentials/tokens/keys in tracked source; `.env` is gitignored
  (`.gitignore:5`, confirmed via `git check-ignore`) and untracked; `.env.example` contains
  placeholders only; `scripts/seed-admin.js` uses env password with a placeholder guard.
- **Exact anti-pattern absent.** `message: (error && error.message) ||` → **0 matches**; no `...error`
  spreads into responses; email-service `.reason` never returned to clients (only `email_sent` bool).
- **Global error handler is prod-safe:** `server/index.js:109-116` emits `err.message` only when
  `NODE_ENV === 'development'`.
- **`pgErrorResponse` mapper correct** (`schemaRepair.js:671-700`): 23505/23503/22P02/22007/22008/
  23514/23502/22001 → friendly 400, else generic `'Server error'` — leak-free design (adoption is
  F10).
- **No SQL injection of user input found:** routes use parameterised `query($1…)`; no template
  interpolation of `req.*` into SQL located.
- **Money writes admin-only:** payroll generate/generate-bulk/delete all `isAdmin`.
- **Permanent delete admin-only + last-active-admin protected** (`employees.js:34-51`).
- **Profile update allowlist** excludes `role`/`salary` (`auth.js:429-446`,
  `profileUpdates.EDITABLE_FIELDS`).
- **Employee read scoping:** `GET /employees/:id` subtree + PII strip (`employees.js:435-481`).
- **Payslip read scoping** by profile (`payroll.js:505`).
- **Notifications self-scoped** (users only see their own counts/items).
- **TOCTOU-safe approvals:** manager leave/WFH approve use conditional update + row-count → 409.
- **OTP reset hardened:** peppered SHA-256 + `timingSafeEqual` + 5-min expiry + single-use
  (`auth.js` OTP flow).
- **Login hardening:** bcrypt comparison + timing equalizer; no user enumeration on the password
  branch beyond the deliberate status messages (F15).
- **`blockAdminSelfService` correctly mounted** on leave/wfh/regularization apply + profile-request;
  attendance check-in/out blocked inline for admin.
- **Cron fail-closed:** unset `CRON_SECRET` ⇒ 401, not open.

---

## Summary: 15 findings (0 high, 3 medium, 12 low)
