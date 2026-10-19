/**
 * scripts/qa-wfh-tickets.cjs — live QA harness for WFH / tickets business logic:
 *
 *   1. WFH apply (employee) -> 200; admin apply -> 403 (blockAdminSelfService).
 *   2. WFH approve by HR -> 200 (TOCTOU-safe: second approve of same row -> 409).
 *   3. Tickets create (employee) -> 200; tickets respond by HR -> 200.
 *
 * Seeds a throwaway employee + HR, drives the running server's API,
 * rolls the world back so the DB stays pristine.
 *
 * Run:  node scripts/qa-wfh-tickets.cjs
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

async function main() {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

    // ---- 1. Throwaway world -------------------------------------------------
    const empHash = await bcrypt.hash('Qa!' + ts + 'emp', 6);
    const hrHash = await bcrypt.hash('Qa!' + ts + 'hr', 6);

    const emp = await pool.query(
        `INSERT INTO employees (employee_id, first_name, last_name, email, password_hash, joining_date, salary, role, status, must_change_password)
         VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,0,'employee','active',0) RETURNING id`,
        [`qa${ts}emp`, 'QA', 'EMP', `qa${ts}emp@hrms-qa.invalid`, empHash]);
    const empId = emp.rows[0].id;

    const hr = await pool.query(
        `INSERT INTO employees (employee_id, first_name, last_name, email, password_hash, joining_date, salary, role, status, must_change_password)
         VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,0,'hr','active',0) RETURNING id`,
        [`qa${ts}hr`, 'QA', 'HR', `qa${ts}hr@hrms-qa.invalid`, hrHash]);
    const hrId = hr.rows[0].id;

    const today = new Date().toISOString().slice(0, 10);

    // ---- 2. Logins ----------------------------------------------------------
    const empLogin = await api('POST', '/api/auth/login', null, {
        employee_id: `qa${ts}emp`, password: 'Qa!' + ts + 'emp', portal: 'employee'
    });
    const empTok = (empLogin.json && empLogin.json.token) || null;
    check('employee login succeeds', !!empTok, { status: empLogin.status });

    const hrLogin = await api('POST', '/api/auth/login', null, {
        employee_id: `qa${ts}hr`, password: 'Qa!' + ts + 'hr', portal: 'employee'
    });
    const hrTok = (hrLogin.json && hrLogin.json.token) || null;
    check('hr login succeeds', !!hrTok, { status: hrLogin.status });

    // ---- 3. WFH apply (employee) -> 200 ------------------------------------
    const wfhApply = await api('POST', '/api/wfh/apply', empTok, {
        start_date: today, end_date: today, total_days: 1, reason: 'QA WFH test'
    });
    check('WFH apply (employee) -> 200',
        wfhApply.status === 200, { status: wfhApply.status, body: wfhApply.json });

    // ---- 4. WFH apply (admin) -> 403 (blockAdminSelfService) ---------------
    const adminHash = await bcrypt.hash('Qa!' + ts + 'adm', 6);
    const admin = await pool.query(
        `INSERT INTO employees (employee_id, first_name, last_name, email, password_hash, joining_date, salary, role, status, must_change_password)
         VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,0,'admin','active',0) RETURNING id`,
        [`qa${ts}adm`, 'QA', 'ADMIN', `qa${ts}adm@hrms-qa.invalid`, adminHash]);
    const adminId = admin.rows[0].id;

    const adminLogin = await api('POST', '/api/auth/login', null, {
        employee_id: `qa${ts}adm`, password: 'Qa!' + ts + 'adm', portal: 'admin'
    });
    const adminTok = (adminLogin.json && adminLogin.json.token) || null;
    const wfhAdmin = await api('POST', '/api/wfh/apply', adminTok, {
        start_date: today, end_date: today, total_days: 1, reason: 'QA admin WFH'
    });
    check('WFH apply (admin) -> 403 (ADMIN_NOT_EMPLOYEE)',
        wfhAdmin.status === 403, { status: wfhAdmin.status, body: wfhAdmin.json });

    // ---- 5. WFH approve by HR -> 200 ---------------------------------------
    // Find the WFH request id created above.
    const wfhRows = await pool.query(
        `SELECT id FROM wfh_requests WHERE employee_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [empId]);
    const wfhId = wfhRows.rows.length > 0 ? wfhRows.rows[0].id : null;
    check('WFH request row exists', wfhId !== null);

    if (wfhId) {
        const wfhApprove = await api('PUT', `/api/wfh/approve/${wfhId}`, hrTok, {
            status: 'approved', review_note: 'QA approved'
        });
        check('WFH approve (HR) -> 200',
            wfhApprove.status === 200, { status: wfhApprove.status, body: wfhApprove.json });

        // ---- 6. TOCTOU: second approve of same (now-approved) row -> 409 ---
        const wfhApprove2 = await api('PUT', `/api/wfh/approve/${wfhId}`, hrTok, {
            status: 'approved', review_note: 'QA double approve'
        });
        check('WFH double approve -> 409 (TOCTOU-safe)',
            wfhApprove2.status === 409, { status: wfhApprove2.status });
    }

    // ---- 7. Tickets create (employee) -> 200 -------------------------------
    const ticketCreate = await api('POST', '/api/tickets', empTok, {
        category: 'access', subject: 'QA ticket test', description: 'Test ticket',
        priority: 'medium'
    });
    check('Tickets create (employee) -> 200',
        ticketCreate.status === 200, { status: ticketCreate.status, body: ticketCreate.json });

    // ---- 8. Tickets respond (HR) -> 200 ------------------------------------
    const ticketRows = await pool.query(
        `SELECT id FROM support_tickets WHERE employee_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [empId]);
    const ticketId = ticketRows.rows.length > 0 ? ticketRows.rows[0].id : null;
    check('Ticket row exists', ticketId !== null);

    if (ticketId) {
        const ticketRespond = await api('PUT', `/api/tickets/respond/${ticketId}`, hrTok, {
            status: 'resolved', admin_response: 'QA resolved'
        });
        check('Tickets respond (HR) -> 200',
            ticketRespond.status === 200, { status: ticketRespond.status, body: ticketRespond.json });
    }

    // ---- 9. Rollback the world ---------------------------------------------
    await pool.query('DELETE FROM support_tickets WHERE employee_id = $1', [empId]);
    await pool.query('DELETE FROM wfh_requests WHERE employee_id = $1', [empId]);
    await pool.query('DELETE FROM employees WHERE id = $1', [empId]);
    await pool.query('DELETE FROM employees WHERE id = $1', [hrId]);
    await pool.query('DELETE FROM employees WHERE id = $1', [adminId]);
    await pool.end();

    // ---- report -------------------------------------------------------------
    console.log(`\nqa-wfh-tickets: ${pass} pass / ${fail} fail`);
    results.forEach(r => console.log(r));
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error('qa-wfh-tickets fatal:', e.message);
    process.exit(1);
});
