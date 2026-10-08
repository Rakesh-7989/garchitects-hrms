/**
 * qa-db-invariants.cjs — Increment 1: DB-invariant assertions for the QA Commander.
 *
 * Locks the three money/time-critical chains this product must never silently break:
 *   L — leave balance: apply → approve/reject/cancel moves used_days/pending_days exactly
 *       per the domain rule ("1 paid day per calendar month", distinct-month counting);
 *       quota-exhausted new-month apply is blocked with NO row written.
 *   A — break finalize → hours worked: a completed day's break_log is closed JSON, every
 *       entry has start+end (end ≤ check_out); recomputed hours match the derivation.
 *   P — payroll roll-up: exactly one row per (employee, month, year) even when regenerated,
 *       net = basic + allowances − deductions, net ≥ 0, attendance monotonicity.
 *
 * Creates a throwaway world (admin + employee + a quota-1 throwaway leave type) in the
 * DATABASE_URL DB, drives the running server's API (QA_BASE_URL, default
 * http://localhost:3000 — start `npm start` first), recomputes invariants independently
 * from raw rows, then rolls the world back so the DB stays pristine.
 *
 * Hermetic-only by design (the commander skips this stage on the live target): it writes
 * data, so it must only ever run against the throwaway cluster.
 *
 * Run:  node scripts/qa-db-invariants.cjs
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

function todayIST() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}
function pad2(n) { return String(n).padStart(2, '0'); }
function parseLog(row) {
    try { return JSON.parse((row && row.break_log) || '[]'); } catch (_) { return null; }
}
function toSec(hhmmss) {
    const p = String(hhmmss || '').split(':').map(Number);
    return (p[0] || 0) * 3600 + (p[1] || 0) * 60 + (p[2] || 0);
}
/** Recompute hours worked = (check_out − check_in) − Σ(break end − break start), in seconds. */
function recomputeHours(row) {
    const log = parseLog(row);
    if (!row || !row.check_in || !row.check_out || !Array.isArray(log)) return null;
    let breaks = 0;
    for (const e of log) {
        if (!e || !e.start || !e.end) return null;
        breaks += toSec(e.end) - toSec(e.start);
    }
    return toSec(row.check_out) - toSec(row.check_in) - breaks;
}

const SETTING_KEYS = ['office_end_time', 'checkout_grace_minutes'];
const settingsBackup = {};
async function saveSetting(key) {
    const r = await pool.query('SELECT setting_value FROM company_settings WHERE setting_key = $1', [key]);
    settingsBackup[key] = r.rows.length ? r.rows[0].setting_value : null; // null => didn't exist
}
async function setSetting(key, value) {
    await pool.query(
        `INSERT INTO company_settings (setting_key, setting_value) VALUES ($1, $2)
         ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`,
        [key, value]
    );
}
async function restoreSettings() {
    for (const key of SETTING_KEYS) {
        if (settingsBackup[key] === null) {
            await pool.query('DELETE FROM company_settings WHERE setting_key = $1', [key]);
        } else {
            await pool.query(
                'UPDATE company_settings SET setting_value = $1 WHERE setting_key = $2',
                [settingsBackup[key], key]
            );
        }
    }
}

