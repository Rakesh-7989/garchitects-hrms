# Full System Test Report — G-Architects HRMS (2026-11-06)

**Method:** from-scratch re-verification of the whole system — static gates, automated
suites, live read-only sweep, and a targeted security deep-dive. No production writes
were performed; live probes were unauthenticated/GET only.

---

## 1. Static & build hygiene

| Check | Result |
|-------|--------|
| `node --check` on all 85 server/public/scripts/api JS files | **0 failures** |
| `npm run qa:inline` — inline JS in 39 portal pages | **39/39 clean** |
| Hermetic full suite `npm run qa` (throwaway PG 5433 + fresh schema) | **89/89 passed** (re-ran 2026-11-06) |
| RBAC expectation matrix | **274 cell probes green, 58 rows, zero qa leftovers** |
| DB invariants (leave/break/payroll chains) | **43 pass / 0 fail** |
| `schema.sql` boots verbatim with `ON_ERROR_STOP=1` (via commander) | ✔ boots |

## 2. Live verification (read-only)

| Probe | Result |
|-------|--------|
| All 39 public pages (`/pages/*.html`) | **39/39 → 200** |
| **All 232 API routes contacted unauthenticated** (counts: 115 GET / 75 POST / 22 PUT / 20 DELETE; `/api/auth/*` excluded as public) | **232/232 → 401** (none 2xx, none 5xx) |
| Security headers on `/` and API 401s | CSP (`default-src 'self'` "+ cdnjs/jsdelivr/fonts, `object-src 'none'`, `frame-ancestors 'self'`), HSTS 2y+preload, `X-Frame-Options SAMEORIGIN`, `nosniff`, `Referrer-Policy` |
| CORS with `Origin: https://evil-example.com` | **no** `Access-Control-Allow-Origin` (fail-closed ✔) |
| CORS with `Origin: https://garchitects.in` | ACAO echoed (allow-list ✔) |
| Malformed JSON body | **400** (not 500) |
| Unknown API route `/api/definitely-not-a-real-route-here` | **404** |
| Unknown page `/totally-unknown-page-xyz` | **404** |
| Invalid Bearer token → `/api/auth/me` | **401** `{"success":false,"message":"Invalid or expired token."}` |
| All 6 cron endpoints without secret | **401** (fail-closed ✔) |
| Latest deployment | READY; **0 runtime errors in 24h** (Vercel advisor/runtime-error scan) |

## 3. Security deep-dive

**SQL injection — PASS.** Every dynamic fragment is built from constants, integer param
ordinals, fixed column maps or whitelists (`EDITABLE_FIELDS` checked before the profile
UPDATE at `profileUpdates.js:117`; `PRIORITIES`/`STATUSES` whitelisted in filters;
`work-assignments` sets built from `colMap` with unmapped keys skipped; LIKE searches are
`ESCAPE` clause; pagination capped at 100). `status` filter is not whitelisted but is
fully parameterized (empty set, zero risk).

**Auth-guard coverage — PASS.** All 36 route modules reference a guard per route, or are
intentionally public: `auth.js` login/forgot/OTP/reset (dedicated limiters, uniform-200
forgot-password, timing equalizer vs enumeration), `cron.js` (CRON_SECRET, fail-closed
when unset). Every other route rejects anonymous callers (verified live, 232/232 → 401).

**Headers / CSP / CORS / error hygiene — PASS** (verified in code *and* live; raw Postgres
errors never reach clients — central `pgErrorResponse` + global handler; audit-security
F1–F4/F10 all in place).

**Secrets — PASS.** `.env` never appears in git history; no JWT/service-role keys in
tracked files; workflows reference `secrets.*` only; `.env.example` is placeholders;
VAPID public key is public by design.

**Uploads — PASS.** MIME whitelist + size caps everywhere (documents 10 MB, project docs
15 MB + DWG allowed, profile images 1 MB, photos restricted to jpeg/png/webp data-URIs);
multer errors mapped to clean 400s (no path leaks).

**Rate limiting — PASS (owner-accepted limits).** login 10/15m/IP (`Retry-After` set),
forgot 5/15m, OTP reset 10/15m, password 20/15m per account. In-memory per instance —
accepted risk F13 (documented); brute-force cost still raised enormously.

**Session — PASS.** JWT 7d + `token_version` revocation on password change; bcrypt(12);
`MIN_PASSWORD_LEN=8` on all paths; timing equalizer on login.

**Service worker — PASS.** `/api/*` never cached; navigations network-first; cache-first
only for static assets; `garchitects-hrms-v18`.

**RLS (prod) — PASS.** Applied 2026-10-21; re-verified read-only 2026-11-06: 8 sensitive
tables `relrowsecurity=true`, 36 `rls_*` policies + per-table `rls_app_all`
(`postgres`, ALL, `true`) live; PUBLIC deny; `schema_migrations` ledger present. Rollback
script written & tested on a scratch cluster (forward → re-apply → blocked role 0 rows →
INSERT rejected → rollback → re-apply). Advisor flags: 0 critical; 1 owner-accepted WARN
(`rls_auto_enable`, fails closed); 38 INFO by design (deny-all for non-`postgres` roles).

**Dependency audit (`npm audit`) — 1 CRITICAL + 3 HIGH + 5 MODERATE.**
Critical: `proxy-addr` (IP spoofing via IPv4-mapped IPv6; fix available, semver-safe).
High: `body-parser` (DoS trailing bytes; fix available), `nodemailer` (interpretation
conflict + command injection via `envelope.size`), `brace-expansion` (DoS, transitive).
Moderate: `minimatch`, `qs` ×2, `uuid` (via `exceljs`).
Fix path: `npm audit fix` (semver-safe), then re-run `npm run qa` and redeploy; nodemailer
and `exceljs` may need a targeted bump if not covered in-range.

## 4. Findings (open — both need owner action/approval)

| ID | Finding | Risk | Fix |
|----|---------|------|-----|
| F-NEW-1 | `app.set('trust proxy', true)` trusts **all** proxies — a client can spoof `X-Forwarded-For`, defeating the per-IP login rate limiter and polluting audit-log IPs | Medium (brute-force cost ↑, audit integrity) | `app.set('trust proxy', 1)` — Vercel is exactly one hop; one line, no functional break |
| F-NEW-2 | Dependency vulnerabilities above | Low–Medium | `npm audit fix` + verify suite + redeploy (nodemailer may need manual bump) |

Everything else from the prior audits remains **SHIPPED / owner-accepted** (see
`qa/triage.md`): all 36 Sprint-1 findings resolved; 2026-11-06 hardening shipped
(`pending` CHECK on 3 schema layers, assigner/admin-only work-assignment approval,
`RETURNING *` on break-start, int4-safe grant DELETE).

## 5. Not covered (out of scope / by decision)

- Live **write** probes on prod (never performed without per-action approval).
- Live RBAC matrix with role tokens (pending your `QA_LIVE_ADMIN_*` decision).
- Visual/UI regression beyond login render + structural 200 checks (no browser farm).
- Actual SMTP/push delivery round-trips (test-only scripts exist; not run without request).
- `payroll`/attendance business-rule deep tests — covered hermetically (43 invariants).

## 6. Bottom line

The system is **healthy and secure for its design**: no exposed routes, no secret leaks,
no SQL-injection vectors, fail-closed cron/CORS/rate-limit/error paths, RLS verified in
production, all automated suites green. Two low-risk actions close the loop: **F-NEW-1
(trust proxy)** and **F-NEW-2 (npm audit fix)**.
