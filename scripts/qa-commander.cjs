#!/usr/bin/env node
/**
 * qa-commander.cjs — HRMS QA Commander (v1).
 *
 * One entrypoint that turns the repo's hermetic QA harnesses + the declared
 * RBAC expectation matrix into a single regression pass with a unified report:
 *
 *   node scripts/qa-commander.cjs                # full hermetic self-check
 *   node scripts/qa-commander.cjs --target=live  # live smoke (+ role probes if QA_LIVE_ADMIN_* set)
 *
 * Stages (--only=discover|regression|rbac|db|all, default all):
 *   discover  – build qa/manifest.json (modules from server/index.js mounts,
 *               guards from middleware/auth.js, portals from public/pages).
 *   regression– run every scripts/qa-*.cjs harness, capture pass/fail counts;
 *               the server is restarted between harnesses because the login
 *               rate limiter is a per-process 10/15-min bucket and reuses one
 *               server across the whole suite would 429.
 *   rbac      – seed a throwaway role world (admin/hr/manager/team_lead/employee)
 *               directly in the DB, log in per role, probe qa/rbac-matrix.json,
 *               assert the declared expectations, then clean the world up
 *               (and prove zero QA leftovers).
 *   db        – WARN-only invariant scan for QA leftovers across a few tables.
 *
 * Targets:
 *   hermetic (default) – boots its OWN throwaway PostgreSQL cluster + app
 *               server on ports 5433/3000 when they are free, tears them down
 *               afterwards (DATABASE_URL must point at the hermetic DB).
 *               If 5433/3000 are already in use, the running stack is reused
 *               and NOT torn down.
 *   live       – probes the deployed API (QA_BASE_URL or the prod URL):
 *               401 sweep on protected endpoints + 200 sweep on static assets.
 *               If QA_LIVE_ADMIN_ID / QA_LIVE_ADMIN_PW are set, additionally
 *               seeds the full role world via the live API, runs the matrix,
 *               and cleans up (writes to the live DB - only with creds).
 *
 * Exit: 0 all green; 1 if any check FAILED (db WARNs never fail the run).
 * --json=<path> writes the machine-readable report. --issues files a GitHub
 * issue (via `gh`) for each FAILED item - explicit opt-in only.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const PG_BIN = process.env.PG_BIN || 'C:\\Program Files\\PostgreSQL\\16\\bin';
const QA_CLUSTER = process.env.QA_CLUSTER_DIR || path.join(process.env.TEMP || 'C:\\Users\\boyap\\AppData\\Local\\Temp', 'opencode', 'pg16qa');
const QA_PORT = 5433;
const SERVER_PORT = 3000;
const LIVE_URL = process.env.QA_BASE_URL || 'https://garchitects-hrms.vercel.app';
const ROLES = ['admin', 'hr', 'manager', 'team_lead', 'employee'];

// ---------------- args ----------------
const args = process.argv.slice(2);
const target = (args.find(a => a.startsWith('--target=')) || '--target=hermetic').split('=')[1];
const only = (args.find(a => a.startsWith('--only=')) || '--only=all').split('=')[1];
const jsonOut = args.find(a => a.startsWith('--json=')) ? args.find(a => a.startsWith('--json=')).split('=')[1] : null;
const wantIssues = args.includes('--issues');
const noTeardown = args.includes('--no-teardown');

const stages = only === 'all' ? ['discover', 'regression', 'rbac', 'db'] : [only];

// ---------------- report ----------------
const results = []; // { stage, id, ok, severity, detail }
let failCount = 0;
function record(stage, id, ok, detail, severity = ok ? 'ok' : 'high') {
    results.push({ stage, id, ok, detail: detail || '', severity });
    if (!ok) failCount++;
    const mark = ok ? '  ✔' : '  ✖';
    console.log(`${mark} [${stage}] ${id}${detail ? ' — ' + detail : ''}`);
}

// ---------------- helpers ----------------
async function waitForHttp(url, timeoutMs = 45000, probe = null) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const r = await fetch(url, probe
                ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(probe), signal: AbortSignal.timeout(4000) }
                : { signal: AbortSignal.timeout(4000) });
            return r.status;
        } catch (_) { /* retry */ }
        await new Promise(r => setTimeout(r, 800));
    }
    return null;
}
async function waitPortFree(port, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const busy = await new Promise((resolve) => {
            const net = require('net');
            const s = net.connect({ port, host: '127.0.0.1' });
            s.on('connect', () => { s.destroy(); resolve(true); });
            s.on('error', () => resolve(false));
        });
        if (!busy) return true;
        await new Promise(r => setTimeout(r, 700));
    }
    return false;
}
async function isListening(port) {
    return new Promise((resolve) => {
        const net = require('net');
        const s = net.connect({ port, host: '127.0.0.1' });
        s.on('connect', () => { s.destroy(); resolve(true); });
        s.on('error', () => resolve(false));
    });
}
function stripSchema(sql) {
    return sql.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
}
async function pgReady(timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            execFileSync(path.join(PG_BIN, 'pg_isready.exe'), ['-h', '127.0.0.1', '-p', String(QA_PORT), '-U', 'postgres'], { stdio: 'pipe' });
            return true;
        } catch (_) { await new Promise(r => setTimeout(r, 700)); }
    }
    return false;
}
function killByPort(port) {
    try {
        const r = execFileSync('powershell', ['-NoProfile', '-Command',
            `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { Stop-Process -Id $c.OwningProcess -Force }`],
            { stdio: 'pipe' });
        return r;
    } catch (_) { return null; }
}
function dbUrl() {
    const url = process.env.DATABASE_URL || '';
    return url;
}
function isHermeticUrl(url) {
    return /127\.0\.0\.1|localhost/.test(url || '') && /:5433/.test(url || '');
}

