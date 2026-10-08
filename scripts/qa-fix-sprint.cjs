/**
 * qa-fix-sprint.cjs — live QA harness for the Sprint-1 fix batch (My Info
 * audit + full-system audit findings).
 *
 * Covers, against a booted hermetic stack (throwaway PG + app on :3000):
 *   A1  one-time destructive-migration ledger (schema_migrations exists + the
 *       hrms_project_reshape migration is recorded — destructive DDL no longer
 *       re-runs on every cold start)
 *   A3  bare /manager and /employee roots serve the login page (no more 404)
 *   F5  employees.token_version present in the booted DB (layer-B parity)
 *   F7  approver/employee indexes present (leave/wfh approver, tickets
 *       employee, project_employees scans)
 *   F8  dead project_settings table absent from a fresh schema install
 *   D-F7 forgot-password returns the SAME generic 200 for unknown vs known
 *       identifiers (no account enumeration)
 *   F8  reset-password rejects a <8 char password (centralized MIN_PASSWORD_LEN)
 *   F6  attendance photo serve widened admin -> admin-or-hr: HR 404 (not 403)
 *       for an unknown token while manager stays 403
 *   C-F1 documents download guard admin||hr||owner: HR reaches storage-404
 *       (NOT a guard 403), a non-subtree team_lead 403s, the owner also gets
 *       a storage 404 (allowed)
 *   MI-1 raw Postgres DATE normalization on the My Info read routes
 *       (attendance/my, leave/my, holidays, regularization/mine) — the
 *       forwarded value must be plain YYYY-MM-DD, TZ-independent
 *   MI-3 profile-request cancel is TOCTOU-safe (single conditional UPDATE):
 *       first cancel 200, second 400, audit row written
 *   MI-4 project-access approve/reject/cancel race fixed: single conditional
 *       UPDATE arbitrates, exactly ONE grant row is ever created, double
 *       approve 400s, cancel-after-approve 400s, cancel audit written
 *   D-F6 audit rows written for ticket.create
 *
 * Run inside `npm run qa` (commander hermetic stage, server already booted)
 * or standalone against a running hermetic stack:
 *   node scripts/qa-fix-sprint.cjs
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const BASE_URL = process.env.QA_BASE_URL || 'http://localhost:3000';
const ts = Date.now();
const _dbUrl = process.env.DATABASE_URL;
const _remote = !/localhost|127\.0\.0\.1|sslmode=disable/.test(_dbUrl || '');
const pool = new Pool({ connectionString: _dbUrl, ssl: _remote ? { rejectUnauthorized: false } : undefined, max: 2 });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GENERIC_RESET_MESSAGE = 'If this account exists, a reset code has been sent to your registered email.';

// Module-scope so the fatal handler can clean up a partially-seeded world.
let world = {};
let extra = {};

let pass = 0, fail = 0;
const results = [];
function check(name, cond, extra) {
    if (cond) { pass++; results.push(`  ✔ ${name}`); }
    else { fail++; results.push(`  ✖ ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`); }
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
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* non-JSON (HTML pages) */ }
    return { status: res.status, json, text };
}
function todayIST() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}
function nextDayIST() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

async function cleanup(world, extra) {
    try {
        const ids = Object.values(world).map(v => v.id);
        for (const t of ['attendance', 'leave_applications', 'wfh_requests', 'attendance_regularizations',
            'profile_update_requests', 'support_tickets', 'project_access_requests',
            'project_access_grants', 'documents', 'project_employees']) {
            await pool.query(`DELETE FROM ${t} WHERE employee_id = ANY($1::int[])`, [ids]).catch(() => {});
        }
        if (extra.projectId) {
            await pool.query('DELETE FROM projects WHERE id = $1', [extra.projectId]).catch(() => {});
        }
        await pool.query('DELETE FROM holidays WHERE name LIKE $1', ['QA Holiday ' + ts + '%']).catch(() => {});
        await pool.query('DELETE FROM audit_logs WHERE actor_id = ANY($1::int[])', [ids]).catch(() => {});
        await pool.query(`DELETE FROM employees WHERE employee_id LIKE 'qa${ts}%'`);
        const left = await pool.query(`SELECT COUNT(*) AS n FROM employees WHERE employee_id LIKE 'qa${ts}%'`);
        return parseInt(left.rows[0].n, 10);
    } catch (e) {
        console.log('[QA] cleanup note (non-fatal):', e.message);
        return -1;
    }
}

