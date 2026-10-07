/**
 * qa-work-assignments-v2.mjs — live QA harness for the Work Assignments v2
 * redesign (blocked status, cancel semantics, IDOR, daily-log link integrity,
 * permanent-delete FK cleanup).
 *
 * Creates a throwaway world in the DATABASE_URL DB (admin/manager/employee/
 * victim + assignments + daily logs), drives the running server's API
 * (BASE_URL, default http://localhost:3000 — start `npm start` first), then
 * rolls the whole world back so the DB stays pristine.
 *
 * Run:  node scripts/qa-work-assignments-v2.cjs
 *
 * Note: the login route rate-limits to 10 attempts per 15 min per IP, and this
 * harness performs 4 logins per run. Rerun within that window only after
 * restarting the server (the limiter is in-memory, so a restart resets it).
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

let pass = 0, fail = 0, world = {};
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

let started = { server: false };

async function main() {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

    // ---- 1. Throwaway world -------------------------------------------------
    const hashes = {};
    const roles = ['adm', 'mgr', 'emp', 'vic'];
    for (const r of roles) hashes[r] = await bcrypt.hash('Qa!' + ts + r, 6);

    const mk = async (role, tag) => {
        const r = await pool.query(
            `INSERT INTO employees (employee_id, first_name, last_name, email, password_hash, joining_date, salary, role, status, must_change_password)
             VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, 0, $6, 'active', 0)
             RETURNING id`,
            [`qa${ts}${tag}`, 'QA', tag.toUpperCase(), `qa${ts}${tag}@hrms-qa.invalid`, hashes[tag], role]
        );
        return { id: r.rows[0].id, employee_id: `qa${ts}${tag}`, password: 'Qa!' + ts + tag };
    };

    world.admin = await mk('admin', 'adm');
    world.manager = await mk('manager', 'mgr');
    world.employee = await mk('employee', 'emp');
    world.victim = await mk('employee', 'vic');

    console.log('[QA] throwaway world created:', Object.fromEntries(Object.entries(world).map(([k, v]) => [k, v.id])));

    // ---- 2. Logins ----------------------------------------------------------
    const login = async (tag, portal) => {
        const r = await api('POST', '/api/auth/login', null, { employee_id: world[tag].employee_id, password: world[tag].password, portal });
        return r.json && r.json.token;
    };
    const T = {
        admin: await login('admin', 'admin'),
        manager: await login('manager', 'employee'),
        employee: await login('employee', 'employee'),
        victim: await login('victim', 'employee'),
    };
    check('login: admin', !!T.admin);
    check('login: manager', !!T.manager);
    check('login: employee', !!T.employee);
    check('login: victim', !!T.victim);

    const mkAssignment = (token, assignedTo, title) => api('POST', '/api/work-assignments', token, {
        title, description: 'QA harness', priority: 'normal',
        assignedTo, startDate: '2026-10-01', dueDate: '2026-10-15'
    });

    // ---- 3. Core matrix -----------------------------------------------------
    const a1 = await mkAssignment(T.manager, world.employee.id, `QA A1 ${ts}`);
    check('manager creates A1 (201)', a1.status === 201, a1.json);
    const a1id = a1.json && a1.json.assignment && a1.json.assignment.id;

    const a2 = await mkAssignment(T.manager, world.victim.id, `QA A2 ${ts}`);
    check('manager creates A2 (201)', a2.status === 201, a2.json);
    const a2id = a2.json && a2.json.assignment && a2.json.assignment.id;

    // Born-closed status rejected.
    const bornClosed = await api('POST', '/api/work-assignments', T.manager, {
        title: `QA born-closed ${ts}`, assignedTo: world.employee.id, status: 'completed',
        startDate: '2026-10-01', dueDate: '2026-10-15'
    });
    check('POST status=completed rejected (400)', bornClosed.status === 400, bornClosed.json);

    // GET /my scoping.
    const myE = await api('GET', '/api/work-assignments/my', T.employee);
    const myV = await api('GET', '/api/work-assignments/my', T.victim);
    check('employee sees own assignment', (myE.json.assignments || []).some(a => a.id === a1id));
    check('employee does NOT see other\'s assignment', !(myE.json.assignments || []).some(a => a.id === a2id));
    check('victim sees own assignment', (myV.json.assignments || []).some(a => a.id === a2id));

    // State machine: assignee.
    const stStart = await api('PUT', `/api/work-assignments/${a1id}`, T.employee, { status: 'in_progress' });
    check('assignee start (200)', stStart.status === 200 && stStart.json.success, stStart.json);
    const startedAtSet = await api('GET', '/api/work-assignments/my', T.employee);
    check('started_at recorded', (startedAtSet.json.assignments || []).find(a => a.id === a1id)?.started_at, startedAtSet.json);

    const stBlockNoReason = await api('PUT', `/api/work-assignments/${a1id}`, T.employee, { status: 'blocked' });
    check('block without reason (400)', stBlockNoReason.status === 400, stBlockNoReason.json);
    const stBlock = await api('PUT', `/api/work-assignments/${a1id}`, T.employee, { status: 'blocked', blockedReason: 'awaiting client approval' });
    check('block with reason (200)', stBlock.status === 200 && stBlock.json.success, stBlock.json);
    check('blocked_reason persisted', stBlock.json.assignment?.blocked_reason === 'awaiting client approval', stBlock.json.assignment);

    const stCancel = await api('PUT', `/api/work-assignments/${a1id}`, T.employee, { status: 'cancelled', cancelReason: 'x' });
    check('assignee cancel denied (403)', stCancel.status === 403, stCancel.json);

    const stTitle = await api('PUT', `/api/work-assignments/${a1id}`, T.employee, { title: 'hack' });
    check('assignee cannot edit fields (400)', stTitle.status === 400, stTitle.json);

    const vicPut = await api('PUT', `/api/work-assignments/${a1id}`, T.victim, { status: 'in_progress' });
    check('unrelated employee PUT denied (403)', vicPut.status === 403, vicPut.json);

    // Cancellation by the assigner requires a reason; then works.
    const cNoReason = await api('PUT', `/api/work-assignments/${a1id}`, T.manager, { status: 'cancelled' });
    check('assigner cancel without reason (400)', cNoReason.status === 400, cNoReason.json);
    const unblock = await api('PUT', `/api/work-assignments/${a1id}`, T.manager, { status: 'in_progress' });
    check('assigner unblocks (200)', unblock.status === 200 && unblock.json.success, unblock.json);
    check('blocked_reason cleared after unblock', !unblock.json.assignment?.blocked_reason, unblock.json.assignment);
    const cOk = await api('PUT', `/api/work-assignments/${a1id}`, T.manager, { status: 'cancelled', cancelReason: 'client dropped scope' });
    check('assigner cancels with reason (200)', cOk.status === 200 && cOk.json.assignment?.cancel_reason === 'client dropped scope', cOk.json);
    check('cancelled_at recorded', !!cOk.json.assignment?.cancelled_at, cOk.json.assignment);

    const reopen = await api('PUT', `/api/work-assignments/${a1id}`, T.manager, { status: 'in_progress' });
    check('terminal has no outgoing moves (400)', reopen.status === 400, reopen.json);

    // Timeline sanity: assigner cancels with due date earlier than start rejected.
    const badDates = await api('PUT', `/api/work-assignments/${a2id}`, T.manager, { startDate: '2026-10-20', dueDate: '2026-10-10' });
    check('due < start rejected (400)', badDates.status === 400, badDates.json);
    // Partial edit (only dueDate) must still be checked against existing start.
    const badDueOnly = await api('PUT', `/api/work-assignments/${a2id}`, T.manager, { dueDate: '2026-09-01' });
    check('partial due-only earlier than start rejected (400)', badDueOnly.status === 400, badDueOnly.json);

    // Daily-work-log link integrity (H1): the employee may NOT link to victim's assignment.
    const a3 = await mkAssignment(T.manager, world.employee.id, `QA A3 ${ts}`);
    const a3id = a3.json && a3.json.assignment && a3.json.assignment.id;

    const idorLog = await api('POST', '/api/daily-work-logs', T.employee, {
        work_date: '2026-10-07', title: `QA log idor ${ts}`, assignmentId: a2id
    });
    check('log link to OTHER person\'s assignment rejected (404)', idorLog.status === 404, idorLog.json);

    const ownLog = await api('POST', '/api/daily-work-logs', T.employee, {
        work_date: '2026-10-07', title: `QA log own ${ts}`, assignmentId: a3id
    });
    check('log link to OWN assignment ok (201)', ownLog.status === 201, ownLog.json);
    const logs = await api('GET', '/api/daily-work-logs', T.employee);
    const logId = (logs.json.logs || []).find(l => l.assignment_id === a3id)?.id;
    check('log id resolvable for edit', !!logId, logs.json);

    // Daily-log PUT now honours work_date (M11).
    const logMove = await api('PUT', `/api/daily-work-logs/${logId}`, T.employee, {
        title: `QA log own ${ts}`, work_date: '2026-10-08', assignmentId: a3id
    });
    check('log work_date move ok (200)', logMove.status === 200, logMove.json);

    // Bad log date rejected (M9 - garbage must not 500).
    const badLogDate = await api('POST', '/api/daily-work-logs', T.employee, {
        work_date: 'not-a-date', title: `QA bad ${ts}`
    });
    check('log with garbage date rejected (400)', badLogDate.status === 400, badLogDate.json);
    // Non-ISO but parseable dates are coerced leniently (dateOnly), never 500.
    const lenientDate = await api('POST', '/api/daily-work-logs', T.employee, {
        work_date: '12/31/2026', title: `QA lenient ${ts}`
    });
    check('log with non-ISO parseable date coerced (201)', lenientDate.status === 201, lenientDate.json);

    // Assignee cannot delete; assigner can.
    const delByEmp = await api('DELETE', `/api/work-assignments/${a3id}`, T.employee);
    check('assignee delete denied (403)', delByEmp.status === 403, delByEmp.json);
    const delByMgr = await api('DELETE', `/api/work-assignments/${a3id}`, T.manager);
    check('assigner delete ok (200)', delByMgr.status === 200, delByMgr.json);

    // Permanent delete unblocked by the WA FK cleanup (H2): employee AND victim
    // both have live work_assignments rows pointing at them.
    const delEmp = await api('DELETE', `/api/employees/${world.employee.id}/permanent`, T.admin);
    check('permanent delete of assignee ok (200)', delEmp.status === 200, delEmp.json);
    const delVic = await api('DELETE', `/api/employees/${world.victim.id}/permanent`, T.admin);
    check('permanent delete of other assignee ok (200)', delVic.status === 200, delVic.json);

    // Verify the employee/victim world is actually gone (manager/admin still exist here).
    const leftovers = await pool.query(
        `SELECT (SELECT COUNT(*) FROM work_assignments WHERE id = ANY($1)) AS wa,
                (SELECT COUNT(*) FROM daily_work_logs WHERE employee_id IN ($2, $3)) AS dwl,
                (SELECT COUNT(*) FROM employees WHERE id IN ($2, $3)) AS emp`,
        [[a1id, a2id, a3id], world.employee.id, world.victim.id]
    );
    const lf = leftovers.rows[0];
    check('QA employee/victim assignments+logs+rows fully removed', parseInt(lf.wa, 10) === 0 && parseInt(lf.dwl, 10) === 0 && parseInt(lf.emp, 10) === 0, lf);

    // ---- 4. Cleanup (remaining temp users) ----------------------------------
    for (const key of ['manager', 'admin']) {
        await pool.query(
            `DELETE FROM work_assignments WHERE assigned_by = $1 OR assigned_to = $1`, [world[key].id]);
        await pool.query(`DELETE FROM employees WHERE id = $1`, [world[key].id]);
    }
    const finalEmp = await pool.query(`SELECT COUNT(*) AS n FROM employees WHERE employee_id LIKE 'qa${ts}%'`);
    check('all QA employees fully removed after cleanup', finalEmp.rows[0].n === '0' || finalEmp.rows[0].n === 0, finalEmp.rows[0]);
}

async function cleanup() {
    try {
        // Best-effort: remove any leftover assignment/log/employee rows from this run.
        await pool.query(`DELETE FROM work_assignments WHERE title LIKE 'QA %' OR title LIKE 'QA%'`);
        await pool.query(`DELETE FROM daily_work_logs WHERE title LIKE 'QA %' OR title LIKE 'QA%'`);
        await pool.query(`DELETE FROM employees WHERE employee_id LIKE 'qa${ts}%'`);
    } catch (e) {
        console.log('[QA] cleanup note (non-fatal):', e.message);
    }
    await pool.end();
}

process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

main()
    .catch((e) => { fail++; results.push('  ✖ harness error: ' + (e && e.stack || e)); })
    .finally(async () => {
        await cleanup();
        console.log('\n[QA] work-assignments v2 results:');
        console.log(results.join('\n'));
        console.log(`\n${pass} passed, ${fail} failed`);
        process.exit(fail === 0 ? 0 : 1);
    });