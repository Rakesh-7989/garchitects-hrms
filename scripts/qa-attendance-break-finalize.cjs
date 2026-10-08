/**
 * qa-attendance-break-finalize.cjs — live QA harness for the dangling-break
 * finalization + atomic break-end changes.
 *
 * Story: an employee starts a break and never ends it, then the day closes —
 * either manually ("Check Out") or via auto-checkout at the grace deadline.
 * Pre-fix the server closed the day but left break_start set forever: the
 * break never landed in break_log, a COMPLETED day showed "Break End:
 * Running...", and "Hours Worked" silently inflated (open breaks were not
 * subtracted on that screen). Break-end itself was a read-modify-write, so two
 * concurrent break-ends could overwrite each other's entries.
 *
 * Fix under test:
 *   - POST /api/attendance/check-out finalizes a running break into break_log
 *     { start, end: <check-out time> } and clears break_start/break_end in the
 *     SAME atomic UPDATE (guarded so a concurrent break-end is never double
 *     recorded).
 *   - runAutoCheckout() does the same when it closes the day at the deadline.
 *   - POST /api/attendance/break-end is a single guarded UPDATE: concurrent
 *     requests yield exactly one winner, the loser 400s, and no entry is lost.
 *   - break_start/break_end/break_log are preserved on GET /attendance/my, so
 *     the employee dashboard can show the true total.
 *
 * Run:
 *   1. Start the server (hermetic local Postgres; this machine is IST).
 *   2. node scripts/qa-attendance-break-finalize.cjs
 *
 * The login route rate-limits to 10 attempts per 15 min per IP and this
 * harness does 4 logins per run - restart the server before a rerun to reset
 * the in-memory limiter.
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
function parseLog(row) {
    try { return JSON.parse((row && row.break_log) || '[]'); } catch (_) { return null; }
}
function toSec(hhmmss) {
    const p = String(hhmmss || '').split(':').map(Number);
    return (p[0] || 0) * 3600 + (p[1] || 0) * 60 + (p[2] || 0);
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
        for (const k of Object.keys(world)) {
            await pool.query(`DELETE FROM attendance WHERE employee_id = $1`, [world[k].id]);
        }
        for (const k of Object.keys(world)) {
            await pool.query(`DELETE FROM employees WHERE id = $1`, [world[k].id]);
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
    const month = today.substring(5, 7).replace(/^0/, '');
    const year = today.substring(0, 4);

    // ---- 1. Throwaway world -------------------------------------------------
    const hashes = {};
    const roles = { fin: 'employee', multi: 'employee', race: 'employee', auto: 'employee' };
    for (const tag of Object.keys(roles)) hashes[tag] = await bcrypt.hash('Qa!' + ts + tag, 6);

    const mk = async (tag) => {
        const r = await pool.query(
            `INSERT INTO employees (employee_id, first_name, last_name, email, password_hash, joining_date, salary, role, status, must_change_password)
             VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, 0, 'employee', 'active', 0)
             RETURNING id`,
            [`qa${ts}${tag}`, 'QA', tag.toUpperCase(), `qa${ts}${tag}@hrms-qa.invalid`, hashes[tag]]
        );
        return { id: r.rows[0].id, employee_id: `qa${ts}${tag}`, password: 'Qa!' + ts + tag };
    };
    world.fin = await mk('fin');
    world.multi = await mk('multi');
    world.race = await mk('race');
    world.auto = await mk('auto');

    // Pin office_end far in the future during the manual flows so the read-path
    // runAutoCheckout can never auto-close a test row mid-flow (deadline 23:59
    // is always later than the current IST time). The auto-checkout test later
    // moves the deadline to 00:00 to force it.
    for (const key of SETTING_KEYS) await saveSetting(key);
    await setSetting('office_end_time', '23:59');
    await setSetting('checkout_grace_minutes', '120');

    console.log('[QA] throwaway world created:', Object.fromEntries(Object.entries(world).map(([k, v]) => [k, v.id])));
    console.log('[QA] today (IST):', today);

    // ---- 2. Logins ----------------------------------------------------------
    const login = async (key) => {
        const r = await api('POST', '/api/auth/login', null, { employee_id: world[key].employee_id, password: world[key].password, portal: 'employee' });
        return r.json && r.json.token;
    };
    const T = {
        fin: await login('fin'),
        multi: await login('multi'),
        race: await login('race'),
        auto: await login('auto'),
    };
    check('login: fin', !!T.fin);
    check('login: multi', !!T.multi);
    check('login: race', !!T.race);
    check('login: auto', !!T.auto);

    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const LOC = '17.4255,78.4378';

    // ---- 3. Manual check-out finalizes a running break ----------------------
    const finIn = await api('POST', '/api/attendance/check-in', T.fin, { location: LOC, photo: tinyPng });
    check('fin check-in -> 200', finIn.status === 200 && !!(finIn.json && finIn.json.success), finIn.json);
    const finBs = await api('POST', '/api/attendance/break-start', T.fin, {});
    check('fin break-start -> 200 (break running now)', finBs.status === 200 && !!(finBs.json && finBs.json.success), finBs.json);
    check('fin row carries open break_start while on break',
        !!(finBs.json && finBs.json.attendance && finBs.json.attendance.break_start && !finBs.json.attendance.break_end),
        finBs.json && finBs.json.attendance);
    const finCo = await api('POST', '/api/attendance/check-out', T.fin, { location: LOC, photo: tinyPng });
    const finRow = finCo.json && finCo.json.attendance;
    check('fin check-out -> 200', finCo.status === 200 && !!(finCo.json && finCo.json.success), finCo.json);
    check('fin row still checked out', !!finRow && !!finRow.check_out, finRow);
    check('fin dangling break finalized: break_start cleared', !!finRow && !finRow.break_start, finRow);
    check('fin dangling break finalized: break_end cleared', !!finRow && !finRow.break_end, finRow);
    const finLog = parseLog(finRow);
    check('fin break_log has exactly one entry', !!finLog && finLog.length === 1, finLog);
    check('fin break entry has start + end', !!(finLog && finLog[0] && finLog[0].start && finLog[0].end), finLog && finLog[0]);
    check('fin break end === check-out time (break counted up to departure)',
        !!(finLog && finLog[0] && finRow && finLog[0].end === finRow.check_out), { log: finLog && finLog[0], check_out: finRow && finRow.check_out });
    const finMy = await api('GET', `/api/attendance/my?month=${month}&year=${year}`, T.fin);
    const finPersisted = ((finMy.json && finMy.json.attendance) || []).find(a => dd(a.date) === today);
    check('fin: /attendance/my persists the finalized break (break_start NULL, log length 1)',
        !!(finPersisted && !finPersisted.break_start && parseLog(finPersisted) && parseLog(finPersisted).length === 1),
        finPersisted);

    // ---- 4. Multi-break day keeps every entry -------------------------------
    const muIn = await api('POST', '/api/attendance/check-in', T.multi, { location: LOC, photo: tinyPng });
    check('multi check-in -> 200', muIn.status === 200 && !!(muIn.json && muIn.json.success), muIn.json);
    await api('POST', '/api/attendance/break-start', T.multi, {});
    const muEnd1 = await api('POST', '/api/attendance/break-end', T.multi, {});
    check('multi break #1 end -> 200', muEnd1.status === 200 && !!(muEnd1.json && muEnd1.json.success), muEnd1.json);
    check('multi break #1 cleared break_start', !!(muEnd1.json && muEnd1.json.attendance && !muEnd1.json.attendance.break_start), muEnd1.json && muEnd1.json.attendance);
    const muLog1 = parseLog(muEnd1.json && muEnd1.json.attendance);
    check('multi break #1 -> break_log length 1', !!muLog1 && muLog1.length === 1, muLog1);
    await api('POST', '/api/attendance/break-start', T.multi, {});
    const muEnd2 = await api('POST', '/api/attendance/break-end', T.multi, {});
    check('multi break #2 end -> 200', muEnd2.status === 200 && !!(muEnd2.json && muEnd2.json.success), muEnd2.json);
    const muLog2 = parseLog(muEnd2.json && muEnd2.json.attendance);
    check('multi break #2 appended -> break_log length 2 (nothing lost)', !!muLog2 && muLog2.length === 2, muLog2);
    check('multi both entries have start + end', !!(
        muLog2 && muLog2.every(b => b.start && b.end && String(b.start).includes(':') && String(b.end).includes(':'))
    ), muLog2);
    const muCo = await api('POST', '/api/attendance/check-out', T.multi, { location: LOC, photo: tinyPng });
    check('multi check-out after 2 breaks -> 200', muCo.status === 200 && !!(muCo.json && muCo.json.success), muCo.json);
    check('multi final break_log still 2 (no duplicate break appended at check-out)',
        parseLog(muCo.json && muCo.json.attendance) && parseLog(muCo.json && muCo.json.attendance).length === 2,
        parseLog(muCo.json && muCo.json.attendance));

    // ---- 5. Auto-checkout finalizes a running break -------------------------
    // Force the checkout deadline to 00:00 so runAutoCheckout always fires
    // (deadline minutes = 0; nowMinutesIST() < 0 is never true). All other
    // users are already checked out, so only `auto`'s row is open.
    await setSetting('office_end_time', '00:00');
    await setSetting('checkout_grace_minutes', '0');
    await pool.query(
        `INSERT INTO attendance (employee_id, date, check_in, break_start, status, check_in_location)
         VALUES ($1, $2::date, '09:15', '13:00', 'present', $3)`,
        [world.auto.id, today, LOC]
    );
    const autoMy = await api('GET', `/api/attendance/my?month=${month}&year=${year}`, T.auto);
    const autoRow = ((autoMy.json && autoMy.json.attendance) || []).find(a => dd(a.date) === today);
    check('auto: /attendance/my ran auto-checkout (row closed)', !!autoRow && !!autoRow.check_out, autoRow);
    check('auto: closed at the forced deadline 00:00:00', !!autoRow && autoRow.check_out === '00:00:00', autoRow && autoRow.check_out);
    check('auto: flagged auto_checkout = true', !!autoRow && autoRow.auto_checkout === true, autoRow);
    check('auto: running break finalized (break_start cleared)', !!autoRow && !autoRow.break_start, autoRow);
    const autoLog = parseLog(autoRow);
    check('auto: break_log has exactly one entry', !!autoLog && autoLog.length === 1, autoLog);
    check('auto: entry start is the seeded 13:00:00', !!(autoLog && autoLog[0] && autoLog[0].start === '13:00:00'), autoLog && autoLog[0]);
    check('auto: entry end is the auto-check-out time 00:00:00', !!(autoLog && autoLog[0] && autoLog[0].end === '00:00:00'), autoLog && autoLog[0]);

    // ---- 6. Atomic break-end: concurrent requests never lose an entry -------
    // The auto section forced the deadline to 00:00; restore manual-safe
    // settings so runAutoCheckout can't auto-close race's row mid-flow.
    await setSetting('office_end_time', '23:59');
    await setSetting('checkout_grace_minutes', '120');
    // Two break-end requests fired concurrently must yield exactly ONE winner;
    // the loser 400s, and BOTH entries survive (pre-fix, read-modify-write
    // meant the second request overwrote the first with its own entry).
    const rcIn = await api('POST', '/api/attendance/check-in', T.race, { location: LOC, photo: tinyPng });
    check('race check-in -> 200', rcIn.status === 200 && !!(rcIn.json && rcIn.json.success), rcIn.json);
    await api('POST', '/api/attendance/break-start', T.race, {});
    const rcEnd1 = await api('POST', '/api/attendance/break-end', T.race, {});
    check('race break #1 end -> 200', rcEnd1.status === 200 && !!(rcEnd1.json && rcEnd1.json.success), rcEnd1.json);
    const rcLog1 = parseLog(rcEnd1.json && rcEnd1.json.attendance);
    check('race break #1 -> break_log length 1', !!rcLog1 && rcLog1.length === 1, rcLog1);
    await api('POST', '/api/attendance/break-start', T.race, {});
    const [rcA, rcB] = await Promise.all([
        api('POST', '/api/attendance/break-end', T.race, {}),
        api('POST', '/api/attendance/break-end', T.race, {})
    ]);
    const winners = [rcA, rcB].filter(r => r.status === 200 && !!(r.json && r.json.success)).length;
    const losers = [rcA, rcB].filter(r => r.status !== 200).length;
    check('race concurrent break-end: exactly one winner (200)', winners === 1, { winners, statuses: [rcA.status, rcB.status] });
    check('race concurrent break-end: loser answered a conflict (400)', losers === 1 && [rcA, rcB].some(r => r.status === 400), { statuses: [rcA.status, rcB.status] });
    const rcMy = await api('GET', `/api/attendance/my?month=${month}&year=${year}`, T.race);
    const rcRow = ((rcMy.json && rcMy.json.attendance) || []).find(a => dd(a.date) === today);
    const rcLogFinal = parseLog(rcRow);
    check('race: no break entry lost (break_log length 2)', !!rcLogFinal && rcLogFinal.length === 2, rcLogFinal);
    check('race: break_start cleared after the race', !!rcRow && !rcRow.break_start, rcRow);
    check('race: both entries have real start/end times',
        !!(rcLogFinal && rcLogFinal.every(b => b.start && b.end && String(b.start).includes(':') && String(b.end).includes(':'))),
        rcLogFinal);
    const rcCo = await api('POST', '/api/attendance/check-out', T.race, { location: LOC, photo: tinyPng });
    check('race check-out after race -> 200', rcCo.status === 200 && !!(rcCo.json && rcCo.json.success), rcCo.json);
    check('race final break_log still 2 (no duplicate at check-out)',
        parseLog(rcCo.json && rcCo.json.attendance) && parseLog(rcCo.json && rcCo.json.attendance).length === 2,
        parseLog(rcCo.json && rcCo.json.attendance));

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