// ---------------- environment manager ----------------
const env = {
    selfManaged: false,
    pool: null,
    killedServer: false,
};
function makePool(url) {
    const remote = !/localhost|127\.0\.0\.1/.test(url);
    const pool = new Pool({ connectionString: url, ssl: remote ? { rejectUnauthorized: false } : undefined, max: 4 });
    // Idle clients emit 'error' when the backend dies (e.g. teardown) - without
    // a listener the process crashes with an unhandled 'error' event.
    pool.on('error', () => {});
    return pool;
}
async function hermeticUp() {
    const pgBusy = await isListening(QA_PORT);
    const srvBusy = await isListening(SERVER_PORT);
    if (pgBusy && srvBusy) {
        console.log('[env] reusing an externally-managed stack (5433+3000 up) — no teardown');
        env.pool = makePool(dbUrl());
        return;
    }
    if (!isHermeticUrl(dbUrl())) {
        throw new Error('DATABASE_URL is not a hermetic 5433 URL — point it at the QA Postgres (or start your own stack on 5433/3000 and rerun).');
    }
    env.selfManaged = true;
    console.log('[env] booting hermetic stack: PG cluster -> schema -> app server');
    if (!pgBusy) {
        // Throwaway cluster, always fresh: a leftover/torn dir from a previous
        // killed run would make pg_ctl start hang forever, so never reuse one.
        if (fs.existsSync(QA_CLUSTER)) {
            try { execFileSync(path.join(PG_BIN, 'pg_ctl.exe'), ['stop', '-D', QA_CLUSTER, '-m', 'fast'], { stdio: 'ignore', timeout: 20000 }); } catch (_) {}
            await new Promise(r => setTimeout(r, 800));
            fs.rmSync(QA_CLUSTER, { recursive: true, force: true });
        }
        try {
            execFileSync(path.join(PG_BIN, 'initdb.exe'), ['-D', QA_CLUSTER, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C', '--no-instructions'], { stdio: 'pipe', timeout: 90000 });
        } catch (e) {
            throw new Error('initdb failed: ' + ((e && e.message) || '').slice(0, 400));
        }
        // pg_ctl start detaches the postmaster from this console properly on
        // Windows and redirects its logs to a file - a raw spawned postgres.exe
        // with Node-managed pipes gets EPIPE-terminated mid-run (QA proven).
        // No -w: readiness is bounded by the pgReady() gate below instead of an
        // unbounded synchronous wait (a torn cluster used to hang it forever).
        env.pgLog = path.join(path.dirname(QA_CLUSTER), 'qa-pg.log');
        try {
            // stdio:'ignore' is REQUIRED on Windows: pg_ctl forks the postmaster
            // which inherits its stdio handles, so a pipe kept execFileSync
            // waiting for EOF on a handle the postmaster holds -> ETIMEDOUT even
            // though the database was up. pgReady() below does the waiting.
            execFileSync(path.join(PG_BIN, 'pg_ctl.exe'), ['start', '-D', QA_CLUSTER, '-l', env.pgLog, '-o', '-p ' + QA_PORT], { stdio: 'ignore', timeout: 30000 });
        } catch (e) {
            const tail = (fs.existsSync(env.pgLog) ? fs.readFileSync(env.pgLog, 'utf8').split('\n').slice(-10).join('\n') : '(no log)');
            throw new Error('pg_ctl start failed: ' + ((e && e.message) || '').slice(0, 300) + '\n' + tail);
        }
        if (!(await pgReady(25000))) throw new Error('postgres did not come up on 5433 (see ' + env.pgLog + ')');
        try { execFileSync(path.join(PG_BIN, 'createdb.exe'), ['-h', '127.0.0.1', '-p', String(QA_PORT), '-U', 'postgres', 'garchitects_hrms'], { stdio: 'pipe', timeout: 20000 }); } catch (e) { /* exists (pgReady() already confirmed server up) */ }
    } else if (!isHermeticUrl(dbUrl())) {
        // A foreign Postgres is already answering on 5433 - never let the
        // commander touch it. Reuse needs an idempotent DB contract, so only
        // proceed when DATABASE_URL points at a QA 5433 instance.
        throw new Error('port 5433 is in use but DATABASE_URL is not a QA 5433 URL — stop that service or point DATABASE_URL at the hermetic QA DB.');
    }
    if (!srvBusy) {
        const schema = fs.readFileSync(path.join(ROOT, 'server', 'schema.sql'), 'utf8');
        const tmp = path.join(QA_CLUSTER, '..', 'qa-schema-stripped.sql');
        fs.writeFileSync(tmp, stripSchema(schema));
        const load = execFileSync(path.join(PG_BIN, 'psql.exe'), ['-h', '127.0.0.1', '-p', String(QA_PORT), '-U', 'postgres', '-d', 'garchitects_hrms', '-f', tmp], { stdio: 'pipe' });
        void load;
        await startServer();
    }
    env.pool = makePool(dbUrl());
    console.log('[env] hermetic stack is up');
}
async function startServer() {
    console.log('[env] (re)starting app server on 3000');
    killByPort(SERVER_PORT);
    if (!(await waitPortFree(SERVER_PORT))) throw new Error('port 3000 did not free in time');
    // File-redirected stdio - same lesson as postgres: raw pipes + detach on
    // Windows can kill the child. Logs go to the temp dir (deleted on teardown).
    const logBase = path.join(path.dirname(QA_CLUSTER), 'qa-server');
    const outFd = fs.openSync(logBase + '.out.log', 'a');
    const errFd = fs.openSync(logBase + '.err.log', 'a');
    spawn('node', ['server/index.js'], { cwd: ROOT, windowsHide: true, detached: true, stdio: ['ignore', outFd, errFd], env: { ...process.env } }).unref();
    // DB-strong health: an unauthenticated /api/auth/login hits the DB (401 on
    // bad creds when the DB is up, 500 when it is down) - proving the whole
    // stack, not just Express static serving, is ready.
    const st = await waitForHttp(`http://localhost:${SERVER_PORT}/api/auth/login`, 45000, { employee_id: 'qa-health-probe', password: 'nope', portal: 'employee' });
    if (st !== 401) {
        const tail = (fs.existsSync(logBase + '.err.log') ? fs.readFileSync(logBase + '.err.log', 'utf8').split('\n').slice(-8) : []).join('\n');
        throw new Error(`app server not healthy: /api/auth/login -> ${st}\n${tail}`);
    }
    console.log('[env] server healthy');
}
async function hermeticDown() {
    if (!env.selfManaged || noTeardown) {
        if (noTeardown) console.log('[env] --no-teardown: leaving stack up');
        return;
    }
    console.log('[env] tearing down hermetic stack');
    // Close the commander's own pool BEFORE killing the backend so no idle
    // client is left holding a dying connection.
    await disposePool();
    killByPort(SERVER_PORT);
    try { execFileSync(path.join(PG_BIN, 'pg_ctl.exe'), ['stop', '-D', QA_CLUSTER, '-m', 'fast', '-w'], { stdio: 'ignore' }); } catch (_) {}
    await new Promise(r => setTimeout(r, 1500));
    fs.rmSync(QA_CLUSTER, { recursive: true, force: true });
    const base = path.dirname(QA_CLUSTER);
    for (const f of ['qa-schema-stripped.sql', 'qa-pg.log', 'qa-server.out.log', 'qa-server.err.log'].map(n => path.join(base, n))) fs.rmSync(f, { force: true });
    console.log('[env] teardown complete');
}
async function disposePool() { if (env.pool) await env.pool.end().catch(() => {}); }

// ---------------- stage: discover ----------------
async function stageDiscover() {
    const idx = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
    const modules = [...idx.matchAll(/app\.use\('\/api\/([^']+)'/g)].map(m => m[1]).sort();
    const authSrc = fs.readFileSync(path.join(ROOT, 'server', 'middleware', 'auth.js'), 'utf8');
    const exportsBlock = authSrc.match(/module\.exports\s*=\s*\{([^}]*)\}/);
    const guards = (exportsBlock ? exportsBlock[1].match(/\b(\w+)\b/g) : []).filter(g => g !== undefined && g !== 'module' && g !== 'exports');
    const portals = fs.readdirSync(path.join(ROOT, 'public', 'pages')).sort();
    const manifest = {
        generatedAt: new Date().toISOString(),
        target,
        modules,
        guards,
        portals,
        harnesses: HARNESSES.map(h => h[0]),
        rbacRows: JSON.parse(fs.readFileSync(path.join(ROOT, 'qa', 'rbac-matrix.json'), 'utf8')).rows.length,
    };
    const dest = path.join(ROOT, 'qa', 'manifest.json');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(manifest, null, 2));
    record('discover', 'manifest', modules.length >= 25 && guards.length >= 5,
        `${modules.length} modules / ${guards.length} guards / portals ${portals.join(',')} -> qa/manifest.json`);
}

// ---------------- stage: regression ----------------
const HARNESSES = [
    ['scripts/qa-attendance-checkin-status.cjs', 'attendance check-in status'],
    ['scripts/qa-attendance-break-finalize.cjs', 'attendance break finalize'],
    ['scripts/qa-attendance-my-readpath.cjs', 'attendance my read-path'],
    ['scripts/qa-work-assignments-v2.cjs', 'work assignments v2'],
];
async function runHarness(script, label) {
    const out = await new Promise((resolve) => {
        const p = spawn('node', [script], { cwd: ROOT, windowsHide: true });
        let buf = '';
        p.stdout.on('data', d => (buf += d));
        p.stderr.on('data', d => (buf += d));
        p.on('close', code => resolve({ code, buf }));
    });
    const m = out.buf.match(/(\d+)\s+passed,\s+(\d+)\s+failed/);
    const passed = m ? parseInt(m[1], 10) : null;
    const failed = m ? parseInt(m[2], 10) : null;
    const ok = out.code === 0 && failed === 0;
    const detail = m
        ? `${passed} pass / ${failed} fail (exit ${out.code})`
        : `exit ${out.code}, no 'passed/failed' summary line in output`;
    if (!ok) {
        const tail = out.buf.split('\n').filter(l => l.trim()).slice(-25).join('\n');
        console.log(`  └─ harness tail:\n${tail.split('\n').map(l => '     ' + l).join('\n')}`);
    }
    record('regression', label, ok, detail);
    return ok;
}
async function stageRegression() {
    for (let i = 0; i < HARNESSES.length; i++) {
        await runHarness(HARNESSES[i][0], HARNESSES[i][1]);
        // Fresh server between harnesses: the login limiter is a per-process
        // 10-attempt/15-min bucket and the whole suite needs ~20 logins.
        if (i < HARNESSES.length - 1) await startServer();
    }
}

// ---------------- stage: rbac ----------------
async function stageRbac() {
    if (target === 'live' && !(process.env.QA_LIVE_ADMIN_ID && process.env.QA_LIVE_ADMIN_PW)) {
        console.log('[rbac] live role probes skipped — set QA_LIVE_ADMIN_ID / QA_LIVE_ADMIN_PW to enable (writes throwaway users to the live DB, cleaned up after).');
        record('rbac', 'role-probes', true, 'skipped (no QA_LIVE_ADMIN_* creds)');
        return;
    }
    const base = target === 'live' ? LIVE_URL : `http://localhost:${SERVER_PORT}`;
    const isLive = target === 'live';
    if (!isLive && !isHermeticUrl(dbUrl())) {
        throw new Error('refusing to seed RBAC world: DATABASE_URL is not a QA 5433 URL (hermetic target must never write to another database).');
    }
    // RBAC performs its own logins -> give it a fresh login-limiter bucket.
    if (!isLive) await startServer();
    const ts = Date.now();
    const world = {};
    const matrix = JSON.parse(fs.readFileSync(path.join(ROOT, 'qa', 'rbac-matrix.json'), 'utf8'));

    // ---- seed the world ----
    if (!isLive) {
        const q = (sql, p) => env.pool.query(sql, p);
        const hashCache = {};
        for (const role of ROLES) hashCache[role] = await bcrypt.hash('Qa!' + ts + role, 6);
        hashCache.permEmp = await bcrypt.hash('Qa!' + ts + 'perm', 6);
        hashCache.targetEmp = await bcrypt.hash('Qa!' + ts + 'target', 6);
        for (const role of ROLES) {
            const r = await q(
                `INSERT INTO employees (employee_id, first_name, last_name, email, password_hash, joining_date, salary, role, status, must_change_password)
                 VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,0,$6,'active',0) RETURNING id`,
                [`qa${ts}${role}`, 'QA', role.toUpperCase(), `qa${ts}${role}@hrms-qa.invalid`, hashCache[role], role]);
            world[role] = { id: r.rows[0].id, employee_id: `qa${ts}${role}`, password: 'Qa!' + ts + role };
        }
        const pe = await q(
            `INSERT INTO employees (employee_id, first_name, last_name, email, password_hash, joining_date, salary, role, status, must_change_password)
             VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,0,'employee','active',0) RETURNING id`,
            [`qa${ts}perm`, 'QA', 'PERM', `qa${ts}perm@hrms-qa.invalid`, hashCache.permEmp]);
        world.permEmp = { id: pe.rows[0].id, employee_id: `qa${ts}perm`, password: 'Qa!' + ts + 'perm' };
        // Dedicated target for {qaEmpId} rows (reset-password / onboarding). A
        // reset bumps token_version and revokes that account's tokens - if it
        // pointed at the QA "employee", HR's own authorized probe would invalidate
        // the employee token mid-matrix (QA-proven). Never share a target with a
        // role whose token must stay live.
        const te = await q(
            `INSERT INTO employees (employee_id, first_name, last_name, email, password_hash, joining_date, salary, role, status, must_change_password)
             VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,0,'employee','active',0) RETURNING id`,
            [`qa${ts}target`, 'QA', 'TARGET', `qa${ts}target@hrms-qa.invalid`, hashCache.targetEmp]);
        world.targetEmp = { id: te.rows[0].id, employee_id: `qa${ts}target`, password: 'Qa!' + ts + 'target' };
    } else {
        // Live: create the role users through the admin API, then clean up at the end.
        const adminTok = await loginLive('admin');
        const createUser = async (tag, role) => {
            const r = await apiCall(base, 'POST', '/api/employees', adminTok, {
                employee_id: `qa${ts}${tag}`, first_name: 'QA', last_name: tag.toUpperCase(),
                email: `qa${ts}${tag}@hrms-qa.invalid`, password: 'Qa!' + ts + tag,
                role, joining_date: new Date().toISOString().slice(0, 10), salary: 0, status: 'active',
            });
            return r.status;
        };
        for (const role of ROLES) {
            const st = await createUser(role, role);
            world[role] = { id: null, employee_id: `qa${ts}${role}`, password: 'Qa!' + ts + role };
            if (!(st >= 200 && st < 300) && st !== 400) record('rbac', `seed ${role}`, false, `create failed: HTTP ${st}`);
        }
        const permSt = await createUser('perm', 'employee');
        world.permEmp = { id: null, employee_id: `qa${ts}perm`, password: 'Qa!' + ts + 'perm' };
        if (!(permSt >= 200 && permSt < 300) && permSt !== 400) record('rbac', 'seed permEmp', false, `create failed: HTTP ${permSt}`);
        const targetSt = await createUser('target', 'employee');
        world.targetEmp = { id: null, employee_id: `qa${ts}target`, password: 'Qa!' + ts + 'target' };
        if (!(targetSt >= 200 && targetSt < 300) && targetSt !== 400) record('rbac', 'seed targetEmp', false, `create failed: HTTP ${targetSt}`);
    }
    console.log(`[rbac] world seeded: ${ROLES.join(', ')} + permEmp + targetEmp (${isLive ? 'live' : 'hermetic'})`);

    // ---- logins ----
    // Portal role enforcement (server/routes/auth.js): admin accounts MUST use
    // the 'admin' portal, everyone else 'employee' - a mismatch 403s.
    const tokens = {};
    for (const role of ROLES) {
        const portal = role === 'admin' ? 'admin' : 'employee';
        const r = await apiCall(base, 'POST', '/api/auth/login', null, { employee_id: world[role].employee_id, password: world[role].password, portal });
        tokens[role] = (r.json && r.json.token) || null;
        record('rbac', `login ${role}`, !!tokens[role], `HTTP ${r.status}`);
    }

    // ---- no-token sweep ----
    for (const probe of matrix.noTokenSweep || []) {
        const r = await apiCall(base, probe.method, probe.path, null);
        const ok = r.status === 401;
        record('rbac', `401:${probe.path}`, ok, ok ? '401' : `expected 401, got ${r.status}`);
    }

    // ---- matrix probes ----
    let probed = 0, failedRow = false;
    for (const row of matrix.rows) {
        const rowFails = [];
        for (const role of ROLES) {
            if (!(role in row.expect)) continue; // cell not asserted (scope-dependent)
            const want = row.expect[role];
            const p = row.path.replace('{qaEmpId}', String(world.targetEmp ? world.targetEmp.id : (world.employee ? world.employee.id : world.team_lead.id))).replace('{permEmpId}', String(world.permEmp.id));
            const r = await apiCall(base, row.method, p, tokens[role], row.method !== 'GET' ? {} : undefined);
            probed++;
            const got = r.status;
            let cellOk;
            if (want === 'allow') cellOk = !(got === 401 || got === 403 || got === 404 || got >= 500);
            else if (typeof want === 'number') cellOk = got === want;
            else cellOk = true; // 'skip' string — shouldn't happen (absent cells skipped above)
            if (!cellOk) rowFails.push(`${role}: expected ${want} got ${got}`);
        }
        if (rowFails.length) {
            failedRow = true;
            record('rbac', `matrix:${row.id} (${row.method} ${row.path})`, false, rowFails.join('; ') + (row.note ? ' | note: ' + row.note : ''));
        } else if (row.note && row.note.startsWith('VERIFIED-INTENT')) {
            record('rbac', `matrix:${row.id}`, true, 'cells verified; ' + row.note);
        } else {
            record('rbac', `matrix:${row.id}`, true, 'all asserted cells green');
        }
    }
    console.log(`[rbac] ${probed} cell probes executed`);

    // ---- perm delete row already removed permEmp (hermetic) ----
    if (!isLive && world.permEmp) {
        const left = await env.pool.query('SELECT COUNT(*) n FROM employees WHERE id = $1', [world.permEmp.id]);
        record('rbac', 'db:permEmp-deleted', parseInt(left.rows[0].n, 10) === 0, `rows remaining: ${left.rows[0].n}`);
    }

    // ---- cleanup ----
    if (!isLive) {
        for (const role of [...ROLES, 'permEmp', 'targetEmp']) {
            await env.pool.query('DELETE FROM user_notifications WHERE employee_id = $1', [world[role].id]).catch(() => {});
            await env.pool.query('DELETE FROM attendance WHERE employee_id = $1', [world[role].id]).catch(() => {});
            await env.pool.query('DELETE FROM employees WHERE id = $1', [world[role].id]).catch(() => {});
        }
        const leftAll = await env.pool.query(`SELECT COUNT(*) n FROM employees WHERE employee_id LIKE 'qa${ts}%'`);
        record('rbac', 'cleanup:zero-leftovers', parseInt(leftAll.rows[0].n, 10) === 0, `qa rows remaining: ${leftAll.rows[0].n}`);
    } else {
        // Live cleanup via admin API (hard delete by employee_id lookup)
        const adminTok = tokens.admin;
        for (const role of [...ROLES, 'permEmp', 'targetEmp']) {
            const found = await apiCall(base, 'GET', '/api/employees', adminTok);
            const list = (found.json && found.json.employees) || [];
            const hit = list.find(e => e.employee_id === world[role].employee_id);
            if (hit && hit.id) await apiCall(base, 'DELETE', `/api/employees/${hit.id}/permanent`, adminTok);
        }
    }
}
// login helper used by the live branch (hermetic logins reuse the same apiCall)
async function loginLive(role) {
    // Reuse a QA_LIVE credential directly - the admin login will 400 if the
    // credential is wrong, which the caller records.
    const r = await apiCall(LIVE_URL, 'POST', '/api/auth/login', null, { employee_id: process.env.QA_LIVE_ADMIN_ID, password: process.env.QA_LIVE_ADMIN_PW, portal: 'admin' });
    return r.json && r.json.token;
}
async function apiCall(base, method, pathStr, token, body) {
    const res = await fetch(base + pathStr, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
    });
    let json = null;
    try { json = await res.json(); } catch (_) {}
    return { status: res.status, json };
}

