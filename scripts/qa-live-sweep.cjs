#!/usr/bin/env node
/**
 * qa-live-sweep.cjs — read-only full-system live sweep (no writes, no auth).
 *
 * Proves, against the DEPLOYED app:
 *   1. every static portal page + clean URL returns 200
 *   2. every API route, contacted WITHOUT a token, returns 401
 *      (no route leaks data anonymously: none 2xx, none 5xx)
 *   3. security headers present on HTML + API responses
 *   4. CORS fails closed for a foreign Origin, echoes an allowed Origin
 *   5. malformed JSON body -> 400 (not 500); unknown route -> 404
 *   6. cron endpoints fail closed without CRON_SECRET
 *   7. cron LIVENESS: with QA_LIVE_ADMIN_ID / QA_LIVE_ADMIN_PW, each
 *      scheduled job must have a fresh heartbeat (skipped without creds)
 *
 * Read-only: only GET/HEAD requests plus a malformed-body POST to /api/auth/login
 * (which cannot authenticate). No DB writes, no account creation. The optional
 * admin login in step 7 is read-only too (it creates no data).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASE = (process.env.QA_BASE_URL || 'https://garchitects-hrms.vercel.app').replace(/\/$/, '');
const results = [];
let fail = 0;

function rec(id, ok, detail) {
    results.push({ id, ok, detail: detail || '' });
    if (!ok) fail++;
    console.log(`${ok ? '  \u2714' : '  \u2716'} ${id}${detail ? ' — ' + detail : ''}`);
}
async function probe(method, url, opts = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 30000);
    try {
        const r = await fetch(url, {
            method,
            headers: { ...(opts.headers || {}) },
            body: opts.body,
            redirect: 'manual',
            signal: ctl.signal,
        });
        const text = await r.text();
        return { status: r.status, headers: r.headers, text };
    } catch (e) {
        return { status: 0, headers: new Headers(), text: '', error: e.message };
    } finally { clearTimeout(t); }
}

(async () => {
    console.log(`\n==============================================\n HRMS live sweep (read-only)\n target=${BASE}\n==============================================\n`);

    // ---------- 1. static pages ----------
    const pagesDir = path.join(ROOT, 'public', 'pages');
    const htmlFiles = [];
    (function walk(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.html')) htmlFiles.push(path.relative(pagesDir, p).replace(/\\/g, '/'));
        }
    })(pagesDir);

    let pageFail = 0;
    for (const f of htmlFiles) {
        const r = await probe('GET', `${BASE}/pages/${f}`);
        if (r.status !== 200) { pageFail++; console.log(`  \u2716 page /pages/${f} — ${r.status}`); }
    }
    rec('static pages', pageFail === 0, `${htmlFiles.length - pageFail}/${htmlFiles.length} -> 200`);

    // clean URLs
    const cleanUrls = [];
    for (const f of htmlFiles) {
        const m = f.match(/^(admin|manager|employee)\/(.+)\.html$/);
        if (m) cleanUrls.push(`/${m[1]}/${m[2]}`);
    }
    let cleanFail = 0;
    for (const u of cleanUrls) {
        const r = await probe('GET', `${BASE}${u}`);
        if (r.status !== 200) { cleanFail++; console.log(`  \u2716 clean ${u} — ${r.status}`); }
    }
    rec('clean portal URLs', cleanFail === 0, `${cleanUrls.length - cleanFail}/${cleanUrls.length} -> 200`);

    // ---------- 2. API routes unauthenticated -> 401 ----------
    // Harvest every route literal mounted in server/index.js + every route
    // declared inside server/routes/*.js, then contact each one anonymously.
    const mounts = [];
    const idxSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
    for (const m of idxSrc.matchAll(/app\.use\('\/api\/([^']+)'/g)) mounts.push('/api/' + m[1]);

    const PUBLIC = [
        /^\/api\/auth\/(login|forgot-password|reset-password|otp-verify|verify-otp|refresh|signup|register)$/,
        /^\/api\/auth\/me$/, // still requires token
    ];
    const routes = new Set(mounts);
    const routesDir = path.join(ROOT, 'server', 'routes');
    for (const f of fs.readdirSync(routesDir)) {
        if (!f.endsWith('.js')) continue;
        const src = fs.readFileSync(path.join(routesDir, f), 'utf8');
        const mount = mounts.find(m => m.endsWith('/' + f.replace(/\.js$/, '')));
        if (!mount) continue;
        for (const m of src.matchAll(/router\.(get|post|put|patch|delete)\(\s*['"]([^'"]*)['"]/g)) {
            routes.add(mount + m[2]);
        }
    }

    const apiRoutes = [...routes].filter(r => r && r !== '/api/').sort();
    let apiFail = 0, apiCount = 0;
    const badOnes = [];
    for (const r of apiRoutes) {
        if (PUBLIC.some(re => re.test(r))) continue;
        apiCount++;
        const res = await probe('GET', `${BASE}${r}`);
        if (res.status !== 401) {
            // some routes legitimately 404 on a missing id param / 405 on wrong verb;
            // flag anything that is 2xx or 5xx as a real leak
            if (res.status >= 200 && res.status < 300 || res.status >= 500) {
                apiFail++; badOnes.push(`${r} -> ${res.status}`);
            }
        }
    }
    rec('api routes anonymous', apiFail === 0, `${apiCount - apiFail}/${apiCount} guarded (401; no 2xx/5xx leak)${badOnes.length ? ' | LEAKS: ' + badOnes.join(', ') : ''}`);

    // ---------- 3. security headers ----------
    const hdr = await probe('GET', `${BASE}/`);
    const need = ['content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'strict-transport-security'];
    const missing = need.filter(h => !hdr.headers.get(h));
    rec('security headers (HTML)', missing.length === 0, missing.length ? 'missing: ' + missing.join(',') : need.join(', '));

    const hdrApi = await probe('GET', `${BASE}/api/employees`);
    const missingApi = need.filter(h => !hdrApi.headers.get(h));
    rec('security headers (API)', missingApi.length === 0, missingApi.length ? 'missing: ' + missingApi.join(',') : 'all present');

    // ---------- 4. CORS ----------
    const evil = await probe('GET', `${BASE}/api/employees`, { headers: { Origin: 'https://evil-example.com' } });
    rec('CORS foreign origin fail-closed', !evil.headers.get('access-control-allow-origin'), evil.headers.get('access-control-allow-origin') || 'no ACAO header');
    const allowed = await probe('GET', `${BASE}/api/employees`, { headers: { Origin: 'https://garchitects.in' } });
    rec('CORS allowed origin echoed', allowed.headers.get('access-control-allow-origin') === 'https://garchitects.in', allowed.headers.get('access-control-allow-origin') || 'none');

    // ---------- 5. error hygiene ----------
    const bad = await probe('POST', `${BASE}/api/auth/login`, { headers: { 'Content-Type': 'application/json' }, body: '{bad json' });
    rec('malformed JSON -> 400', bad.status === 400, `HTTP ${bad.status}`);
    const unknown = await probe('GET', `${BASE}/api/definitely-not-a-real-route-here`);
    rec('unknown API route -> 404', unknown.status === 404, `HTTP ${unknown.status}`);
    const unknownPage = await probe('GET', `${BASE}/totally-unknown-page-xyz`);
    rec('unknown page -> 404', unknownPage.status === 404, `HTTP ${unknownPage.status}`);
    const badTok = await probe('GET', `${BASE}/api/auth/me`, { headers: { Authorization: 'Bearer not-a-real-token' } });
    rec('invalid bearer token -> 401', badTok.status === 401, `HTTP ${badTok.status}`);

    // ---------- 6. cron fail-closed ----------
    const crons = ['auto-attendance', 'auto-checkout', 'purge-photos', 'expire-announcements', 'expire-handovers', 'sweep-late'];
    let cronFail = 0;
    for (const c of crons) {
        const r = await probe('GET', `${BASE}/api/cron/${c}`);
        if (r.status !== 401) { cronFail++; console.log(`  \u2716 cron ${c} -> ${r.status}`); }
    }
    rec('cron endpoints fail-closed', cronFail === 0, `${crons.length - cronFail}/${crons.length} -> 401`);

    // ---------- 7. cron LIVENESS (needs admin creds) ----------
    // A 401 only proves the guard works - it says nothing about whether the
    // scheduler ever calls these endpoints. The liveness heartbeat
    // (GET /api/cron/health) answers "did each scheduled job actually run?".
    // Skipped (not failed) without QA_LIVE_ADMIN_ID / QA_LIVE_ADMIN_PW.
    const adminId = process.env.QA_LIVE_ADMIN_ID;
    const adminPw = process.env.QA_LIVE_ADMIN_PW;
    if (!adminId || !adminPw) {
        rec('cron liveness (live)', true, 'skipped - set QA_LIVE_ADMIN_ID / QA_LIVE_ADMIN_PW to probe /api/cron/health');
    } else {
        const login = await probe('POST', `${BASE}/api/auth/login`, {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ employee_id: adminId, password: adminPw, portal: 'admin' }),
        });
        let token = null;
        try { token = JSON.parse(login.text).token; } catch (_) { /* not json */ }
        if (!token) {
            rec('cron liveness (live)', false, `admin login failed (HTTP ${login.status}) - cannot read /api/cron/health`);
        } else {
            const health = await probe('GET', `${BASE}/api/cron/health`, { headers: { Authorization: 'Bearer ' + token } });
            let body = null;
            try { body = JSON.parse(health.text); } catch (_) { /* not json */ }
            if (health.status !== 200 || !body || body.success !== true) {
                rec('cron liveness (live)', false, `GET /api/cron/health -> HTTP ${health.status}`);
            } else {
                const jobs = body.jobs || [];
                const stale = jobs.filter(j => j.stale).map(j => j.job);
                const failing = jobs.filter(j => j.failing).map(j => j.job);
                const never = jobs.filter(j => j.never_ran).map(j => j.job);
                const detail = `${jobs.length} job(s); stale=[${stale.join(',')}] failing=[${failing.join(',')}] never_ran=[${never.join(',')}]`;
                rec('cron liveness (live)', stale.length === 0 && failing.length === 0, detail);
            }
        }
    }

    // ---------- summary ----------
    const pass = results.filter(r => r.ok).length;
    console.log(`\n==============================================\n RESULTS: ${pass}/${results.length} passed, ${fail} failed\n==============================================`);
    console.log(`\nprobed ${apiCount} API routes + ${htmlFiles.length} pages + ${cleanUrls.length} clean URLs (all read-only)\n`);
    process.exit(fail === 0 ? 0 : 1);
})();
