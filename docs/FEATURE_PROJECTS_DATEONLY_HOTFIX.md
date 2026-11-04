# Projects module — `dateOnly` ReferenceError hotfix (2026-11-04)

**Symptom (production):** `GET /api/projects` returned `500 {"success":false,"message":"Server error"}`.
Admin/HR Projects page lists projects — and, worse, project **create/update flows returned 500 after
the row was written** (data saved, client told failure → users retry → duplicate-create risk).

**Root cause:** `server/routes/projects.js` calls `dateOnly(...)` in 10 places (list row mapping,
create/update responses) but never imported it — it lives in `server/utils/date.js`. A missing
identifier throws `ReferenceError`, which the route's `catch` funnels through `pgErrorResponse`
→ generic 500. Node resolves unbound identifiers at call time, so the server booted fine and
`/api/projects/my` only *looked* healthy (its rows loop never ran for this admin — no assignments).

**Fix (one line):** `const { dateOnly } = require('../utils/date');` added to the requires in
`server/routes/projects.js`. Verified that every other route file calling `dateOnly` already
imports `../utils/date` (full-repo audit, this commit's diff).

**Verification:**
- Live sweep before fix: `GET /api/projects` → 500 (reproduced 3×).
- Syntax gate: `node --check server/routes/projects.js` → OK.
- After deploy: `GET /api/projects` (admin token) → **200**, 8 projects ("PIVOT'S …",
  "STAR HEIGHTS APARTMENT", …) with correct client/date fields; `/api/projects/my`, `/stats`,
  `/projects/stats` — 200; project assignments/dates flow through `dateOnly` normally.
- Static guards re-verified: unauth `/api/projects` → 401; portal pages → 200; login page fine.

**Lesson:** run-time `ReferenceError`s in hot paths are invisible to `node --check` (it only parses).
Any new cross-route utility import must be present in EVERY consumer — a repo-wide grep
(`git grep -l "dateOnly("`) was added to the checklist mindset; see also `npm run qa:inline`.
