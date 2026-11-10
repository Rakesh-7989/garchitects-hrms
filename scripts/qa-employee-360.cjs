#!/usr/bin/env node
/**
 * scripts/qa-employee-360.cjs — the per-employee drill-down
 * (GET /api/employees/:id/activity) + the project-team progress counters.
 *
 * Story: a staff member must be able to pick ONE employee and see their whole
 * picture in one place - attendance for the month (day cells + summary), the
 * recent check-in / check-out details, the daily work logs, the work
 * assignments (open vs completed), leave / WFH and the projects - instead of
 * opening five pages and re-filtering each one.
 *
 * Fix under test:
 *   - the access model: admin/HR company-wide, manager/team_lead own reporting
 *     tree only (+ self), an employee only themselves.
 *   - the month cells must be the SAME cells the attendance matrix shows
 *     (the shared server/utils/attendanceMatrix.js builder).
 *   - the project team list must report each member's assignment progress
 *     (done / open / blocked).
 *
 * Run: node scripts/qa-employee-360.cjs
 *   (needs a running server on :3000 and DATABASE_URL pointing at a throwaway
 *    database; the QA commander provides both)
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const BASE_URL = process.env.QA_BASE_URL || 'http://localhost:3000';
const ts = Date.now();
const _dbUrl = process.env.DATABASE_URL;
const _remote = !/localhost|127\.0\.0\.1|sslmode=disable/.test(_dbUrl || '');
const pool = new Pool({ connectionString: _dbUrl, ssl: _remote ? { rejectUnauthorized: false } : undefined, max: 2 });

let pass = 0, fail = 0;
const results = [];
function check(name, cond, extra) {
    if (cond) { pass++; results.push(`  ✔ ${name}`); }
    else { fail++; results.push(`  ✖ ${name}${extra ? ' — ' + JSON.stringify(extra) : ''}`); }
}

async function api(method, path, token, body) {
    const res = await fetch(BASE_URL + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* not json */ }
    return { status: res.status, json };
}

function pad(n) { return String(n).padStart(2, '0'); }
function dayOffset(off) {
    const d = new Date();
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + off);
    return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}