// ---------------- stage: db (WARN-only) ----------------
async function stageDb() {
    if (target === 'live') { record('db', 'invariants', true, 'skipped on live target'); return; }
    const scans = [
        ['employees by qa% id', `SELECT COUNT(*) n FROM employees WHERE employee_id LIKE 'qa%'`],
        ['attendance for qa employees', `SELECT COUNT(*) n FROM attendance a JOIN employees e ON e.id = a.employee_id WHERE e.employee_id LIKE 'qa%'`],
        ['user_notifications for qa employees', `SELECT COUNT(*) n FROM user_notifications n JOIN employees e ON e.id = n.employee_id WHERE e.employee_id LIKE 'qa%'`],
    ];
    for (const [label, sql] of scans) {
        try {
            const r = await env.pool.query(sql);
            const n = parseInt(r.rows[0].n, 10);
            // WARN-only: leftover QA data is reported but never fails the run.
            console.log(`  ! [db] ${label}: ${n} row(s)${n ? ' — CLEAN ME (old manual run?)' : ''}`);
            if (n) results.push({ stage: 'db', id: label, ok: true, detail: `${n} leftover rows (WARN)`, severity: 'warn' });
        } catch (e) {
            console.log(`  ! [db] ${label}: scan error (${e.message})`);
            results.push({ stage: 'db', id: label, ok: true, detail: 'scan error (WARN)', severity: 'warn' });
        }
    }
}

