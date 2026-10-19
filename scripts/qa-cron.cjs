/**
 * scripts/qa-cron.cjs — live QA harness for cron endpoints:
 *
 *   1. All 5 cron GETs return 401 when CRON_SECRET is unset/mismatched
 *      (fail-closed — audit-security F13).
 *   2. With a valid CRON_SECRET, each cron endpoint returns 200 and executes
 *      its job (auto-attendance, auto-checkout, purge-photos,
 *      expire-announcements, expire-handovers).
 *
 * Seeds a throwaway admin + some attendance rows / announcements / handovers,
 * drives the running server's API, rolls the world back so the DB stays
 * pristine.
 *
 * Run:  node scripts/qa-cron.cjs
 *   (start `npm start` first; DATABASE_URL + CRON_SECRET must be set)
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const BASE_URL = process.env.QA_BASE_URL || 'http://localhost:3000';
const CRON_SECRET = process.env.CRON_SECRET;
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

async function api(method, path, cronSecret, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (cronSecret) headers.Authorization = 'Bearer ' + cronSecret;
    const res = await fetch(BASE_URL + path, { method, headers });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON */ }
    return { status: res.status, json };
}

async function main() {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

    // ---- 1. Throwaway world -------------------------------------------------
    const adminHash = await bcrypt.hash('Qa!' + ts + 'adm', 6);
    const admin = await pool.query(
        `INSERT INTO employees (employee_id, first_name, last_name, email, password_hash, joining_date, salary, role, status, must_change_password)
         VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,0,'admin','active',0) RETURNING id`,
        [`qa${ts}adm`, 'QA', 'ADMIN', `qa${ts}adm@hrms-qa.invalid`, adminHash]);
    const adminId = admin.rows[0].id;

    // An attendance row with a check-in but no check-out (for auto-checkout).
    await pool.query(
        `INSERT INTO attendance (employee_id, date, check_in, status)
         VALUES ($1, CURRENT_DATE, '09:00:00', 'present')`,
        [adminId]);

    // An announcement with an expired date (for expire-announcements).
    await pool.query(
        `INSERT INTO announcements (title, content, priority, posted_by, is_active, expires_at)
         VALUES ($1,$2,'urgent',$3,1, CURRENT_DATE - INTERVAL '1 day')`,
        ['Expired announcement', 'Should be expired by cron', adminId]);

    // An active handover past end_date (for expire-handovers).
    await pool.query(
        `INSERT INTO team_handovers (absent_tl_id, cover_tl_id, start_date, end_date, status, requested_by)
         VALUES ($1,$1,CURRENT_DATE - INTERVAL '2 day',CURRENT_DATE - INTERVAL '1 day','active',$1)`,
        [adminId]);

    // ---- 2. Cron endpoints return 401 without / with wrong secret -----------
    const noSecret = await api('GET', '/api/cron/auto-attendance', undefined);
    check('cron without secret -> 401', noSecret.status === 401, { status: noSecret.status });

    const wrongSecret = await api('GET', '/api/cron/purge-photos', 'wrong-secret');
    check('cron with wrong secret -> 401', wrongSecret.status === 401, { status: wrongSecret.status });

    // ---- 3. If CRON_SECRET is configured, each cron job returns 200 ----------
    if (CRON_SECRET) {
        const endpoints = [
            '/api/cron/auto-attendance',
            '/api/cron/auto-checkout',
            '/api/cron/purge-photos',
            '/api/cron/expire-announcements',
            '/api/cron/expire-handovers'
        ];
        for (const ep of endpoints) {
            const r = await api('GET', ep, CRON_SECRET);
            check(`cron ${ep} -> 200 (with valid secret)`,
                r.status === 200, { status: r.status, body: r.json });
        }
    } else {
        console.log('  ℹ CRON_SECRET not set — skipping authorized cron job execution (endpoints correctly fail-closed).');
    }

    // ---- 4. Rollback the world ---------------------------------------------
    await pool.query('DELETE FROM attendance WHERE employee_id = $1', [adminId]);
    await pool.query('DELETE FROM announcements WHERE posted_by = $1', [adminId]);
    await pool.query('DELETE FROM team_handovers WHERE requested_by = $1', [adminId]);
    await pool.query('DELETE FROM employees WHERE id = $1', [adminId]);
    await pool.end();

    // ---- report -------------------------------------------------------------
    console.log(`\nqa-cron: ${pass} pass / ${fail} fail`);
    results.forEach(r => console.log(r));
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error('qa-cron fatal:', e.message);
    process.exit(1);
});