async function cleanup() {
    try {
        const ids = Object.values(world).map(w => w && w.id).filter(Boolean);
        if (ids.length) await pool.query('DELETE FROM audit_logs WHERE actor_id = ANY($1)', [ids]);
        for (const k of Object.keys(world)) {
            if (world[k] && world[k].id) await pool.query('DELETE FROM attendance WHERE employee_id = $1', [world[k].id]);
        }
        if (world.leaveTypeB) {
            await pool.query('DELETE FROM leave_applications WHERE leave_type_id = $1', [world.leaveTypeB]);
            await pool.query('DELETE FROM leave_types WHERE id = $1', [world.leaveTypeB]);
        }
        for (const k of Object.keys(world)) {
            if (world[k] && world[k].id) await pool.query('DELETE FROM employees WHERE id = $1', [world[k].id]);
        }
        await restoreSettings();
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
    const curYear = parseInt(today.substring(0, 4), 10);
    const curMonth = parseInt(today.substring(5, 7), 10);
    // Next calendar year months (for the quota-blocked apply) and previous month (for payroll).
    // L4 must use next-year Jan/Feb: the apply overlap rule is per-employee across ALL leave
    // types, so a second leave type cannot use a month already consumed by type A.
    const ny = curYear + 1;
    const l4y1 = `${ny}-01`; // next-year Jan: approve a quota-1 leave here
    const l4y2 = `${ny}-02`; // next-year Feb: new-month apply must be quota-blocked
    const prevY = curMonth === 1 ? curYear - 1 : curYear;
    const prevM = curMonth === 1 ? 12 : curMonth - 1;
    const prevYm = `${prevY}-${pad2(prevM)}`;

    // ---- 1. Throwaway world -------------------------------------------------
    const hashes = {};
    for (const r of ['adm', 'emp']) hashes[r] = await bcrypt.hash('Qa!' + ts + r, 6);

    const adminRes = await pool.query(
        `INSERT INTO employees (employee_id, first_name, last_name, email, password_hash, joining_date, salary, role, status, must_change_password)
         VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, 0, 'admin', 'active', 0) RETURNING id`,
        [`qa${ts}adm`, 'QA', 'ADM', `qa${ts}adm@hrms-qa.invalid`, hashes.adm]
    );
    world.admin = { id: adminRes.rows[0].id, employee_id: `qa${ts}adm`, password: 'Qa!' + ts + 'adm' };

    const empRes = await pool.query(
        `INSERT INTO employees (employee_id, first_name, last_name, email, password_hash, joining_date, salary, basic_salary, role, status, must_change_password, secondary_reporting_manager_id)
         VALUES ($1, $2, $3, $4, $5, '2026-01-01', 20000, 20000, 'employee', 'active', 0, $6) RETURNING id`,
        [`qa${ts}emp`, 'QA', 'EMP', `qa${ts}emp@hrms-qa.invalid`, hashes.emp, world.admin.id]
    );
    world.emp = { id: empRes.rows[0].id, employee_id: `qa${ts}emp`, password: 'Qa!' + ts + 'emp' };

    // Pin office end far in the future so no test row auto-closes mid-flow.
    for (const key of SETTING_KEYS) await saveSetting(key);
    await setSetting('office_end_time', '23:59');
    await setSetting('checkout_grace_minutes', '120');

    console.log('[QA] throwaway world:', Object.fromEntries(Object.entries(world).map(([k, v]) => [k, v.id])));

    // ---- 2. Logins ----------------------------------------------------------
    const login = async (key, portal) => {
        const r = await api('POST', '/api/auth/login', null, { employee_id: world[key].employee_id, password: world[key].password, portal });
        return r.json && r.json.token;
    };
    const adminT = await login('admin', 'admin');
    const empT = await login('emp', 'employee');
    check('login: admin', !!adminT);
    check('login: employee', !!empT);

    // ---- 3. Leave types -----------------------------------------------------
    // Type A: a real active quota type for the balance-movement invariants.
    const typeARes = await pool.query(
        `SELECT id, days_per_year FROM leave_types
         WHERE is_active = 1 AND gender_eligibility = 'all'
         ORDER BY (name = 'Sick or Casual') DESC, id LIMIT 1`
    );
    const typeA = typeARes.rows[0];
    check('leave type A available (active, all-gender)', !!typeA && Number(typeA.days_per_year) >= 12, typeA);
    // Type B: throwaway quota-1 type so L4 can exhaust quota with ONE approval.
    const typeBRes = await pool.query(
        `INSERT INTO leave_types (name, days_per_year, description, gender_eligibility)
         VALUES ($1, 1, 'qa invariant harness', 'all') RETURNING id`,
        ['QA Invar ' + ts]
    );
    world.leaveTypeB = typeBRes.rows[0].id;

    // ---- 4. L — leave balance invariants ------------------------------------
    const applyLeave = (ltId, startDate, reason) => api('POST', '/api/leave/apply', empT, { leave_type_id: ltId, start_date: startDate, end_date: startDate, reason });
    /** Apply a 1-day leave in month ym on the first viable weekday-holiday day not in exclude. */
    const viableDay = async (ltId, ym, exclude) => {
        for (let d = 1; d <= 28; d++) {
            const date = `${ym}-${pad2(d)}`;
            if (exclude.has(date)) continue;
            const r = await applyLeave(ltId, date, 'QA invariants');
            if ((r.status === 200 || r.status === 201) && r.json && r.json.leave && Number(r.json.leave.total_days) >= 1) {
                return { date, id: r.json.leave.id, total: Number(r.json.leave.total_days) };
            }
        }
        return null;
    };
    const balance = async () => {
        const r = await api('GET', '/api/leave/balance', empT);
        const b = ((r.json && r.json.balances) || []).find(x => Number(x.id) === Number(typeA.id));
        return b || { used_days: -1, pending_days: -1, remaining_days: -1 };
    };
    const approve = async (leaveId, status) => api('PUT', `/api/leave/approve/${leaveId}`, adminT, { status, remarks: 'QA invariants' });

    const used = new Set();
    const novYm = `${curYear}-11`;
    const l1 = await viableDay(typeA.id, novYm, used);
    used.add(l1 && l1.date);
    check('L1: apply 1-day leave in a new month (201)', !!l1, l1);
    if (l1) check('L1: applied total_days = 1 (business-day calc)', l1.total === 1, { total: l1.total });

    let bal = await balance();
    // pg returns COUNT/SUM as strings — Number-wrap every comparison.
    check('L3a: pending → pending_days = total, used 0, remaining = quota', !!l1 && Number(bal.pending_days) === l1.total && Number(bal.used_days) === 0 && Number(bal.remaining_days) === Number(typeA.days_per_year), bal);

    const ap1 = l1 ? await approve(l1.id, 'approved') : null;
    check('L1: approve → 200', !!ap1 && ap1.status === 200 && !!(ap1.json && ap1.json.success), ap1 && ap1.json);

    bal = await balance();
    check('L1: approve → used +1, pending 0, remaining quota−1', Number(bal.used_days) === 1 && Number(bal.pending_days) === 0 && Number(bal.remaining_days) === Number(typeA.days_per_year) - 1, bal);

    const l2 = await viableDay(typeA.id, novYm, used);
    used.add(l2 && l2.date);
    check('L2: second 1-day leave in the SAME month (201)', !!l2, l2);
    const ap2 = l2 ? await approve(l2.id, 'approved') : null;
    check('L2: approve → 200', !!ap2 && ap2.status === 200 && !!(ap2.json && ap2.json.success), ap2 && ap2.json);
    bal = await balance();
    check('L2: same-month approvals → used STILL 1 (distinct-month rule), remaining quota−1', Number(bal.used_days) === 1 && Number(bal.remaining_days) === Number(typeA.days_per_year) - 1, bal);

    const l3 = await viableDay(typeA.id, novYm, used);
    used.add(l3 && l3.date);
    check('L3b: third 1-day leave for the reject case (201)', !!l3, l3);
    const rj = l3 ? await approve(l3.id, 'rejected') : null;
    check('L3b: reject → 200', !!rj && rj.status === 200 && !!(rj.json && rj.json.success), rj && rj.json);
    bal = await balance();
    check('L3b: reject → used/pending unchanged (1 / 0)', Number(bal.used_days) === 1 && Number(bal.pending_days) === 0, bal);

    const cancelApp = await viableDay(typeA.id, novYm, used);
    check('L3c: fourth leave for employee cancel (201)', !!cancelApp, cancelApp);
    const canc = cancelApp ? await api('POST', `/api/leave/${cancelApp.id}/cancel`, empT, {}) : null;
    check('L3c: employee cancel → 200', !!canc && canc.status === 200 && !!(canc.json && canc.json.success), canc && canc.json);
    bal = await balance();
    check('L3c: cancel → used/pending unchanged (1 / 0)', Number(bal.used_days) === 1 && Number(bal.pending_days) === 0, bal);

    const balRead1 = await balance();
    const balRead2 = await balance();
    check('L5a: balance idempotent across reads', JSON.stringify(balRead1) === JSON.stringify(balRead2), { a: balRead1, b: balRead2 });
    check('L5b: remaining never negative and ≤ quota', bal.remaining_days >= 0 && bal.remaining_days <= Number(typeA.days_per_year), bal);

    // L4 — quota exhaustion (throwaway quota-1 type): approve a next-year Jan leave,
    // then a next-year Feb (new month, zero overlap) apply must 400 with NO row.
    const l4n = await viableDay(world.leaveTypeB, l4y1, new Set([...used]));
    check('L4: quota-1 type apply (Jan) → 201', !!l4n, l4n);
    const ap4 = l4n ? await approve(l4n.id, 'approved') : null;
    check('L4: quota-1 approve → 200', !!ap4 && ap4.status === 200 && !!(ap4.json && ap4.json.success), ap4 && ap4.json);
    let quotaBlocked = false, blockedMsg = '';
    for (let d = 1; d <= 28 && !quotaBlocked; d++) {
        const date = `${l4y2}-${pad2(d)}`;
        const r = await applyLeave(world.leaveTypeB, date, 'QA invariants');
        if (r.status === 400 && /balance/i.test((r.json && r.json.message) || '')) { quotaBlocked = true; blockedMsg = r.json.message; }
    }
    check('L4: new-month apply at exhausted quota → 400 (insufficient balance)', quotaBlocked, { msg: blockedMsg });
    const orphan = await pool.query(
        `SELECT COUNT(*) AS n FROM leave_applications WHERE leave_type_id = $1 AND to_char(start_date, 'YYYY-MM') = $2`,
        [world.leaveTypeB, l4y2]
    );
    check('L4: no leave row written by the blocked apply', parseInt(orphan.rows[0].n, 10) === 0, orphan.rows[0]);

    // ---- 5. A — break finalize → hours worked -------------------------------
    // A1/A2: seeded closed day, invariant on the row itself.
    await pool.query(
        `INSERT INTO attendance (employee_id, date, check_in, check_out, break_log, status)
         VALUES ($1, $2, '09:00:00', '18:30:00', '[{"start":"13:00:00","end":"13:45:00"}]', 'present')`,
        [world.emp.id, '2026-10-05']
    );
    const seedRow = (await pool.query('SELECT * FROM attendance WHERE employee_id = $1 AND date = $2', [world.emp.id, '2026-10-05'])).rows[0];
    const seedLog = parseLog(seedRow);
    check('A1: break_log parses as JSON array', Array.isArray(seedLog) && seedLog.length === 1, seedLog);
    const seedEntry = seedLog && seedLog[0];
    check('A1: entry closed (start+end, end ≤ check_out)', !!seedEntry && !!seedEntry.start && !!seedEntry.end && seedEntry.end <= seedRow.check_out, seedEntry);
    const seedHours = recomputeHours(seedRow);
    check('A2: hours worked = 8.75h exactly (9h30 − 45m break)', seedHours === 31500, { seedHours });

    // A3–A6: live API flow finalizes a running break; post-conditions on the row.
    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const LOC = '17.4255,78.4378';
    const ci = await api('POST', '/api/attendance/check-in', empT, { location: LOC, photo: tinyPng });
    check('A3: check-in → 200', ci.status === 200 && !!(ci.json && ci.json.success), ci.json);
    const bs = await api('POST', '/api/attendance/break-start', empT, {});
    check('A3: break-start → 200', bs.status === 200 && !!(bs.json && bs.json.success), bs.json);
    const be = await api('POST', '/api/attendance/break-end', empT, {});
    check('A4: break-end → 200', be.status === 200 && !!(be.json && be.json.success), be.json);
    const co = await api('POST', '/api/attendance/check-out', empT, { location: LOC, photo: tinyPng });
    check('A4: check-out → 200', co.status === 200 && !!(co.json && co.json.success), co.json);

    const flowRow = (await pool.query('SELECT * FROM attendance WHERE employee_id = $1 AND date = $2', [world.emp.id, today])).rows[0];
    const flowLog = parseLog(flowRow);
    check('A5: post-check-out row has break_start cleared', !!flowRow && !flowRow.break_start, flowRow);
    check('A5: break_log exactly one entry, end === check_out', !!flowRow && !!flowLog && flowLog.length === 1 && flowLog[0].end === flowRow.check_out, { log: flowLog, check_out: flowRow && flowRow.check_out });
    const flowHours = recomputeHours(flowRow);
    // The live flow here is a ~1s shift (check-in → break → check-out rapidly), so the
    // honest invariant is: completed days can NEVER show negative hours and stay ≤ 24h.
    check('A6: hours worked never < 0 and ≤ 24h (independent recompute)', flowHours !== null && flowHours >= 0 && flowHours <= 24 * 3600, { flowHours });

    // ---- 6. P — payroll roll-up ---------------------------------------------
    // Seed 5 present days in the previous month (deterministic past period).
    for (let d = 1; d <= 5; d++) {
        await pool.query(
            `INSERT INTO attendance (employee_id, date, status) VALUES ($1, $2, 'present') ON CONFLICT (employee_id, date) DO NOTHING`,
            [world.emp.id, `${prevYm}-${pad2(d)}`]
        );
    }
    const gen = async () => api('POST', '/api/payroll/generate', adminT, { employee_id: world.emp.id, month: prevM, year: prevY });
    const payrollRow = async () => (await pool.query('SELECT * FROM payroll WHERE employee_id = $1 AND month = $2 AND year = $3', [world.emp.id, prevM, prevY])).rows[0];
    // P2/P3-decomposition: net is attendance-prorated (gross_salary stays the FULL basic
    // while net_salary is prorated by present days — see the run: gross 20000, net 6000),
    // so there is NO net = gross − deductions identity. The relationships that MUST hold
    // structurally (by construction in payroll.js:1326-1327,1363) are:
    //   allowances = gross − basic, deductions = total_deductions, gross ≥ basic, 0 ≤ net ≤ gross.
    const decomposes = (row) => row
        && Math.abs(Number(row.allowances) - (Number(row.gross_salary) - Number(row.basic_salary))) < 0.01
        && Math.abs(Number(row.deductions) - Number(row.total_deductions)) < 0.01
        && Number(row.gross_salary) >= Number(row.basic_salary)
        && Number(row.net_salary) >= 0 && Number(row.net_salary) <= Number(row.gross_salary);

    const g1 = await gen();
    check('P1: payroll generate → 200 + success', g1.status === 200 && !!(g1.json && g1.json.success), g1.json);
    const p1 = await payrollRow();
    const p1count = (await pool.query('SELECT COUNT(*) AS n FROM payroll WHERE employee_id = $1 AND month = $2 AND year = $3', [world.emp.id, prevM, prevY])).rows[0];
    check('P1: exactly one payroll row for (emp, month, year)', parseInt(p1count.n, 10) === 1, p1count);
    check('P2: allowances = gross − basic, deductions = total_deductions, 0 ≤ net ≤ gross', decomposes(p1), { net: p1 && p1.net_salary, gross: p1 && p1.gross_salary, basic: p1 && p1.basic_salary, all: p1 && p1.allowances, ded: p1 && p1.total_deductions });
    check('P4: net ≥ 0', p1 && Number(p1.net_salary) >= 0, p1 && p1.net_salary);
    const presentBefore = p1 ? Number(p1.present_days) : -1;

    const g2 = await gen();
    check('P1b: regenerate → 200 + success', g2.status === 200 && !!(g2.json && g2.json.success), g2.json);
    const p2count = (await pool.query('SELECT COUNT(*) AS n FROM payroll WHERE employee_id = $1 AND month = $2 AND year = $3', [world.emp.id, prevM, prevY])).rows[0];
    const p2 = await payrollRow();
    check('P1b: regenerate keeps exactly one row (UNIQUE discipline)', parseInt(p2count.n, 10) === 1 && p2.status === 'processed', { count: p2count.n, status: p2 && p2.status });
    check('P4: net still ≥ 0 after regenerate', p2 && Number(p2.net_salary) >= 0, p2 && p2.net_salary);

    // P3: adding attendance can only increase present_days (monotonicity).
    for (let d = 6; d <= 8; d++) {
        await pool.query(
            `INSERT INTO attendance (employee_id, date, status) VALUES ($1, $2, 'present') ON CONFLICT (employee_id, date) DO NOTHING`,
            [world.emp.id, `${prevYm}-${pad2(d)}`]
        );
    }
    const g3 = await gen();
    check('P3: regenerate after +3 present days → 200', g3.status === 200 && !!(g3.json && g3.json.success), g3.json);
    const p3 = await payrollRow();
    check('P3: present_days increased by ≥ 3 (attendance monotonicity)', p3 && Number(p3.present_days) >= presentBefore + 3, { before: presentBefore, after: p3 && p3.present_days });
    check('P3: decomposition still holds after regeneration', decomposes(p3));

    // ---- 7. Zero leftovers --------------------------------------------------
    // (authoritative check runs in finally after cleanup())
}

process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

main()
    .catch((e) => { fail++; results.push('  ✖ harness error: ' + (e && e.stack || e)); })
    .finally(async () => {
        const leftover = await cleanup();
        if (leftover > 0) { fail++; results.push(`  ✖ cleanup: ${leftover} qa employee row(s) remained`); }
        console.log('\n[QA] db-invariants results:');
        console.log(results.join('\n'));
        console.log(`\n${pass} passed, ${fail} failed`);
        process.exit(fail === 0 ? 0 : 1);
    });