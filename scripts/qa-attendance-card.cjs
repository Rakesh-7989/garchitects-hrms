/**
 * qa-attendance-card.cjs — hermetic QA harness for the employee dashboard
 * check-in/check-out CARD contract + its server guards.
 *
 * Story: the user reported "something wrong in the check-in/check-out card".
 * Deep-dive found concrete defects:
 *   1. A manager's mark-absent for TODAY (mark-absent has no date guard)
 *      creates a row with check_in NULL. The card rendered it as an
 *      in-progress day (Check-Out + Start Break + a blank "Checked in at"),
 *      and the server happily closed it: check-out / break-start / break-end
 *      all matched the no-check_in row and wrote to it (impossible
 *      check_out-without-check_in days). Fix: the card's in-progress branch
 *      now requires check_in (absent/on-leave rows show Check-In instead), and
 *      the three write routes require `AND check_in IS NOT NULL`.
 *   2. A day with NO row renders a bare "Not checked in yet" + Check-In
 *      invitation even on a declared holiday / weekly off / approved-leave
 *      day. Fix: GET /attendance/my now returns a `today` context
 *      { date, holiday, weekoff, onLeave } so the card can say what kind of
 *      day it is (still actionable - the API deliberately allows a check-in
 *      on a holiday/leave day).
 *   3. A legacy impossible row (check_out set, check_in NULL) could be
 *      re-opened by a check-in. Fix: check-in answers 400 'Already checked
 *      out today'.
 *
 * Run: start the server against the hermetic local Postgres, then
 *   node scripts/qa-attendance-card.cjs
 * (the login route rate-limits to 10 attempts/15min per IP; this harness does
 * 4 logins - restart the server before a rerun to reset the limiter).
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
function dd(dateStr) { return (dateStr || '').split('T')[0]; }

const SELFIE = 'data:image/jpeg;base64,' + 'x'.repeat(64);
const LOC = '12.9716,77.5946';

const SEED_NONCE = 'qa-card-' + ts;
let holidayId = null;
let holidayName = null;

async function seedHoliday(dateStr, name) {
    const r = await pool.query(
        `INSERT INTO holidays (name, date, description) VALUES ($1, $2::date, $3) RETURNING id`,
        [name, dateStr, 'QA auto-generated (deleted after run)']
    );
    return r.rows[0].id;
}

async function cleanup() {
    try {
        if (holidayId) await pool.query('DELETE FROM holidays WHERE id = $1', [holidayId]);
        for (const k of Object.keys(world)) {
            await pool.query(`DELETE FROM attendance WHERE employee_id = $1`, [world[k].id]);
            await pool.query(`DELETE FROM leave_applications WHERE employee_id = $1`, [world[k].id]);
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
    const month = today.substring(5, 7).replace(/^0/, '');
    const year = today.substring(0, 4);
    const wcfgRes = await pool.query(`SELECT setting_value FROM company_settings WHERE setting_key = 'weekoff_day'`);
    const weekoffDay = wcfgRes.rows.length ? parseInt(wcfgRes.rows[0].setting_value, 10) : 0;

    // ---- 1. Throwaway world -------------------------------------------------
    const hashes = {};
    for (const tag of ['fresh', 'absent', 'legacy', 'happy', 'mgr']) hashes[tag] = await bcrypt.hash('Qa!' + ts + tag, 6);
    const mk = async (tag) => {
        const r = await pool.query(
            `INSERT INTO employees (employee_id, first_name, last_name, email, password_hash, joining_date, salary, role, status, must_change_password)
             VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, 0, $6, 'active', 0)
             RETURNING id`,
            [`qa${ts}${tag}`, 'QA', tag.toUpperCase(), `qa${ts}${tag}@hrms-qa.invalid`, hashes[tag], tag === 'mgr' ? 'manager' : 'employee']
        );
        return { id: r.rows[0].id, employee_id: `qa${ts}${tag}`, password: 'Qa!' + ts + tag };
    };
    world.fresh = await mk('fresh');
    world.absent = await mk('absent');
    world.legacy = await mk('legacy');
    world.happy = await mk('happy');
    world.mgr = await mk('mgr');

    console.log('[QA] throwaway world created:', Object.fromEntries(Object.entries(world).map(([k, v]) => [k, v.id])));
    console.log('[QA] today (IST):', today, '| weekoff_day:', weekoffDay);

    // ---- 2. Logins ----------------------------------------------------------
    const login = async (key) => {
        const r = await api('POST', '/api/auth/login', null, { employee_id: world[key].employee_id, password: world[key].password, portal: 'employee' });
        return r.json && r.json.token;
    };
    const T = {};
    for (const k of ['fresh', 'absent', 'legacy', 'happy', 'mgr']) {
        T[k] = await login(k);
        check(`login: ${k}`, !!T[k]);
    }

    // ---- 3. /attendance/my today context (no-row employee) ------------------
    const freshMy = await api('GET', `/api/attendance/my?month=${month}&year=${year}`, T.fresh);
    check('fresh /my -> 200 success', freshMy.status === 200 && !!(freshMy.json && freshMy.json.success), freshMy.json);
    const tctx = freshMy.json && freshMy.json.today;
    check('fresh /my returns today context object', !!tctx && typeof tctx === 'object', tctx);
    check('today.date === IST today (plain YYYY-MM-DD)', !!tctx && tctx.date === today, tctx);
    const isWeekoffToday = new Date(today + 'T00:00:00').getDay() === weekoffDay;
    check('today.weekoff matches configured weekoff_day for today', !!tctx && tctx.weekoff === isWeekoffToday, tctx);
    check('today.holiday null when no holiday seeded', !!tctx && tctx.holiday === null, tctx);
    check('today.onLeave false when no leave covers today', !!tctx && tctx.onLeave === false, tctx);

    // Holiday context: seed one for today, re-read, remove.
    holidayName = 'QA Auto Holiday ' + ts % 100000;
    holidayId = await seedHoliday(today, holidayName);
    const holMy = await api('GET', `/api/attendance/my?month=${month}&year=${year}`, T.fresh);
    check('today.holiday = seeded holiday name', !!(holMy.json && holMy.json.today && holMy.json.today.holiday === holidayName), holMy.json && holMy.json.today);
    await pool.query('DELETE FROM holidays WHERE id = $1', [holidayId]);
    holidayId = null;
    const holGone = await api('GET', `/api/attendance/my?month=${month}&year=${year}`, T.fresh);
    check('today.holiday null after holiday removed', !!(holGone.json && holGone.json.today && holGone.json.today.holiday === null), holGone.json && holGone.json.today);

    // Leave context: seed an approved leave covering today, re-read, remove.
    await pool.query(
        `INSERT INTO leave_applications (employee_id, start_date, end_date, total_days, reason, status)
         VALUES ($1, $2::date, $2::date, 1, $3, 'approved')`,
        [world.fresh.id, today, SEED_NONCE]
    );
    const lvMy = await api('GET', `/api/attendance/my?month=${month}&year=${year}`, T.fresh);
    check('today.onLeave true when approved leave covers today', !!(lvMy.json && lvMy.json.today && lvMy.json.today.onLeave === true), lvMy.json && lvMy.json.today);
    await pool.query('DELETE FROM leave_applications WHERE employee_id = $1', [world.fresh.id]);

    // ---- 4. Absent/on-leave row for TODAY is NOT actionable (no check-in) ----
    // Simulate a manager's mark-absent: a row with check_in NULL + check_out NULL.
    await pool.query(
        `INSERT INTO attendance (employee_id, date, status, remarks) VALUES ($1, $2::date, 'absent', $3)`,
        [world.absent.id, today, SEED_NONCE]
    );
    const coAbsent = await api('POST', '/api/attendance/check-out', T.absent, { photo: SELFIE, location: LOC });
    check('check-out on a no-check-in row -> 400 "No check-in found for today"', coAbsent.status === 400 && /No check-in found/i.test((coAbsent.json && coAbsent.json.message) || ''), coAbsent.json);
    let row = await pool.query('SELECT check_in, check_out FROM attendance WHERE employee_id = $1 AND date = $2::date', [world.absent.id, today]);
    check('absent row NOT closed by check-out (check_out stays NULL)', !!row.rows[0] && !row.rows[0].check_out, row.rows[0]);

    const bsAbsent = await api('POST', '/api/attendance/break-start', T.absent, {});
    check('break-start on a no-check-in row -> 400 "No check-in found today"', bsAbsent.status === 400 && /No check-in found/i.test((bsAbsent.json && bsAbsent.json.message) || ''), bsAbsent.json);
    const beAbsent = await api('POST', '/api/attendance/break-end', T.absent, {});
    check('break-end on a no-check-in row -> 400 "No check-in found today"', beAbsent.status === 400 && /No check-in found/i.test((beAbsent.json && beAbsent.json.message) || ''), beAbsent.json);
    row = await pool.query('SELECT break_start, break_log FROM attendance WHERE employee_id = $1 AND date = $2::date', [world.absent.id, today]);
    check('absent row break_start still NULL after blocked break calls', !row.rows[0].break_start, row.rows[0]);

    // The card renders this state as Check-In (status-aware). /my must expose it.
    const absentMy = await api('GET', `/api/attendance/my?month=${month}&year=${year}`, T.absent);
    const absentRow = ((absentMy.json && absentMy.json.attendance) || []).find(a => dd(a.date) === today);
    check('absent /my exposes the absent row with check_in NULL (card shows not-started)', !!absentRow && !absentRow.check_in && absentRow.status === 'absent', absentRow);

    // Regression: a real check-in on that row converts it to present (the
    // override branch must still work - the guards must not block it).
    const ciAbsent = await api('POST', '/api/attendance/check-in', T.absent, { photo: SELFIE, location: LOC });
    check('check-in on absent row still converts to a present day (200 + check_in)', ciAbsent.status === 200 && !!(ciAbsent.json && ciAbsent.json.success && ciAbsent.json.attendance && ciAbsent.json.attendance.check_in), ciAbsent.json);
    row = await pool.query('SELECT check_in, status FROM attendance WHERE employee_id = $1 AND date = $2::date', [world.absent.id, today]);
    check('absent row now has check_in and status != absent', !!row.rows[0] && !!row.rows[0].check_in && row.rows[0].status !== 'absent', row.rows[0]);

    // ---- 5. Legacy impossible row (closed without check-in) never re-opens ---
    await pool.query(
        `INSERT INTO attendance (employee_id, date, check_out, status) VALUES ($1, $2::date, '18:30', 'absent')`,
        [world.legacy.id, today]
    );
    const ciLegacy = await api('POST', '/api/attendance/check-in', T.legacy, { photo: SELFIE, location: LOC });
    check('check-in on a closed (check_out set) no-check-in legacy row -> 400 "Already checked out today"', ciLegacy.status === 400 && /Already checked out today/i.test((ciLegacy.json && ciLegacy.json.message) || ''), ciLegacy.json);
    row = await pool.query('SELECT check_in, check_out FROM attendance WHERE employee_id = $1 AND date = $2::date', [world.legacy.id, today]);
    check('legacy row untouched (no check_in written)', !!row.rows[0] && !row.rows[0].check_in && row.rows[0].check_out === '18:30:00', row.rows[0]);

    // ---- 5b. Admin/manager monthly matrix: today-with-no-record is NOT
    // absent (mirror of the card fix - the matrix showed everyone "Absent"
    // at 9 AM before they checked in, inflating the month's Absent count).
    // Date-robust: if today happens to be the configured week off, expect
    // the weekoff cell instead. ------------------------------------------------
    const monthly = await api('GET', `/api/attendance/monthly?month=${month}&year=${year}`, T.mgr);
    check('mgr /monthly -> 200 success (manager role)', monthly.status === 200 && !!(monthly.json && monthly.json.success), monthly.json);
    const todayDay = parseInt(today.substring(8, 10), 10);
    const cell = monthly.json && monthly.json.matrix && monthly.json.matrix[world.fresh.id]
        ? monthly.json.matrix[world.fresh.id][todayDay]
        : null;
    check('mgr /monthly includes fresh (seeded) employee', !!cell, cell);
    const monthDOW = new Date(today + 'T00:00:00').getDay();
    if (monthDOW === weekoffDay) {
        check('monthly today cell (week-off day, no record) -> weekoff', !!cell && cell.status === 'weekoff', cell);
    } else {
        check('monthly today cell (no record) -> NOT absent (upcoming)', !!cell && cell.status === 'upcoming', cell);
    }

    // ---- 6. Happy path regression: guards must not break the normal day ------
    const ciHappy = await api('POST', '/api/attendance/check-in', T.happy, { photo: SELFIE, location: LOC });
    check('happy check-in -> 200 + check_in set', ciHappy.status === 200 && !!(ciHappy.json && ciHappy.json.success && ciHappy.json.attendance && ciHappy.json.attendance.check_in), ciHappy.json);
    const bsHappy = await api('POST', '/api/attendance/break-start', T.happy, {});
    check('happy break-start -> 200 (guards don\'t block real breaks)', bsHappy.status === 200 && !!(bsHappy.json && bsHappy.json.success), bsHappy.json);
    const beHappy = await api('POST', '/api/attendance/break-end', T.happy, {});
    check('happy break-end -> 200 + entry appended to break_log', beHappy.status === 200 && !!(beHappy.json && beHappy.json.success && beHappy.json.attendance && (beHappy.json.attendance.break_log || '').length > 0), beHappy.json);
    const coHappy = await api('POST', '/api/attendance/check-out', T.happy, { photo: SELFIE, location: LOC });
    check('happy check-out -> 200 + check_out set', coHappy.status === 200 && !!(coHappy.json && coHappy.json.success && coHappy.json.attendance && coHappy.json.attendance.check_out), coHappy.json);
    const happyMy = await api('GET', `/api/attendance/my?month=${month}&year=${year}`, T.happy);
    const happyRow = ((happyMy.json && happyMy.json.attendance) || []).find(a => dd(a.date) === today);
    check('happy completed day visible in /my (check_out + break_log intact)', !!happyRow && !!happyRow.check_out, happyRow);

    // ---- Summary ------------------------------------------------------------
    console.log('\n[QA] results:');
    results.forEach(r => console.log(r));
    console.log(`\n[QA] ${pass} passed, ${fail} failed`);
    const left = await cleanup();
    if (left > 0) console.log(`[QA] NOTE: ${left} seeded employee(s) left behind (fix cleanup)`);
    await pool.end();
    process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => {
    console.error('[QA] fatal:', e);
    process.exit(1);
});