// ---------------- stage: live 401/static sweep ----------------
async function stageLiveSmoke() {
    const sweeps = [
        ['GET', '/api/attendance/my', 401],
        ['POST', '/api/leave/apply', 401],
        ['GET', '/api/payroll/all', 401],
        ['GET', '/api/employees', 401],
        ['GET', '/api/audit-logs', 401],
        ['GET', '/', 200],
        ['GET', '/js/auth.js', 200],
        ['GET', '/sw.js', 200],
        ['GET', '/pages/employee/dashboard.html', 200],
    ];
    for (const [m, p, want] of sweeps) {
        try {
            const r = await apiCall(LIVE_URL, m, p, null, m !== 'GET' ? {} : undefined);
            const ok = r.status === want;
            record('live', `${m} ${p}`, ok, `expected ${want}, got ${r.status}`);
        } catch (e) {
            record('live', `${m} ${p}`, false, 'network error: ' + e.message);
        }
    }
}

// ---------------- main ----------------
async function main() {
    console.log('==============================================');
    console.log(' HRMS QA Commander v1');
    console.log(` target=${target}  stages=${stages.join(',')}  ${jsonOut ? 'json=' + jsonOut : ''}`);
    console.log('==============================================\n');

    if (target === 'hermetic') await hermeticUp();

    for (const st of stages) {
        if (st === 'discover') await stageDiscover();
        else if (st === 'regression') { if (target === 'live') { console.log('[regression] skipped on live target'); } else await stageRegression(); }
        else if (st === 'rbac') await stageRbac();
        else if (st === 'db') await stageDb();
    }

    if (target === 'live' && only === 'all') {
        await stageLiveSmoke();
    }

    if (target === 'hermetic') await hermeticDown();
    await disposePool();

    // ---------------- report ----------------
    const summary = {
        generatedAt: new Date().toISOString(),
        target, stages, ok: failCount === 0,
        totals: { checks: results.length, passed: results.length - failCount, failed: failCount },
        failures: results.filter(r => !r.ok),
        warnings: results.filter(r => r.severity === 'warn'),
        results,
    };
    if (jsonOut) fs.writeFileSync(path.resolve(ROOT, jsonOut), JSON.stringify(summary, null, 2));

    console.log('\n==============================================');
    console.log(` RESULTS: ${summary.totals.passed}/${summary.totals.checks} passed, ${failCount} failed`);
    console.log('==============================================');
    for (const r of results.filter(x => !x.ok)) console.log(` FAIL ${r.stage}:${r.id} — ${r.detail}`);
    if (wantIssues && failCount > 0) await fileIssues(summary.failures);

    process.exit(failCount ? 1 : 0);
}

async function fileIssues(failures) {
    for (const f of failures.slice(0, 10)) {
        const title = `[QA FAIL] ${f.stage}: ${f.id}`;
        const body = `Automated QA Commander run (target=${target}).
- **Stage:** ${f.stage}
- **Check:** ${f.id}
- **Failure:** ${f.detail}
- **Time:** ${new Date().toISOString()}

Reproduce: \`node scripts/qa-commander.cjs --target=${target} --only=${f.stage}\``;
        try {
            const out = execFileSync('gh', ['issue', 'create', '--repo', 'Rakesh-7989/garchitects-hrms', '--title', title, '--body', body], { stdio: 'pipe' });
            console.log('  issue filed:', out.toString().trim());
        } catch (e) {
            console.log('  ! could not file issue:', e.message);
        }
    }
}

main().catch(async (e) => {
    console.error('\n[qa-commander] fatal:', e && e.message);
    try { if (target === 'hermetic') await hermeticDown(); await disposePool(); } catch (_) {}
    process.exit(2);
});