#!/usr/bin/env node
/**
 * qa-reg-review.cjs - Regularization review role-scope harness.
 *
 * Boots its own throwaway stack and proves the widened review endpoint:
 *   - manager approves a request for an employee IN their tree   -> 200 (was 403)
 *   - manager approves a request for an employee OUTSIDE tree    -> 403
 *   - admin approves any request                                 -> 200
 *   - approve writes the times into the attendance record
 *   - out-of-tree request is left pending (no attendance row)
 *
 * Run manually (it owns its own PG cluster on 5433, so it must not run
 * alongside the QA commander):  node scripts/qa-reg-review.cjs
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const net = require('net');
const { execFileSync, spawn } = require('child_process');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const ROOT = path.resolve(__dirname, '..');
const PG_BIN = process.env.PG_BIN || 'C:\\Program Files\\PostgreSQL\\16\\bin';
const QA_CLUSTER = process.env.QA_CLUSTER_DIR || path.join(process.env.TEMP || 'C:\\Users\\boyap\\AppData\\Local\\Temp', 'opencode', 'pg16qa');
const PG_PORT = 5433, SRV_PORT = 3000;
const DB_URL = `postgresql://postgres@127.0.0.1:${PG_PORT}/garchitects_hrms`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killByPort(port) {
    try {
        const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
        const pids = new Set();
        for (const line of out.split(/\r?\n/)) { const m = line.trim().match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i); if (m && parseInt(m[1], 10) === port && m[2] !== '0') pids.add(m[2]); }
        for (const pid of pids) { try { execFileSync('taskkill', ['/F', '/PID', pid], { stdio: 'ignore' }); } catch (_) {} }
    } catch (_) {}
}
async function pgReady(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        try { execFileSync(path.join(PG_BIN, 'psql.exe'), ['-h', '127.0.0.1', '-p', String(PG_PORT), '-U', 'postgres', '-d', 'postgres', '-c', 'SELECT 1'], { stdio: 'ignore', timeout: 5000 }); return true; } catch (_) { await sleep(700); }
    }
    return false;
}
async function waitHttp(url, timeoutMs = 45000, probe = null) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        try { const r = await fetch(url, probe ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(probe), signal: AbortSignal.timeout(4000) } : { signal: AbortSignal.timeout(4000) }); return r.status; } catch (_) { await sleep(800); }
    }
    return null;
}

(async () => {
    let pass = 0, fail = 0;
    const check = (name, cond, detail) => { console.log((cond ? '  PASS ' : '  FAIL ') + name + (detail ? ' — ' + detail : '')); cond ? pass++ : fail++; };
    try {
        killByPort(SRV_PORT); killByPort(PG_PORT);
        if (fs.existsSync(QA_CLUSTER)) {
            try { execFileSync(path.join(PG_BIN, 'pg_ctl.exe'), ['stop', '-D', QA_CLUSTER, '-m', 'fast'], { stdio: 'ignore', timeout: 20000 }); } catch (_) {}
            await sleep(800); fs.rmSync(QA_CLUSTER, { recursive: true, force: true });
        }
        execFileSync(path.join(PG_BIN, 'initdb.exe'), ['-D', QA_CLUSTER, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C', '--no-instructions'], { stdio: 'pipe', timeout: 90000 });
        execFileSync(path.join(PG_BIN, 'pg_ctl.exe'), ['start', '-D', QA_CLUSTER, '-l', path.join(path.dirname(QA_CLUSTER), 'qa-pg.log'), '-o', '-p ' + PG_PORT], { stdio: 'ignore', timeout: 30000 });
        if (!(await pgReady(25000))) throw new Error('pg not up');
        try { execFileSync(path.join(PG_BIN, 'createdb.exe'), ['-h', '127.0.0.1', '-p', String(PG_PORT), '-U', 'postgres', 'garchitects_hrms'], { stdio: 'pipe', timeout: 20000 }); } catch (_) {}
        const tmpSql = path.join(path.dirname(QA_CLUSTER), 'qa-schema.sql');
        fs.writeFileSync(tmpSql, fs.readFileSync(path.join(ROOT, 'server', 'schema.sql'), 'utf8'));
        execFileSync(path.join(PG_BIN, 'psql.exe'), ['-h', '127.0.0.1', '-p', String(PG_PORT), '-U', 'postgres', '-d', 'garchitects_hrms', '-v', 'ON_ERROR_STOP=1', '-f', tmpSql], { stdio: 'pipe', timeout: 60000 });

        const outFd = fs.openSync(path.join(path.dirname(QA_CLUSTER), 'qa-server.out.log'), 'a');
        const errFd = fs.openSync(path.join(path.dirname(QA_CLUSTER), 'qa-server.err.log'), 'a');
        spawn('node', ['server/index.js'], { cwd: ROOT, windowsHide: true, detached: true, stdio: ['ignore', outFd, errFd], env: { ...process.env, DATABASE_URL: DB_URL } }).unref();
        const st = await waitHttp(`http://localhost:${SRV_PORT}/api/auth/login`, 45000, { employee_id: 'x', password: 'y', portal: 'employee' });
        if (st !== 401) throw new Error('server not healthy: ' + st);

        const pool = new Pool({ connectionString: DB_URL, max: 4 });
        const pw = 'Test!2026';
        const hash = await bcrypt.hash(pw, 6);
        const ins = async (eid, fn, role, mgr) => {
            await pool.query(`INSERT INTO employees (employee_id, first_name, last_name, email, password_hash, joining_date, salary, role, status, must_change_password, reporting_manager_id)
                VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,0,$6,'active',0,$7) ON CONFLICT (employee_id) DO NOTHING`, [eid, fn, fn.toUpperCase(), `${eid}@hrms-qa.invalid`, hash, role, mgr]);
            return (await pool.query('SELECT id FROM employees WHERE employee_id=$1', [eid])).rows[0].id;
        };
        const adminId = await ins('radmin1', 'Reg', 'admin', null);
        const mgr1Id = await ins('rmgr1', 'One', 'manager', adminId);
        const mgr2Id = await ins('rmgr2', 'Two', 'manager', adminId);
        const emp1Id = await ins('remp1', 'Emp', 'employee', mgr1Id);   // in mgr1's tree
        await ins('remp2', 'Emp2', 'employee', mgr2Id);                  // in mgr2's tree only

        const login = async (eid) => {
            const r = await fetch(`http://localhost:${SRV_PORT}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ employee_id: eid, password: pw, portal: eid === 'radmin1' ? 'admin' : 'employee' }) });
            return (await r.json()).token;
        };
        const empTok = await login('remp1');
        const mgr1Tok = await login('rmgr1');
        const mgr2Tok = await login('rmgr2');
        const adminTok = await login('radmin1');

        // employee1 submits 3 regularization requests (3 distinct past dates this month)
        const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        const y = todayIST.slice(0, 4), mo = todayIST.slice(5, 7);
        const dates = [`${y}-${mo}-01`, `${y}-${mo}-02`, `${y}-${mo}-03`];
        const regIds = [];
        for (const d of dates) {
            const r = await fetch(`http://localhost:${SRV_PORT}/api/regularization`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + empTok }, body: JSON.stringify({ date: d, check_in: '09:00', check_out: '18:00', reason: 'forgot to check in' }) });
            const j = await r.json();
            regIds.push(j && j.request && j.request.id);
        }
        check('employee submits 3 regularization requests', regIds.every(Boolean), 'ids=' + regIds.join(','));

        const review = async (tok, id) => {
            const r = await fetch(`http://localhost:${SRV_PORT}/api/regularization/${id}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ status: 'approved', review_note: 'ok' }) });
            return r.status;
        };

        const s1 = await review(mgr1Tok, regIds[0]);
        check('manager approves request for employee IN their tree -> 200', s1 === 200, 'HTTP ' + s1);

        const s2 = await review(mgr2Tok, regIds[1]);
        check('manager approves request for employee OUTSIDE tree -> 403', s2 === 403, 'HTTP ' + s2);

        const s3 = await review(adminTok, regIds[2]);
        check('admin approves any request -> 200', s3 === 200, 'HTTP ' + s3);

        // verify attendance write-back for the two approved ones
        const a1 = (await pool.query(`SELECT check_in, check_out, status FROM attendance WHERE employee_id=$1 AND date=$2`, [emp1Id, dates[0]])).rows[0];
        check('approved request wrote times into attendance (mgr1)', a1 && a1.check_in === '09:00:00' && a1.status === 'present', JSON.stringify(a1));
        const a3 = (await pool.query(`SELECT check_in, status FROM attendance WHERE employee_id=$1 AND date=$2`, [emp1Id, dates[2]])).rows[0];
        check('approved request wrote times into attendance (admin)', a3 && a3.status === 'present', JSON.stringify(a3));
        const a2 = (await pool.query(`SELECT id FROM attendance WHERE employee_id=$1 AND date=$2`, [emp1Id, dates[1]])).rows[0];
        check('out-of-tree request NOT written (still pending, no attendance row)', !a2, a2 ? 'unexpected row' : 'no row');

        await pool.end();
        console.log(`\n[reg-review] ${pass} passed, ${fail} failed`);
        if (fail === 0) console.log('[reg-review] PASS');
    } catch (e) {
        console.error('ERROR:', (e && e.message) || e);
    } finally {
        killByPort(SRV_PORT);
        try { execFileSync(path.join(PG_BIN, 'pg_ctl.exe'), ['stop', '-D', QA_CLUSTER, '-m', 'fast', '-w'], { stdio: 'ignore', timeout: 20000 }); } catch (_) {}
        try { fs.rmSync(QA_CLUSTER, { recursive: true, force: true }); } catch (_) {}
    }
    process.exit(fail === 0 ? 0 : 1);
})();