async function countAudit(action, actorId) {
    const r = await pool.query(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = $1 AND actor_id = $2`, [action, actorId]);
    return parseInt(r.rows[0].n, 10);
}
// logAudit is fire-and-forget by design — poll briefly instead of racing it.
async function waitForAudit(action, actorId, min = 1) {
    for (let i = 0; i < 20; i++) {
        const n = await countAudit(action, actorId);
        if (n >= min) return n;
        await new Promise(r => setTimeout(r, 100));
    }
    return countAudit(action, actorId);
}

async function main() {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
    if (!/localhost|127\.0\.0\.1/.test(_dbUrl || '')) {
        throw new Error('refusing to run fix-sprint harness against a remote DB (hermetic write-only suite)');
    }
    const today = todayIST();
    world = {};
    extra = {};

    // ---- 1. Throwaway world -------------------------------------------------
    const roles = ['admin', 'hr', 'manager', 'tl', 'emp'];
    for (const tag of roles) {
        const role = tag === 'tl' ? 'team_lead' : tag === 'emp' ? 'employee' : tag;
        const hash = await bcrypt.hash('Qa!' + ts + tag, 6);
        const r = await pool.query(
            `INSERT INTO employees (employee_id, first_name, last_name, email, password_hash, joining_date, salary, role, status, must_change_password)
             VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,0,$6,'active',0) RETURNING id`,
            [`qa${ts}${tag}`, 'QA', tag.toUpperCase(), `qa${ts}${tag}@hrms-qa.invalid`, hash, role]
        );
        world[tag] = { id: r.rows[0].id, employee_id: `qa${ts}${tag}`, password: 'Qa!' + ts + tag };
    }
    console.log('[QA] throwaway world created:', Object.fromEntries(Object.entries(world).map(([k, v]) => [k, v.id])));
    console.log('[QA] today (IST):', today);

    // ---- 2. Logins ----------------------------------------------------------
    // Admin accounts must use the 'admin' portal, everyone else 'employee' —
    // a mismatch 403s (same rule the RBAC stage follows).
    const login = async (key) => {
        const portal = key === 'admin' ? 'admin' : 'employee';
        const r = await api('POST', '/api/auth/login', null, { employee_id: world[key].employee_id, password: world[key].password, portal });
        if (!r.json || !r.json.token) console.log(`[QA] login ${key} failed:`, r.status, JSON.stringify(r.json));
        return r.json && r.json.token;
    };
    const T = {};
    for (const tag of roles) {
        T[tag] = await login(tag);
        check(`login: ${tag}`, !!T[tag]);
    }

    // ---- 3. A3: bare /manager + /employee roots (no 404) --------------------
    for (const root of ['/manager', '/employee', '/admin']) {
        const r = await api('GET', root);
        check(`A3: bare ${root} -> 200 login HTML`, r.status === 200 && /<html/i.test(r.text), { status: r.status });
    }
    for (const page of ['/manager/my-team', '/employee/dashboard', '/admin/dashboard']) {
        const r = await api('GET', page);
        check(`A3: portal page ${page} -> 200 HTML`, r.status === 200 && /<html/i.test(r.text), { status: r.status });
    }

    // ---- 4. Schema-layer asserts (A1 / F5 / F7 / F8) ------------------------
    const mig = await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='schema_migrations'`);
    check('A1: schema_migrations ledger table exists', mig.rows.length === 1);
    if (mig.rows.length === 1) {
        const applied = await pool.query(`SELECT name FROM schema_migrations`);
        check('A1: hrms_project_reshape recorded exactly once',
            applied.rows.filter(r => r.name === 'hrms_project_reshape').length === 1, applied.rows);
    }
    const tv = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name='employees' AND column_name='token_version'`);
    check('F5: employees.token_version column exists', tv.rows.length === 1);
    const idxNames = ['idx_leave_applications_approver', 'idx_wfh_requests_approver', 'idx_support_tickets_employee',
        'idx_project_employees_project', 'idx_project_employees_employee'];
    for (const ix of idxNames) {
        const r = await pool.query('SELECT 1 FROM pg_indexes WHERE indexname = $1', [ix]);
        check(`F7: index ${ix} exists`, r.rows.length === 1);
    }
    const ps = await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='project_settings'`);
    check('F8: dead project_settings table absent (fresh install)', ps.rows.length === 0);

    // ---- 5. D-F7: forgot-password uniform 200 -------------------------------
    const fpUnknown = await api('POST', '/api/auth/forgot-password', null, { employee_id: 'qa-nobody-' + ts });
    check('D-F7: unknown identifier -> 200', fpUnknown.status === 200, fpUnknown.json);
    check('D-F7: unknown identifier -> generic message only', fpUnknown.json && fpUnknown.json.message === GENERIC_RESET_MESSAGE, fpUnknown.json);
    const fpKnown = await api('POST', '/api/auth/forgot-password', null, { employee_id: world.admin.employee_id });
    check('D-F7: known identifier -> 200', fpKnown.status === 200, fpKnown.json);
    check('D-F7: known identifier -> SAME generic message (no enumeration)', fpKnown.json && fpKnown.json.message === GENERIC_RESET_MESSAGE, fpKnown.json);
    const fpEmpty = await api('POST', '/api/auth/forgot-password', null, {});
    check('D-F7: empty identifier -> 400', fpEmpty.status === 400, fpEmpty.json);

    // ---- 6. F8: min password length centralized (MIN_PASSWORD_LEN) ---------
    // The auth self-service routes validate MIN_PASSWORD_LEN before any write.
    // NB: employees/:id/reset-password is NOT a good probe — it generates its
    // OWN temp password (never accepts the body value) and bumps token_version,
    // which would revoke the QA employee's token mid-matrix.
    const cp = await api('PUT', '/api/auth/change-password', T.emp, { current_password: 'irrelevant', new_password: 'short' });
    check('F8: change-password with <8 char new password -> 400', cp.status === 400, cp.json);

    // ---- 7. F6: attendance photo serve widened to isAdminOrHr ---------------
    const phAdmin = await api('GET', '/api/attendance/photo/notexist', T.admin);
    const phHr = await api('GET', '/api/attendance/photo/notexist', T.hr);
    const phMgr = await api('GET', '/api/attendance/photo/notexist', T.manager);
    check('F6: admin unknown photo token -> 404', phAdmin.status === 404, phAdmin.json);
    check('F6: HR unknown photo token -> 404 (guard widened, was 403)', phHr.status === 404, phHr.json);
    check('F6: manager unknown photo token -> 403 (unchanged)', phMgr.status === 403, phMgr.json);

    // ---- 8. C-F1: documents download guard admin||hr||owner -----------------
    // Seed the doc with file_name = NULL so the handler 404s (before storage)
    // for allowed roles — the storage client has no bucket on hermetic and would
    // 500 instead, which is an env artifact, not the guard under test.
    const doc = await pool.query(
        `INSERT INTO documents (employee_id, title, file_url, file_name, document_type, uploaded_by)
         VALUES ($1, $2, $3, NULL, $4, $5) RETURNING id`,
        [world.emp.id, 'QA sprint doc', 'qa://missing', 'other', world.emp.id]
    );
    const docId = doc.rows[0].id;
    const dlHr = await api('GET', `/api/documents/${docId}/download`, T.hr);
    const dlTl = await api('GET', `/api/documents/${docId}/download`, T.tl);
    const dlOwner = await api('GET', `/api/documents/${docId}/download`, T.emp);
    check('C-F1: HR download passes the guard -> 404, NOT a guard 403', dlHr.status === 404, { status: dlHr.status, json: dlHr.json });
    check('C-F1: non-subtree team_lead download -> 403', dlTl.status === 403, { status: dlTl.status, json: dlTl.json });
    check('C-F1: owner download passes the guard -> 404, NOT a guard 403', dlOwner.status === 404, { status: dlOwner.status, json: dlOwner.json });

    // ---- 9. MI-1: raw DATE normalization on My Info read routes -------------
    await pool.query(
        `INSERT INTO attendance (employee_id, date, check_in, check_out, status, remarks)
         VALUES ($1, $2, '09:00', '18:00', 'present', 'qa')`,
        [world.emp.id, today]
    );
    const lt = await pool.query(`SELECT id FROM leave_types WHERE is_active = 1 LIMIT 1`);
    await pool.query(
        `INSERT INTO leave_applications (employee_id, leave_type_id, start_date, end_date, total_days, reason, status)
         VALUES ($1, $2, $3, $3, 1, 'qa', 'pending')`,
        [world.emp.id, lt.rows[0].id, nextDayIST()]
    );
    await pool.query(
        `INSERT INTO holidays (name, date, description, is_active) VALUES ($1, $2, 'qa', 1)`,
        ['QA Holiday ' + ts, '2030-01-15']
    );
    await pool.query(
        `INSERT INTO attendance_regularizations (employee_id, date, check_in, check_out, reason, status)
         VALUES ($1, $2, '09:30', '17:30', 'qa', 'pending')`,
        [world.emp.id, today]
    );
    const attMy = await api('GET', '/api/attendance/my', T.emp);
    const attDates = (attMy.json && attMy.json.attendance) || (attMy.json && attMy.json.rows) || (attMy.json ? Object.values(attMy.json)[0] : null);
    check('MI-1: /attendance/my -> 200', attMy.status === 200, attMy.json);
    check('MI-1: attendance/my date is plain YYYY-MM-DD',
        Array.isArray(attDates) ? attDates.some(r => r && r.date === today || (r && DATE_RE.test(String(r.date)))) : (attDates && DATE_RE.test(String(attDates.date))),
        attDates);
    const leaveMy = await api('GET', '/api/leave/my', T.emp);
    const leaveRows = leaveMy.json && leaveMy.json.leaves;
    check('MI-1: /leave/my -> 200', leaveMy.status === 200, leaveMy.json);
    check('MI-1: leave/my dates plain (start+end)',
        Array.isArray(leaveRows) && leaveRows.length >= 1 && DATE_RE.test(String(leaveRows[0].start_date)) && DATE_RE.test(String(leaveRows[0].end_date)),
        leaveRows && leaveRows[0]);
    const hol = await api('GET', '/api/holidays', T.admin);
    const holRows = (hol.json && hol.json.holidays) || (hol.json && hol.json.rows);
    const holMine = Array.isArray(holRows) ? holRows.find(h => h && h.name === 'QA Holiday ' + ts) : null;
    check('MI-1: /holidays -> 200 + seeded row found', hol.status === 200 && !!holMine, hol.json);
    check('MI-1: holiday date plain YYYY-MM-DD', holMine && DATE_RE.test(String(holMine.date)), holMine);
    const regMine = await api('GET', '/api/regularization/mine', T.emp);
    const regRows = regMine.json && (regMine.json.requests || regMine.json.rows);
    check('MI-1: /regularization/mine -> 200', regMine.status === 200, regMine.json);
    check('MI-1: regularization/mine date plain',
        Array.isArray(regRows) && regRows.some(r => DATE_RE.test(String(r.date))), regRows);

    // ---- 10. MI-3: profile-request cancel TOCTOU-safe + audited -------------
    const pr = await api('POST', '/api/auth/profile-request', T.emp, { changes: { address: 'QA Address ' + ts } });
    check('MI-3: profile-request create -> 201', pr.status === 201 && pr.json && pr.json.requests && pr.json.requests.length === 1, pr.json);
    const prId = pr.json && pr.json.requests && pr.json.requests[0] && pr.json.requests[0].id;
    const c1 = await api('POST', `/api/auth/profile-request/${prId}/cancel`, T.emp, {});
    check('MI-3: first cancel -> 200', c1.status === 200, c1.json);
    const c2 = await api('POST', `/api/auth/profile-request/${prId}/cancel`, T.emp, {});
    check('MI-3: second cancel -> 400 (TOCTOU-safe, request already cancelled)', c2.status === 400, c2.json);
    const prAuditN = await waitForAudit('profile_request.cancel', world.emp.id);
    check('D-F6/MI-3: profile_request.cancel audit row written', prAuditN === 1);

    // ---- 11. MI-4: project-access race -> single grant, audited cancel ------
    const proj = await pool.query(`INSERT INTO projects (name, status) VALUES ($1, 'active') RETURNING id`, ['QA Proj ' + ts]);
    const projId = proj.rows[0].id;
    const rq1 = await api('POST', '/api/project-access/requests', T.emp, { project_id: projId });
    check('MI-4: access request #1 -> 201', rq1.status === 201 && rq1.json && rq1.json.requestId, rq1.json);
    const rid1 = rq1.json && rq1.json.requestId;
    const ap1 = await api('POST', `/api/project-access/requests/${rid1}/approve`, T.admin, {});
    check('MI-4: approve #1 -> 200 + grantId', ap1.status === 200 && ap1.json && ap1.json.grantId, ap1.json);
    const ap2 = await api('POST', `/api/project-access/requests/${rid1}/approve`, T.admin, {});
    check('MI-4: double approve -> 400 (already approved)', ap2.status === 400, ap2.json);
    const ca1 = await api('POST', `/api/project-access/requests/${rid1}/cancel`, T.emp, {});
    check('MI-4: cancel after approve -> 400', ca1.status === 400, ca1.json);
    const grants = await pool.query('SELECT COUNT(*) AS n FROM project_access_grants WHERE project_id = $1 AND employee_id = $2', [projId, world.emp.id]);
    check('MI-4: exactly ONE grant row after double-approve attempt', parseInt(grants.rows[0].n, 10) === 1, grants.rows[0]);
    const apAuditN = await waitForAudit('project-access.approve', world.admin.id);
    check('D-F6/MI-4: project-access.approve audit written ONCE', apAuditN === 1);
    const rq2 = await api('POST', '/api/project-access/requests', T.emp, { project_id: projId });
    check('MI-4: access request #2 -> 201', rq2.status === 201 && rq2.json && rq2.json.requestId, rq2.json);
    const rid2 = rq2.json && rq2.json.requestId;
    const ca2 = await api('POST', `/api/project-access/requests/${rid2}/cancel`, T.emp, {});
    check('MI-4: requester cancel of pending -> 200', ca2.status === 200, ca2.json);
    const ap3 = await api('POST', `/api/project-access/requests/${rid2}/approve`, T.admin, {});
    check('MI-4: approve after cancel -> 400', ap3.status === 400, ap3.json);
    const caAuditN = await waitForAudit('project-access.cancel', world.emp.id);
    check('D-F6/MI-4: project-access.cancel audit written (was unaudited)', caAuditN === 1);

    // ---- 12. D-F6: ticket.create audit --------------------------------------
    const tk = await api('POST', '/api/tickets', T.emp, { category: 'other', subject: 'QA Ticket ' + ts });
    check('ticket create -> 201', tk.status === 201 && tk.json && tk.json.ticket, tk.json);
    const tkAuditN = await waitForAudit('ticket.create', world.emp.id);
    check('D-F6: ticket.create audit row written', tkAuditN >= 1);

    // ---- 12b. security F12: audit-log UI shows ALL rows incl. admin actors --
    // The approve above wrote an admin-actor row (action project-access.approve,
    // actor_id = world.admin.id). GET /api/audit-logs must return it — the old
    // "e.role IS DISTINCT FROM 'admin'" visibility clause would have hidden it.
    const al = await api('GET', '/api/audit-logs?limit=100', T.admin);
    const adminRowVisible = Array.isArray(al.json && al.json.logs) &&
        al.json.logs.some(l => l.action === 'project-access.approve' && l.actor_id === world.admin.id);
    check('security F12: admin-actor audit row visible in GET /api/audit-logs', al.status === 200 && adminRowVisible, { status: al.status, total: al.json && al.json.total, found: adminRowVisible });

    // ---- 13. Cleanup + report ----------------------------------------------
    extra = { projectId: projId };
    const leftovers = await cleanup(world, extra);
    check('cleanup: zero QA leftovers', leftovers === 0, { leftovers });

    console.log('\n[QA] fix-sprint results:');
    results.forEach(r => console.log(r));
    console.log(`\n${pass} passed, ${fail} failed.`);
    await pool.end();
    process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
    console.error('[QA] fix-sprint harness fatal:', e && e.stack ? e.stack : e);
    try {
        if (Object.keys(world).length) await cleanup(world, extra);
    } catch (_) {}
    try { await pool.end(); } catch (_) {}
    process.exit(1);
});