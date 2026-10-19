# Headers / CORS / Secrets Inspection — G-Architects HRMS

**Status:** Draft (Phase 4)  
**Method:** Static source inspection of `server/index.js`, `vercel.json`, `public/js/*.js`, `public/pages/**/*.html`, `.env.example`  
**No production credentials read or recorded.** This is a configuration review, not a secret scan output.

---

## 1. Security headers (vercel.json)

| Header | Source | Value | Assessment |
|--------|--------|-------|------------|
| `Cache-Control` | `/sw.js` | `no-cache, no-store, must-revalidate` | ✅ Service worker never cached — deploys apply on next open |
| `Service-Worker-Allowed` | `/sw.js` | `/` | ✅ Correct scope |
| `Cache-Control` | `/manifest.json` | `public, max-age=3600` | ✅ Manifest cacheable, short TTL |
| `Content-Type` | `/manifest.json` | `application/manifest+json` | ✅ Correct |
| `Cache-Control` | `/assets/(.*)` | `public, max-age=31536000, immutable` | ✅ Static assets long-cache (fingerprinted via build) |
| `NODE_ENV` | `vercel.json env` | `production` | ✅ Production mode pinned (error handler leaks nothing) |

**Missing (recommended hardening):**
- No `Content-Security-Policy` header — inline scripts are used in portal pages; a CSP would require nonce/hash migration. Documented as optional future work.
- No `X-Frame-Options` / `X-Content-Type-Options` / `Strict-Transport-Security` — these are typically handled at the Vercel edge / load balancer; verify in Vercel project settings.
- No `Referrer-Policy`.

---

## 2. CORS (server/index.js:26-34)

- Allow-list via `ALLOWED_ORIGINS` env var; default fallback includes `localhost:3000` + `https://garchitects.in` variants (audit-security F14 — verified live, fail-closed for other origins).
- Requests without an `Origin` header are allowed (correct for Bearer-token API / non-browser clients).
- Disallowed origins get `callback(null, false)` — no CORS headers returned (fail-closed).
- All API calls from the frontend use `Authorization: Bearer <token>`, not cookies — so CORS origin restrictions are defense-in-depth, not the primary access control.

**Recommendation:** Set `ALLOWED_ORIGINS` explicitly on Vercel to `https://garchitects-hrms.vercel.app` (and any custom domain) rather than relying on the fallback.

---

## 3. Secrets — server-side only (no client exposure)

| Secret | Where used | Where stored | Frontend exposure? |
|--------|-----------|--------------|-------------------|
| `DATABASE_URL` | `server/config/database.js` (pg pool) | Server env (`.env` local / Vercel env vars) | ❌ None |
| `JWT_SECRET` | `server/middleware/auth.js` (sign/verify) | Server env | ❌ None |
| `JWT_EXPIRES_IN` | `server/middleware/auth.js` | Server env | ❌ None |
| `SMTP_HOST/PORT/USER/PASS/FROM` | `server/services/email.js` | Server env | ❌ None |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | `server/services/storage.js` (server-side only) | Server env | ❌ None — service key never reaches browser |
| `CRON_SECRET` | `server/routes/cron.js` (fail-closed guard) | Server env | ❌ None |
| `VAPID_PUBLIC/PRIVATE_KEY`, `VAPID_SUBJECT` | `server/services/push.js`, `public/js/auth.js` (public key only) | Public key in env; private key server-side | ⚠️ VAPID public key is sent to clients (expected for push subscription) |
| `OTP_PEPPER` (or `JWT_SECRET` fallback) | `server/routes/auth.js` (hashOtp pepper) | Server env | ❌ None |

**Verified sound:**
- `.env` is gitignored (`.gitignore:5-7`); only `.env.example` tracked with placeholders.
- No `process.env` references in `public/js/*.js` or `public/pages/**/*.html` — frontend contains zero secrets.
- `@supabase/supabase-js` used only in `server/services/storage.js` with `SUPABASE_SERVICE_KEY` (server-side).
- `auth.js` (client) only reads the token from memory/`localStorage` — never sends secrets to third parties.
- Global error handler (`server/index.js:121-129`) emits `err.message` only when `NODE_ENV === 'development'`; production gets generic `'Server error'`.
- `pgErrorResponse` maps known Postgres codes to friendly 400s; nothing raw leaks.

---

## 4. Token/storage handling (client)

| Item | Location | Assessment |
|------|----------|------------|
| JWT storage | `public/js/auth.js` `getToken()` / `localStorage` | Standard for SPA; token sent as Bearer header only |
| Token lifecycle | 7-day expiry (JWT_EXPIRES_IN); revoked via `token_version` bump on password change | ✅ Revocation works |
| Logout | `POST /api/auth/logout` (clears client token) | ✅ |
| Session cookie | None used — Bearer token in Authorization header | ✅ No cookie-based CSRF surface |
| `localStorage`/`sessionStorage` | Auth token only (verified scan) | ✅ No PII stored client-side |
| Service-worker cache | `sw.js` v13; never caches `/api/`; network-first for navigations | ✅ No API data cached |

---

## 5. Recommendations (low effort, high value)

1. Set `ALLOWED_ORIGINS` explicitly on Vercel (remove reliance on localhost fallback).
2. Add `Content-Security-Policy` header in a future release (requires inline-script nonce/hash migration first).
3. Verify `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options` at the Vercel edge (project settings).
4. Rotate `JWT_SECRET`, `SMTP_PASS`, `SUPABASE_SERVICE_KEY`, `CRON_SECRET` if any were ever committed to Git (confirmed none tracked — `.env` gitignored, `.env.example` placeholders only).
5. Consider `OTP_PEPPER` dedicated env var (currently falls back to `JWT_SECRET`, which is acceptable but a dedicated pepper is cleaner).

*This is an engineering configuration review, not a penetration test. No production credentials were read or recorded.*
