/**
 * qa-runtime-errors.cjs — live QA harness for the three runtime errors
 * observed on Vercel over the previous 7 days (audit snapshot 18 Oct 2026):
 *
 *   1. `dateOnly is not defined` in server/routes/projects.js
 *      -> GET /api/projects must return 200, not 500.
 *   2. team-updates SQL `integer = date` type mismatch
 *      -> GET /api/team-updates?date=YYYY-MM-DD must return 200, not 500.
 *   3. audit-log writes timing out on database connection
 *      -> GET /api/audit-logs must return 200 (admin reads the trail fine).
 *
 * All three are already fixed in master (HEAD 8518f37). This harness proves
 * they stay fixed by driving the running server's API and asserting status
 * codes + response shapes. It seeds a throwaway admin + employee + project,
 * then rolls the world back so the DB stays pristine.
 *
 * Run:  node scripts/qa-runtime-errors.cjs
 *   (start `npm start` first; DATABASE_URL must point at a throwaway DB)
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const BASE_URL = process.env.QA_BASE_URL || 'http://localhost:3000';
const ts = Date.now();
const _dbUrl = process.env.DATABASE_URL;
const _remote = !/localhost|127\.0\.0\.1|sslmode=disable/.test(_dbUrl || '');
const pool = new Pool({
    connectionString: _dbUrl,
    ssl: _remote ? { rejectUnauthorized: false } : undefined,
    max: 2,
});

let pass = 0, fail = 0;
const results = [];
function check(name, cond, extra) {
    if (cond) { pass++; results.push(`  ✔ ${name}`); }
    else { fail++; results.push(`  ✖ ${name}${extra ? ' — ' + JSON.stringify(extra) : ''}`); }
}

async function api(method, path, token, body) {
    const res = await fetch(BASE_URL + path, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: 'Bearer ' + token } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON */ }
    return { status: res.status, json };
}

function todayLocal() {
    // YYYY-MM-DD in the server's local timezone (matches team-updates resolveDate fallback).
    return new Date().toISOString().slice(0, 10);
}

async function main() {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

    // ---- 1. Throwaway world -------------------------------------------------
    const adminHash = await bcrypt.hash('Qa!' + ts + 'adm', 6);
    const empHash = await bcrypt.hash('Qa!' + ts + 'emp', 6);

    const admin = await pool.query(
        `INSERT INTO employees (employee_id, first_name, last_name, email, password_hash, joining_date, salary, role, status, must_change_password)
         VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,0,'admin','active',0) RETURNING id`,
        [`qa${ts}adm`, 'QA', 'ADMIN', `qa${ts}adm@hrms-qa.invalid`, adminHash]);
    const adminId = admin.rows[0].id;

    const emp = await pool.query(
        `INSERT INTO employees (employee_id, first_name, last_name, email, password_hash, joining_date, salary, role, status, must_change_password, reporting_manager_id)
         VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,0,'employee','active',0,$6) RETURNING id`,
        [`qa${ts}emp`, 'QA', 'EMP', `qa${ts}emp@hrms-qa.invalid`, empHash, adminId]);
    const empId = emp.rows[0].id;

    const proj = await pool.query(
        `INSERT INTO projects (name, customer, description, status)
         VALUES ($1,$2,$3,'active') RETURNING id`,
        [`QA Project ${ts}`, 'QA', 'Throwaway project for runtime-error regression']);
    const projId = proj.rows[0].id;

    await pool.query(
        `INSERT INTO project_employees (project_id, employee_id, status)
         VALUES ($1,$2,'active')`,
        [projId, empId]);

    // ---- 2. Login as admin --------------------------------------------------
    const login = await api('POST', '/api/auth/login', null, {
        employee_id: `qa${ts}adm`, password: 'Qa!' + ts + 'adm', portal: 'admin'
    });
    const token = (login.json && login.json.token) || null;
    check('admin login succeeds', !!token, { status: login.status });

    // ---- 3. Error #1: dateOnly in projects.js -------------------------------
    const projects = await api('GET', '/api/projects', token);
    check('GET /api/projects returns 200 (no dateOnly 500)',
        projects.status === 200, { status: projects.status, body: projects.json });
    check('/api/projects response is {success:true, projects:array}',
        projects.status === 200 && projects.json && projects.json.success === true && Array.isArray(projects.json.projects),
        { keys: projects.json ? Object.keys(projects.json) : null });

    // ---- 4. Error #2: team-updates integer = date mismatch ------------------
    const date = todayLocal();
    const tu = await api('GET', '/api/team-updates?date=' + encodeURIComponent(date), token);
    check('GET /api/team-updates returns 200 (no integer=date 500)',
        tu.status === 200, { status: tu.status, date, body: tu.json });
    check('/api/team-updates response has expected keys',
        tu.status === 200 && tu.json && tu.json.success === true &&
        typeof tu.json.date === 'string' && Array.isArray(tu.json.members),
        { keys: tu.json ? Object.keys(tu.json) : null });

    // ---- 5. Error #3: audit-log write/read timeout -------------------------
    const al = await api('GET', '/api/audit-logs?limit=5', token);
    check('GET /api/audit-logs returns 200 (no DB timeout)',
        al.status === 200, { status: al.status, body: al.json });
    check('/api/audit-logs response has logs array',
        al.status === 200 && al.json && al.json.success === true && Array.isArray(al.json.logs),
        { keys: al.json ? Object.keys(al.json) : null });

    // ---- 6. Rollback the world ---------------------------------------------
    await pool.query('DELETE FROM project_employees WHERE project_id = $1', [projId]);
    await pool.query('DELETE FROM projects WHERE id = $1', [projId]);
    await pool.query('DELETE FROM employees WHERE id = $1', [empId]);
    await pool.query('DELETE FROM employees WHERE id = $1', [adminId]);

    await pool.end();

    // ---- report -------------------------------------------------------------
    console.log(`\nqa-runtime-errors: ${pass} pass / ${fail} fail`);
    results.forEach(r => console.log(r));
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error('qa-runtime-errors fatal:', e.message);
    process.exit(1);
});
