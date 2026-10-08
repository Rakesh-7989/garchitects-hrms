# QA Audit — Wiring & Bootstrap

- Audit date: 2026-10-09
- Method: Read `server/index.js` (full), `api/index.js`, `vercel.json`, `package.json`, `server/config/database.js`, `server/routes/cron.js`, `public/sw.js`, `public/manifest.json` and the PWA block of `public/js/auth.js`; cross-referenced all 35 `server/routes/*.js` files against the `app.use()` mounts and confirmed every file exports `express.Router()`; ran require() scans across `server/`, `api/`, `scripts/` for dependency drift, checked `server/schema.sql` against the startup DROP statements, and verified portal page/script/icon asset existence on disk.

## Findings

### F1. Destructive startup migrations re-run on every cold start (pool contention + silent-drop hazard) [severity: medium] [status: CONFIRMED]
- Where: server/index.js:283-298 (DROP TABLE/DROP COLUMN block), invoked from `runMigrations()` called at module scope on line 481; pool contention amplifier at server/config/database.js:22 (`max: isVercel ? 1 : ...`)
- What: `runMigrations()` fires on every process boot (every Vercel cold start, every local `npm start`). It is idempotent (`IF EXISTS` / `IF NOT EXISTS` throughout — no schema corruption risk today, and `server/schema.sql` contains none of the dropped tables/columns, verified by grep), but the ~45 sequential DDL statements — including 9 `DROP TABLE IF EXISTS` and 3 `DROP COLUMN IF EXISTS` — are re-executed on every single cold start, not once. On Vercel the pool is capped at `max: 1`, and `runMigrations()` is awaited nowhere, so all ~45 queries queue on that one connection alongside the first real user request of the invocation.
- Why it matters: (a) measurable cold-start latency jitter for the first request hitting a fresh instance; (b) maintenance hazard — if any of these tables/columns (e.g. `project_sets`, `attendance.overtime_hours`, `contract_value`) is ever legitimately reintroduced by a future feature, this startup block will silently drop it on the next boot before anyone notices. A one-time "migration applied" marker (or moving these to `db:migrate`) would remove both risks.
- Evidence:
```js
    try {
        await query(`DROP TABLE IF EXISTS project_closeout_items`);
        await query(`DROP TABLE IF EXISTS project_snags`);
        ...
        await query(`ALTER TABLE projects DROP COLUMN IF EXISTS contract_value`);
        await query(`ALTER TABLE projects DROP COLUMN IF EXISTS phase`);
        await query(`ALTER TABLE attendance DROP COLUMN IF EXISTS overtime_hours`);
```

### F2. `cloudinary` declared in dependencies but never required anywhere [severity: low] [status: CONFIRMED]
- Where: package.json:26 (`"cloudinary": "^1.41.0"`); require() scan of all `.js` under `server/`, `api/`, `scripts/` found zero `require('cloudinary')`
- What: The package is installed on every deploy but is not referenced by any runtime code path (file uploads go through multer + other storage).
- Why it matters: dead dependency — extra install time/bundle weight on Vercel and unnecessary audit/nag surface, zero functional benefit. No missing-dependency risk in the other direction: every non-builtin require across the codebase maps to a declared dependency.
- Evidence: scanned require() roots across `server/`, `api/`, `scripts/` = `@supabase, bcryptjs, cors, crypto, dotenv, exceljs, express, fs, http, https, jsonwebtoken, multer, nodemailer, os, path, pdfkit, pg, web-push` — no `cloudinary`, while package.json declares it.