async function main() {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

    const hash = await bcrypt.hash('Qa!' + ts + 'x', 6);
    const mk = async (code, role, mgr) => {
        const r = await pool.query(
            `INSERT INTO employees (employee_id, first_name, last_name, email, password_hash, joining_date, salary, role, status, must_change_password, department_id, designation_id, reporting_manager_id)
             VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,0,$6,'active',0,1,1,$7)
             ON CONFLICT (employee_id) DO UPDATE SET password_hash=$5, reporting_manager_id=$7 RETURNING id`,
            [code, 'QA', code, code + '@hrms-qa.invalid', hash, role, mgr || null]);
        return r.rows[0].id;
    };
    const adminId = await mk(`qa${ts}adm`, 'admin', null);
    const mgrId = await mk(`qa${ts}mgr`, 'manager', adminId);
    const repId = await mk(`qa${ts}rep`, 'employee', mgrId);
    const otherId = await mk(`qa${ts}oth`, 'employee', adminId);

    // ---- the world the drill-down must report -----------------------------
    await pool.query(
        `INSERT INTO attendance (employee_id, date, check_in, check_out, status, check_in_location, remarks)
         VALUES ($1,$2,'09:30','18:30','present','17.3850,78.4867','seeded')`,
        [repId, dayOffset(-2)]);
    await pool.query(
        `INSERT INTO attendance (employee_id, date, check_in, check_out, status, remarks)
         VALUES ($1,$2,'10:20','18:30','late','traffic')`,
        [repId, dayOffset(-3)]);
    await pool.query(
        `INSERT INTO attendance (employee_id, date, status, remarks) VALUES ($1,$2,'absent','no check-in')`,
        [repId, dayOffset(-4)]);
    await pool.query(
        `INSERT INTO daily_work_logs (employee_id, work_date, title, description) VALUES ($1,$2,'Drafted the lobby elevation','Section A done.')`,
        [repId, dayOffset(-2)]);
    const proj = await pool.query(
        `INSERT INTO projects (name, customer, status) VALUES ($1,'QA Client','active') RETURNING id`,
        [`QA project ${ts}`]);
    const projId = proj.rows[0].id;
    await pool.query(`INSERT INTO project_employees (project_id, employee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [projId, repId]);
    const asg = await pool.query(
        `INSERT INTO work_assignments (project_id, assigned_by, assigned_to, title, priority, start_date, due_date, status)
         VALUES ($1,$2,$3,'Draft the lobby elevation','normal',CURRENT_DATE,CURRENT_DATE + INTERVAL '3 days','in_progress') RETURNING id`,
        [projId, adminId, repId]);
    await pool.query(
        `INSERT INTO work_assignments (project_id, assigned_by, assigned_to, title, priority, start_date, status)
         VALUES ($1,$2,$3,'Site walk','normal',CURRENT_DATE,'completed')`,
        [projId, adminId, repId]);
    await pool.query(
        `INSERT INTO leave_applications (employee_id, start_date, end_date, total_days, reason, status)
         VALUES ($1,$2,$2,1,'Family function','approved')`, [repId, dayOffset(-6)]);
    await pool.query(
        `INSERT INTO wfh_requests (employee_id, start_date, end_date, total_days, reason, status)
         VALUES ($1,$2,$2,1,'Work from home','approved')`, [repId, dayOffset(-5)]);

    const login = async (code, portal) => {
        const r = await api('POST', '/api/auth/login', null, { employee_id: code, password: 'Qa!' + ts + 'x', portal });
        return r.json && r.json.token;
    };

    // ---- 1. the admin drill-down ------------------------------------------
    const adminTok = await login(`qa${ts}adm`, 'admin');
    check('admin login', !!adminTok);
    const act = await api('GET', `/api/employees/${repId}/activity`, adminTok);
    check('GET /employees/:id/activity -> 200 for an admin', act.status === 200 && act.json.success, act.json);
    const body = act.json || {};
    check('payload carries every section',
        ['employee', 'attendance', 'work_logs', 'assignments', 'leave', 'wfh', 'projects'].every(k => k in body),
        Object.keys(body));

    // attendance
    const cells = (body.attendance && body.attendance.cells) || {};
    const now = new Date();
    const dayOf = (off) => {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + off);
        return d.getDate();
    };
    check('the month grid has a cell per day', Object.keys(cells).length === new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(),
        { cells: Object.keys(cells).length });
    check('a present day carries its check-in / check-out',
        cells[dayOf(-2)] && cells[dayOf(-2)].status === 'present' && String(cells[dayOf(-2)].check_in).startsWith('09:30')
        && String(cells[dayOf(-2)].check_out).startsWith('18:30'), cells[dayOf(-2)]);
    check('a late day is reported as late', cells[dayOf(-3)] && cells[dayOf(-3)].status === 'late', cells[dayOf(-3)]);
    const summary = (body.attendance && body.attendance.summary) || {};
    check('the summary counts the present day', summary.present >= 1, summary);
    check('the summary counts the late day', summary.late >= 1, summary);
    check('the summary counts the absent day', summary.absent >= 1, summary);
    const recs = (body.attendance && body.attendance.records) || [];
    check('the recent records carry the check-in details',
        recs.length >= 3 && recs.some(r => r.check_in && r.check_out && String(r.check_in).startsWith('09:30')), recs.slice(0, 2));
    check('a record carries its location', recs.some(r => r.check_in_location), null);

    // work logs
    check('the daily work logs are listed', (body.work_logs || []).length >= 1
        && body.work_logs[0].title === 'Drafted the lobby elevation', body.work_logs);

    // assignments
    const counts = (body.assignments && body.assignments.counts) || {};
    check('the assignment counters split open vs completed',
        counts.open === 1 && counts.completed === 1 && counts.total === 2, counts);
    check('the open assignment carries its project and due date',
        (body.assignments.open || []).length === 1 && body.assignments.open[0].project_name === `QA project ${ts}`
        && !!body.assignments.open[0].due_date, body.assignments.open);

    // leave / wfh / projects
    check('the leave history is listed', (body.leave || []).length >= 1 && body.leave[0].status === 'approved', body.leave);
    check('the WFH history is listed', (body.wfh || []).length >= 1 && body.wfh[0].status === 'approved', body.wfh);
    check('the projects are listed', (body.projects || []).length >= 1 && body.projects[0].name === `QA project ${ts}`, body.projects);

    // ---- 2. the access model ----------------------------------------------
    const mgrTok = await login(`qa${ts}mgr`, 'employee');
    check('manager -> own report -> 200', (await api('GET', `/api/employees/${repId}/activity`, mgrTok)).status === 200);
    check('manager -> out-of-tree employee -> 403', (await api('GET', `/api/employees/${otherId}/activity`, mgrTok)).status === 403);
    check('manager -> self -> 200', (await api('GET', `/api/employees/${mgrId}/activity`, mgrTok)).status === 200);
    const empTok = await login(`qa${ts}rep`, 'employee');
    check('employee -> self -> 200', (await api('GET', `/api/employees/${repId}/activity`, empTok)).status === 200);
    check('employee -> someone else -> 403', (await api('GET', `/api/employees/${otherId}/activity`, empTok)).status === 403);
    check('no token -> 401', (await api('GET', `/api/employees/${repId}/activity`, null)).status === 401);
    check('invalid id -> 400', (await api('GET', '/api/employees/abc/activity', adminTok)).status === 400);
    check('unknown employee -> 404', (await api('GET', '/api/employees/99999999/activity', adminTok)).status === 404);

    // ---- 3. the project team progress --------------------------------------
    const team = await api('GET', `/api/projects/${projId}/employees`, adminTok);
    const member = ((team.json && team.json.employees) || [])[0];
    check('the project team list carries the assignment progress',
        !!member && Number(member.assignments_total) === 2 && Number(member.assignments_completed) === 1
        && Number(member.assignments_open) === 1, member);

    // ---- cleanup ------------------------------------------------------------
    for (const id of [adminId, mgrId, repId, otherId]) {
        await pool.query('DELETE FROM attendance WHERE employee_id = $1', [id]);
        await pool.query('DELETE FROM user_notifications WHERE employee_id = $1', [id]);
        await pool.query('DELETE FROM daily_work_logs WHERE employee_id = $1', [id]);
        await pool.query('DELETE FROM work_assignments WHERE assigned_to = $1 OR assigned_by = $1', [id]);
        await pool.query('DELETE FROM project_employees WHERE employee_id = $1', [id]);
        await pool.query('DELETE FROM leave_applications WHERE employee_id = $1', [id]);
        await pool.query('DELETE FROM wfh_requests WHERE employee_id = $1', [id]);
        await pool.query('DELETE FROM employees WHERE id = $1', [id]);
    }
    await pool.query('DELETE FROM projects WHERE id = $1', [projId]);
    await pool.end();

    console.log(`\nqa-employee-360: ${pass} pass / ${fail} fail`);
    results.forEach(r => console.log(r));
    process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
    console.error('qa-employee-360 fatal:', e.message);
    try { await pool.end(); } catch (_) { /* ignore */ }
    process.exit(1);
});
