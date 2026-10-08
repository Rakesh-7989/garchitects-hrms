/**
 * qa-attendance-my-readpath.cjs — live QA harness for the GET /attendance/my
 * read-path fix (cold-start resilience).
 *
 * Story: the employee dashboard showed "Could not load your attendance
 * status." because /api/attendance/my awaited the company-wide auto-checkout
 * scan before EVERY read. On a cold Vercel instance (heavy require chain +
 * lazy Supabase pooler connect) that serialized work could breach
 * maxDuration: 30 -> 504, and the client had no retry, so one transient
 * failure stranded the card until a manual Retry.
 *
 * Fix under test:
 *   - /my now only runs runAutoCheckout() when THIS employee still has an open
 *     row today (guarded pre-check). The common case (already checked out /
 *     never checked in) no longer pays for the company-wide scan.
 *   - An employee WITH an open row still self-heals exactly as before: their
 *     read closes every open row past the deadline (full company-wide pass).
 *   - Client side (apiCall timeout/silent opts + retry-with-backoff in
 *     loadAttendanceStatus) is UI-only and covered by the inline-JS syntax
 *     gate + live asset markers, not this harness.
 *
 * Run:
 *   1. Start the server (hermetic local Postgres; this machine is IST).
 *   2. node scripts/qa-attendance-my-readpath.cjs
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

const SETTING_KEYS = ['office_end_time', 'checkout_grace_minutes'];
const settingsBackup = {};
async function saveSetting(key) {
    const r = await pool.query('SELECT setting_value FROM company_settings WHERE setting_key = $1', [key]);
    settingsBackup[key] = r.rows.length ? r.rows[0].setting_value : null;
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
            await pool.query('UPDATE company_settings SET setting_value = $1 WHERE setting_key = $2', [settingsBackup[key], key]);
        }
    }
}
async function openRow(id) {
    const r = await pool.query('SELECT check_out, auto_checkout FROM attendance WHERE employee_id = $1', [id]);
    return r.rows[0] || null;
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
    for (const tag of ['done', 'openA', 'openB', 'none']) hashes[tag] = await bcrypt.hash('Qa!' + ts + tag, 6);
    const mk = async (tag) => {
        const r = await pool.query(
            `INSERT INTO employees (employee_id, first_name, last_name, email, password_hash, joining_date, salary, role, status, must_change_password)
             VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, 0, 'employee', 'active', 0)
             RETURNING id`,
            [`qa${ts}${tag}`, 'QA', tag.toUpperCase(), `qa${ts}${tag}@hrms-qa.invalid`, hashes[tag]]
        );
        return { id: r.rows[0].id, employee_id: `qa${ts}${tag}`, password: 'Qa!' + ts + tag };
    };
    world.done = await mk('done');
    world.openA = await mk('openA');
    world.openB = await mk('openB');
    world.none = await mk('none');

    // Force the checkout deadline to 00:00 so runAutoCheckout ALWAYS fires when
    // invoked (nowMinutesIST() < 0 is never true).
    for (const key of SETTING_KEYS) await saveSetting(key);
    await setSetting('office_end_time', '00:00');
    await setSetting('checkout_grace_minutes', '0');

    // Seed: openA/openB still checked in; done has a completed day; none has no row.
    await pool.query(
        `INSERT INTO attendance (employee_id, date, check_in, status) VALUES ($1, $2::date, '09:00', 'present')`,
        [world.openA.id, today]
    );
    await pool.query(
        `INSERT INTO attendance (employee_id, date, check_in, status) VALUES ($1, $2::date, '09:10', 'present')`,
        [world.openB.id, today]
    );
    await pool.query(
        `INSERT INTO attendance (employee_id, date, check_in, check_out, status) VALUES ($1, $2::date, '09:00', '18:30', 'present')`,
        [world.done.id, today]
    );

    console.log('[QA] throwaway world created:', Object.fromEntries(Object.entries(world).map(([k, v]) => [k, v.id])));
    console.log('[QA] today (IST):', today, '| deadline forced to 00:00');

    // ---- 2. Logins ----------------------------------------------------------
    const login = async (key) => {
        const r = await api('POST', '/api/auth/login', null, { employee_id: world[key].employee_id, password: world[key].password, portal: 'employee' });
        return r.json && r.json.token;
    };
    const T = { done: await login('done'), openA: await login('openA'), openB: await login('openB'), none: await login('none') };
    check('login: done', !!T.done);
    check('login: openA', !!T.openA);
    check('login: openB', !!T.openB);
    check('login: none', !!T.none);

    // ---- 3. Common case: employee with NO open row must not run the scan ----
    const doneMy = await api('GET', `/api/attendance/my?month=${month}&year=${year}`, T.done);
    check('done /my -> 200 success (no 504-style failure)', doneMy.status === 200 && !!(doneMy.json && doneMy.json.success), doneMy.json);
    const doneRow = ((doneMy.json && doneMy.json.attendance) || []).find(a => dd(a.date) === today);
    check('done /my returns their completed row untouched (18:30)', !!doneRow && doneRow.check_out === '18:30:00', doneRow);
    let a = await openRow(world.openA.id), b = await openRow(world.openB.id);
    check('done /my did NOT run the company-wide scan (openA still open)', !!a && !a.check_out, a);
    check('done /my did NOT run the company-wide scan (openB still open)', !!b && !b.check_out, b);

    const noneMy = await api('GET', `/api/attendance/my?month=${month}&year=${year}`, T.none);
    check('none /my -> 200 success, empty list (no scan either)', noneMy.status === 200 && !!(noneMy.json && noneMy.json.success)
        && !((noneMy.json.attendance || []).find(x => dd(x.date) === today)), noneMy.json);
    a = await openRow(world.openA.id); b = await openRow(world.openB.id);
    check('none /my still did NOT trigger the scan (openA open)', !!a && !a.check_out, a);
    check('none /my still did NOT trigger the scan (openB open)', !!b && !b.check_out, b);

    // ---- 4. Employee WITH an open row still self-heals (full pass) -----------
    const openAMy = await api('GET', `/api/attendance/my?month=${month}&year=${year}`, T.openA);
    check('openA /my -> 200 success', openAMy.status === 200 && !!(openAMy.json && openAMy.json.success), openAMy.json);
    const openARow = ((openAMy.json && openAMy.json.attendance) || []).find(x => dd(x.date) === today);
    check('openA row self-healed: closed at forced deadline 00:00:00', !!openARow && openARow.check_out === '00:00:00', openARow);
    check('openA row flagged auto_checkout = true', !!openARow && openARow.auto_checkout === true, openARow);
    const bAfter = await openRow(world.openB.id);
    check('openA /my ran the full pass: openB was also closed', !!bAfter && bAfter.check_out === '00:00:00' && bAfter.auto_checkout === true, bAfter);

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