### F3. Bare `/manager` and `/employee` roots 404 while bare `/admin` and `/login` work [severity: low] [status: CONFIRMED]
- Where: server/index.js:76-82 (explicit `/`, `/login`, `['/admin','/admin/']` handlers) vs. server/index.js:104-106 (only `/manager/:page`, `/employee/:page`, `/admin/:page` with a required param)
- What: A user navigating to `https://…/manager` or `https://…/employee` (no slug) gets the JSON 404 (`{"success":false,"message":"Route not found"}`), whereas `/admin` serves the admin login page. The manifest shortcuts (`/manager/my-team`, `/admin/dashboard`) use full slugs so PWA entries are unaffected, and no nav link appears to point at the bare roots.
- Why it matters: minor UX inconsistency — a mistyped/truncated URL in the employee/manager portal lands on a raw JSON body instead of a page. Trivially fixed by adding the bare-URL handlers (or a redirect to the portal's dashboard/login) symmetric with `/admin`.
- Evidence:
```js
app.get(['/admin', '/admin/'], (req, res) => {
    res.sendFile(path.join(__dirname, '../public/pages/admin-login.html'));
});
...
app.get('/manager/:page', servePortalPage('manager'));
app.get('/employee/:page', servePortalPage('employee'));
app.get('/admin/:page', servePortalPage('admin'));
```

## Verified sound

- **Route mounting 1:1**: all 35 `app.use('/api/x', ...)` mounts (server/index.js:36-70) map to existing `server/routes/*.js` files, every file creates `express.Router()` and exports it; zero orphan route files, zero mounts without a file.
- **Middleware/boot chain order**: `trust proxy` → `express.json`/`urlencoded` (15mb) → CORS lock-down → API routes → `express.static` → portal pages → 4-arg error handler → 404 handler. All request handlers sit before the error handler; the 4-arg error middleware is correctly skipped for normal requests, so the trailing 404 cannot swallow errors and no `next(err)` can fall off the end of the chain.
- **Error hygiene on Vercel**: error handler leaks `err.message` only when `NODE_ENV === 'development'`, and vercel.json:51-53 pins `NODE_ENV=production` on the platform.
- **CORS**: allow-list via `ALLOWED_ORIGINS`, missing-Origin requests allowed (correct for Bearer-token API); disallowed origins get `callback(null, false)` (no CORS headers) — standard lock-down.
- **Portal serving (AGENTS.md §8)**: `servePortalPage()` validates the slug with `/^[a-z0-9-]+$/` (path traversal impossible), strips legacy `.html`, and `fs.existsSync`-guards before `sendFile`; raw `/pages/*.html` paths keep working via `express.static` and via the vercel.json `/pages/(.*)` rewrite.
- **vercel.json**: `/api/(.*)` → function with `maxDuration: 30`; static rewrites for `/assets /css /js /pages /manifest.json /sw.js`; catch-all `/(.*)` → function so clean URLs work server-side; `sw.js` served `no-cache, no-store, must-revalidate` + `Service-Worker-Allowed: /`.
- **Crons**: all 5 `vercel.json` cron paths match routes in `server/routes/cron.js`; every handler calls `isCronAuthorized()` first, which fails closed (401) when `CRON_SECRET` is unset or the Bearer header doesn't match.
- **PWA**: `sw.js` cache name `garchitects-hrms-v13` (matches AGENTS.md §11, currently v13); sw.js correctly never caches `/api/`, uses network-first for navigations; registered from `public/js/auth.js` (`register('/sw.js')`, absolute scope) with `visibilitychange` → `reg.update()` revalidation; auth.js is included by all 37 portal pages (18 admin + 4 manager + 15 employee) so registration coverage is complete; all 3 manifest icons exist on disk under `public/assets/images/`.
- **`query()` shim**: server/config/database.js:47-51 normalizes pg results to `{ rows, changes }`, so the pervasive `result.changes` usage (SQLite-ism) is correct — not a bug.
- **Startup self-heal layers**: schema.sql is free of the dropped SiteTrack tables (no fresh-install conflict); `runMigrations()` blocks are individually try/caught and additive/`IF NOT EXISTS` everywhere except the intentional, user-approved reshape block (see F1); `server/utils/schemaRepair.js` provides the per-request lazy layer per AGENTS.md §5.
- **package.json scripts**: `start`/`dev`/`db:init`/`db:migrate`/`test:smtp` all point to existing files (`server/scripts/{init-db,migrate,test-smtp}.js` present, plus `seed-admin.js`); `qa`/`qa:live`/`qa:json` → existing `scripts/qa-commander.cjs`.
- **No missing runtime dependencies**: every non-builtin `require()` root in `server/ api/ scripts/` is declared in `dependencies`; `nodemon` correctly a devDependency.
- **Async error coverage (heuristic)**: every one of the 35 route files has at least as many `catch` blocks as `async (req` handlers — no file with async handlers and zero catches; cron/notifications/wfh etc. have generous coverage. (Heuristic scan, not per-handler proof, but no outlier file.)
- **Vercel entry**: `api/index.js` re-exports `server/index.js`'s app; `server/index.js` guards `app.listen` behind `require.main === module` so importing it in the function doesn't double-listen.

## Summary: 3 findings (0 high, 1 medium, 2 low)
