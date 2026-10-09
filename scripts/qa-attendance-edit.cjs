/**
 * qa-attendance-edit.cjs — live QA harness for the staff attendance editor.
 *
 * Story: admins/HR may correct any employee's attendance day; a manager may
 * correct only their own reporting tree; team_lead keeps its existing
 * mark-present/absent power only (no rich editor); employees may not edit.
 * The editor is a single day: status (present/late/half-day/absent/wfh) plus
 * optional check-in/check-out/remarks, with validation.
 *
 * Fix under test:
 *   - GET  /api/attendance/record  → one day + day context (holiday/weekoff/
 *     leave/WFH/future/today) for the edit modal.
 *   - POST /api/attendance/edit    → role/scope-guarded single-day write.
 *     absent & wfh clear times/breaks; present-like statuses need a check-in;
 *     a manual check-out clears the machine's auto_checkout marker + reason.
 *   - manager.js /attendance ships per-row `editable` (admin/hr all; manager
 *     own tree; team_lead false).
 *
 * Run:
 *   1. Start the server (hermetic local Postgres; this machine is IST).
 *   2. node scripts/qa-attendance-edit.cjs
 *
 * The login route rate-limits to 10 attempts per 15 min per IP and this
 * harness does 5 logins per run - restart the server before a rerun.
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const BASE_URL = process.env.QA_BASE_URL || 'http://localhost:3000';
const ts = Date.now();
const _dbUrl = process.env.DATABASE_URL;
const _remote = !/localhost|127\.0\.0\.1|sslmode=disable/.test(_dbUrl || '');
const pool = new Pool({ connectionString: _dbUrl, ssl: _remote ? { rejectUnauthorized: false } : undefined, max: 2 });

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

function todayIST() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}
function futureIST() {
    return new Date(Date.now() + 24 * 3600 * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

async function cleanup() {
    try {
        for (const k of Object.keys(world)) {
            await pool.query(`DELETE FROM attendance WHERE employee_id = $1`, [world[k].id]);
        }
        for (const k of Object.keys(world)) {
            await pool.query(`DELETE FROM audit_logs WHERE actor_id = $1`, [world[k].id]);
        }
        for (const k of Object.keys(world)) {
            await pool.query(`DELETE FROM employees WHERE id = $1`, [world[k].id]);
        }
        const left = await pool.query(`SELECT COUNT(*) AS n FROM employees WHERE employee_id LIKE 'qa${ts}%'`);
        return parseInt(left.rows[0].n, 10);
    } catch (e) {
        console.log('[QA] cleanup note (non-fatal):', e.message);
        return -1;
    }
}

async function main() {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

    const today = todayIST();
    const future = futureIST();

    // ---- 1. Throwaway world -------------------------------------------------
    const hashes = {};
    const roles = { adm: 'admin', mgr: 'manager', emp: 'employee', other: 'employee', lead: 'team_lead' };
    for (const tag of Object.keys(roles)) hashes[tag] = await bcrypt.hash('Qa!' + ts + tag, 6);

    const mk = async (tag) => {
        const r = await pool.query(
            `INSERT INTO employees (employee_id, first_name, last_name, email, password_hash, joining_date, salary, role, status, must_change_password)
             VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, 0, $6, 'active', 0)
             RETURNING id`,
            [`qa${ts}${tag}`, 'QA', tag.toUpperCase(), `qa${ts}${tag}@hrms-qa.invalid`, hashes[tag], roles[tag]]
        );
        return { id: r.rows[0].id, employee_id: `qa${ts}${tag}`, password: 'Qa!' + ts + tag, role: roles[tag] };
    };
    for (const tag of Object.keys(roles)) world[tag] = await mk(tag);

    // emp reports to mgr; other does NOT. lead exists to prove team_lead is
    // excluded from the rich editor.
    await pool.query('UPDATE employees SET reporting_manager_id = $1 WHERE id = $2', [world.mgr.id, world.emp.id]);

    console.log('[QA] throwaway world created:', Object.fromEntries(Object.entries(world).map(([k, v]) => [k, v.id])));
    console.log('[QA] today (IST):', today);

    // ---- 2. Logins ----------------------------------------------------------
    const login = async (key) => {
        const portal = world[key].role === 'admin' ? 'admin' : 'employee';
        const r = await api('POST', '/api/auth/login', null, { employee_id: world[key].employee_id, password: world[key].password, portal });
        return r.json && r.json.token;
    };
    const T = {};
    for (const key of Object.keys(world)) T[key] = await login(key);
    for (const key of Object.keys(world)) check('login: ' + key, !!T[key]);

    // ---- 3. Role gate on GET /record ---------------------------------------
    const recEmp = await api('GET', `/api/attendance/record?employee_id=${world.emp.id}&date=${today}`, T.emp);
    check('employee GET /record -> 403 (not a staff editor)', recEmp.status === 403, { status: recEmp.status });

    const recLead = await api('GET', `/api/attendance/record?employee_id=${world.emp.id}&date=${today}`, T.lead);
    check('team_lead GET /record -> 403 (keeps mark-only power)', recLead.status === 403, { status: recLead.status });

    const recAdm = await api('GET', `/api/attendance/record?employee_id=${world.emp.id}&date=${today}`, T.adm);
    check('admin GET /record -> 200', recAdm.status === 200 && !!(recAdm.json && recAdm.json.success), recAdm.json);
    check('admin GET /record returns the employee identity',
        !!(recAdm.json && recAdm.json.employee && recAdm.json.employee.id === world.emp.id), recAdm.json && recAdm.json.employee);
    check('admin GET /record marks today in day context', !!(recAdm.json && recAdm.json.day && recAdm.json.day.today === true), recAdm.json && recAdm.json.day);
    check('admin GET /record: no record yet -> record null', !!(recAdm.json && recAdm.json.record === null), recAdm.json && recAdm.json.record);

    const recFuture = await api('GET', `/api/attendance/record?employee_id=${world.emp.id}&date=${future}`, T.adm);
    check('GET /record future date -> day.future = true', !!(recFuture.json && recFuture.json.day && recFuture.json.day.future === true), recFuture.json && recFuture.json.day);

    // ---- 4. Role gate + scope on POST /edit --------------------------------
    const gateEmp = await api('POST', '/api/attendance/edit', T.emp, { employee_id: world.emp.id, date: today, status: 'present', check_in: '09:30', check_out: '18:00' });
    check('employee POST /edit -> 403', gateEmp.status === 403, { status: gateEmp.status });

    const gateLead = await api('POST', '/api/attendance/edit', T.lead, { employee_id: world.emp.id, date: today, status: 'present', check_in: '09:30', check_out: '18:00' });
    check('team_lead POST /edit -> 403', gateLead.status === 403, { status: gateLead.status });

    const scopeMgrNo = await api('POST', '/api/attendance/edit', T.mgr, { employee_id: world.other.id, date: today, status: 'present', check_in: '09:30', check_out: '18:00' });
    check('manager POST /edit for a non-report -> 403', scopeMgrNo.status === 403, { status: scopeMgrNo.status });

    const scopeMgrYes = await api('POST', '/api/attendance/edit', T.mgr, { employee_id: world.emp.id, date: today, status: 'present', check_in: '09:30', check_out: '18:00' });
    check('manager POST /edit for own report -> 200', scopeMgrYes.status === 200 && !!(scopeMgrYes.json && scopeMgrYes.json.success), scopeMgrYes.json);
    check('manager edit persisted present 09:30 -> 18:00',
        !!(scopeMgrYes.json && scopeMgrYes.json.attendance && scopeMgrYes.json.attendance.status === 'present'
            && String(scopeMgrYes.json.attendance.check_in).startsWith('09:30')
            && String(scopeMgrYes.json.attendance.check_out).startsWith('18:00')),
        scopeMgrYes.json && scopeMgrYes.json.attendance);

    const scopeAdm = await api('POST', '/api/attendance/edit', T.adm, { employee_id: world.other.id, date: today, status: 'late', check_in: '10:15', check_out: '18:30' });
    check('admin POST /edit for ANY employee -> 200', scopeAdm.status === 200 && !!(scopeAdm.json && scopeAdm.json.success), scopeAdm.json);

    // ---- 5. Validation ------------------------------------------------------
    const vFuture = await api('POST', '/api/attendance/edit', T.adm, { employee_id: world.emp.id, date: future, status: 'present', check_in: '09:30' });
    check('validation: future date -> 400', vFuture.status === 400, vFuture.json);

    const vStatus = await api('POST', '/api/attendance/edit', T.adm, { employee_id: world.emp.id, date: today, status: 'holiday' });
    check('validation: disallowed status -> 400', vStatus.status === 400, vStatus.json);

    const vNoIn = await api('POST', '/api/attendance/edit', T.adm, { employee_id: world.emp.id, date: today, status: 'present', check_in: null, check_out: null });
    check('validation: present without check-in -> 400', vNoIn.status === 400, vNoIn.json);

    const vOrder = await api('POST', '/api/attendance/edit', T.adm, { employee_id: world.emp.id, date: today, status: 'present', check_in: '18:00', check_out: '09:30' });
    check('validation: check-out before check-in -> 400', vOrder.status === 400, vOrder.json);

    const vTime = await api('POST', '/api/attendance/edit', T.adm, { employee_id: world.emp.id, date: today, status: 'present', check_in: '25:99' });
    check('validation: malformed time -> 400', vTime.status === 400, vTime.json);

    // ---- 6. Manual check-out clears the auto-checkout marker ---------------
    await pool.query(
        `INSERT INTO attendance (employee_id, date, check_in, check_out, status, auto_checkout, auto_checkout_at, checkout_miss_reason, checkout_miss_reason_at)
         VALUES ($1, $2::date, '09:30', '18:30', 'half-day', TRUE, NOW(), 'forgot to check out', NOW())
         ON CONFLICT (employee_id, date) DO UPDATE SET
            check_in = EXCLUDED.check_in, check_out = EXCLUDED.check_out, status = EXCLUDED.status,
            auto_checkout = TRUE, auto_checkout_at = NOW(), checkout_miss_reason = 'forgot to check out', checkout_miss_reason_at = NOW()`,
        [world.emp.id, today]
    );
    const clearAuto = await api('POST', '/api/attendance/edit', T.adm, { employee_id: world.emp.id, date: today, status: 'present', check_in: '09:30', check_out: '18:00' });
    check('edit with a check-out -> 200', clearAuto.status === 200 && !!(clearAuto.json && clearAuto.json.success), clearAuto.json);
    const caRow = clearAuto.json && clearAuto.json.attendance;
    check('manual check-out cleared auto_checkout flag', !!caRow && caRow.auto_checkout === false, caRow);
    check('manual check-out cleared checkout_miss_reason', !!caRow && (caRow.checkout_miss_reason === null || caRow.checkout_miss_reason === undefined), caRow);

    // ---- 7. absent / wfh clear worked times --------------------------------
    const asAbsent = await api('POST', '/api/attendance/edit', T.adm, { employee_id: world.emp.id, date: today, status: 'absent', remarks: 'unplanned' });
    const abRow = asAbsent.json && asAbsent.json.attendance;
    check('edit -> absent: status absent', !!abRow && abRow.status === 'absent', abRow);
    check('edit -> absent clears check_in + check_out', !!abRow && !abRow.check_in && !abRow.check_out, abRow);
    check('edit -> absent clears break columns', !!abRow && !abRow.break_start && !abRow.break_end && (!abRow.break_log || abRow.break_log === '' || abRow.break_log === '[]'), abRow);

    const asWfh = await api('POST', '/api/attendance/edit', T.adm, { employee_id: world.emp.id, date: today, status: 'wfh', remarks: 'approved wfh' });
    const wfhRow = asWfh.json && asWfh.json.attendance;
    check('edit -> wfh: status wfh', !!wfhRow && wfhRow.status === 'wfh', wfhRow);
    check('edit -> wfh clears worked times', !!wfhRow && !wfhRow.check_in && !wfhRow.check_out, wfhRow);

    const recAfter = await api('GET', `/api/attendance/record?employee_id=${world.emp.id}&date=${today}`, T.adm);
    check('GET /record reflects the latest edit (wfh)',
        !!(recAfter.json && recAfter.json.record && recAfter.json.record.status === 'wfh'), recAfter.json && recAfter.json.record);

    // ---- 8. Audit trail -----------------------------------------------------
    let auditOk = false;
    for (let i = 0; i < 10 && !auditOk; i++) {
        const a = await pool.query(
            `SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'attendance.edit' AND details->>'employee_id' = $1`,
            [String(world.emp.id)]
        );
        auditOk = parseInt(a.rows[0].n, 10) > 0;
        if (!auditOk) await new Promise(r => setTimeout(r, 200));
    }
    check('attendance.edit writes an audit_logs row', auditOk);

    // ---- Summary ------------------------------------------------------------
    console.log('\n[QA] results:');
    results.forEach(r => console.log(r));
    console.log(`\n[QA] ${pass} passed, ${fail} failed`);
    const left = await cleanup();
    if (left > 0) console.log(`[QA] NOTE: ${left} seeded employee(s) left behind (fix cleanup)`);
    await pool.end();
    process.exit(fail ? 1 : 0);
}

main().catch(async e => {
    console.error('[QA] fatal:', e && e.message);
    try { await cleanup(); } catch (_) { /* best-effort */ }
    process.exit(1);
});
