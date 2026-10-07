/**
 * qa-attendance-checkin-status.cjs — live QA harness for the "checked in, but
 * the portal says not checked in" bug.
 *
 * Story: an employee checks in; the row lands in `attendance` (admin sees it),
 * but the employee's dashboard shows "Not checked in yet" and keeps prompting
 * a re-check-in.
 *
 * Root cause (verified):
 *   node-postgres parses DATE columns (OID 1082) at LOCAL midnight, and
 *   res.json() serializes via toISOString(). On any host east of UTC the JSON
 *   becomes the PREVIOUS day's ISO string. Here (TZ=Asia/Kolkata, India Std
 *   Time) DATE '2026-10-07' -> "2026-10-06T18:30:00.000Z". The dashboard finds
 *   "today" through `(a.date || '').split('T')[0]` compared to getTodayIST(),
 *   so it gets "2026-10-06" and never matches today's row. Admin pages render
 *   the date through formatDate()/new Date(), which round-trips the shift, so
 *   the record looks fine on the admin side - matching the reported symptoms.
 *
 * Fix under test: GET /api/attendance/my and GET /api/attendance/all now
 * normalize `date` with server/utils/date.js `dateOnly()` -> plain YYYY-MM-DD,
 * independent of the server's timezone.
 *
 * Also under test (deadlock recovery): POST /api/attendance/check-in answers
 * 409 + `alreadyCheckedIn` + the existing row when today's check-in already
 * exists, so a dashboard that missed today's row can flip straight to the
 * checked-in state and Check-Out is always reachable (no more "check-in ->
 * 'Already checked in today' -> no check-out button"). The harness proves the
 * full recovery: duplicate check-in -> 409 -> check-out succeeds.
 *
 * Run:
 *   1. Start the server (this machine's TZ is Asia/Kolkata, so the shift is
 *      real here; for determinism you may also `$env:TZ='Asia/Kolkata'` first).
 *   2. node scripts/qa-attendance-checkin-status.cjs
 *
 * The login route rate-limits to 10 attempts per 15 min per IP and this
 * harness does 3 logins per run - restart the server before a rerun to reset
 * the in-memory limiter.
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

// Same "today" the client uses: YYYY-MM-DD in IST (getTodayIST / istDateString).
function todayIST() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function dd(dateStr) {
    return (dateStr || '').split('T')[0];
}

async function cleanup() {
    try {
        const names = Object.keys(world);
        for (const k of names) {
            await pool.query(`DELETE FROM attendance WHERE employee_id = $1`, [world[k].id]);
        }
        for (const k of names) {
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

    // ---- 1. Throwaway world -------------------------------------------------
    const hashes = {};
    const roles = { adm: 'admin', emp: 'employee', cmp: 'employee' };
    for (const tag of Object.keys(roles)) hashes[tag] = await bcrypt.hash('Qa!' + ts + tag, 6);

    const mk = async (tag, role) => {
        const r = await pool.query(
            `INSERT INTO employees (employee_id, first_name, last_name, email, password_hash, joining_date, salary, role, status, must_change_password)
             VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, 0, $6, 'active', 0)
             RETURNING id`,
            [`qa${ts}${tag}`, 'QA', tag.toUpperCase(), `qa${ts}${tag}@hrms-qa.invalid`, hashes[tag], role]
        );
        return { id: r.rows[0].id, employee_id: `qa${ts}${tag}`, password: 'Qa!' + ts + tag };
    };

    world.admin = await mk('adm', 'admin');
    world.open = await mk('emp', 'employee');   // live check-in, still open
    world.done = await mk('cmp', 'employee');   // full day, checked out

    // The DB already holds today's rows - the exact "admin sees it" premise.
    await pool.query(
        `INSERT INTO attendance (employee_id, date, check_in, check_out, status, check_in_location)
         VALUES ($1, $2::date, $3, NULL, 'present', $4)`,
        [world.open.id, today, '09:15', '17.4255,78.4378']
    );
    await pool.query(
        `INSERT INTO attendance (employee_id, date, check_in, check_out, status, check_in_location)
         VALUES ($1, $2::date, $3, $4, 'present', $5)`,
        [world.done.id, today, '09:15', '18:00', '17.4255,78.4378']
    );

    console.log('[QA] throwaway world created:', Object.fromEntries(Object.entries(world).map(([k, v]) => [k, v.id])));
    console.log('[QA] today (IST):', today);

    // ---- 2. Logins ----------------------------------------------------------
    const login = async (key, portal) => {
        const r = await api('POST', '/api/auth/login', null, { employee_id: world[key].employee_id, password: world[key].password, portal });
        return r.json && r.json.token;
    };
    const T = {
        admin: await login('admin', 'admin'),
        open: await login('open', 'employee'),
        done: await login('done', 'employee'),
    };
    check('login: admin', !!T.admin);
    check('login: employee (open day)', !!T.open);
    check('login: employee (completed day)', !!T.done);

    // ---- 3. The reported bug: "today" must be findable from /attendance/my --
    const myOpen = await api('GET', `/api/attendance/my?month=${month}&year=${year}`, T.open);
    check('GET /attendance/my -> success', !!(myOpen.json && myOpen.json.success), myOpen.json);
    const rowsOpen = (myOpen.json && myOpen.json.attendance) || [];
    const dateShapesOpen = rowsOpen.every(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date || ''));
    check('every row date is plain YYYY-MM-DD (no "T", no day shift)', dateShapesOpen, rowsOpen.slice(0, 2));
    check(`a row exists with date === ${today} (exact string equality)`, rowsOpen.some(r => r.date === today), rowsOpen.slice(0, 2));
    check('row value has no embedded ISO "T"', rowsOpen.every(r => !String(r.date).includes('T')), (rowsOpen[0] || {}).date);

    // The dashboard's exact lookup: const adate = a.date ? a.date.split('T')[0] : ''; adate === today.
    const foundOpen = rowsOpen.find(a => dd(a.date) === today);
    check('client "today" lookup finds the OPEN check-in (check_in preserved)', !!(foundOpen && String(foundOpen.check_in).startsWith('09:15')), foundOpen);
    check('open row location preserved', !!(foundOpen && (foundOpen.check_in_location || '').startsWith('17.')), foundOpen && foundOpen.check_in_location);

    // ---- 3b. Deadlock recovery: "already checked in" must never strand the
    //          employee without a Check-Out path ----------------------------
    // Pre-fix: duplicate check-in was a dead-end 400 and the dashboard (which
    // had missed today's row) had no Check-Out button at all. Now the server
    // answers 409 with the existing row so the client can recover immediately.
    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const dup = await api('POST', '/api/attendance/check-in', T.open, { location: '17.4255,78.4378', photo: tinyPng });
    check('duplicate check-in -> 409 (conflict, not a dead-end 400)', dup.status === 409, { status: dup.status, json: dup.json });
    check('409 carries alreadyCheckedIn flag', !!(dup.json && dup.json.alreadyCheckedIn === true), dup.json);
    check('409 carries existing row with plain YYYY-MM-DD date', !!(dup.json && dup.json.attendance && dup.json.attendance.date === today), dup.json && dup.json.attendance);
    check('409 row preserves check_in / location / status', !!(
        dup.json && dup.json.attendance &&
        String(dup.json.attendance.check_in).startsWith('09:15') &&
        (dup.json.attendance.check_in_location || '').startsWith('17.') &&
        dup.json.attendance.status === 'present'
    ), dup.json && dup.json.attendance);

    // The recovery the dashboard now performs from that 409 payload: the row is
    // rendered as checked-in, so Check-Out is reachable and succeeds.
    const co = await api('POST', '/api/attendance/check-out', T.open, { location: '17.4255,78.4378', photo: tinyPng });
    check('check-out succeeds after the 409 recovery row (deadlock broken)', co.status === 200 && !!(co.json && co.json.success), co.json);
    const myAfter = await api('GET', `/api/attendance/my?month=${month}&year=${year}`, T.open);
    const afterRow = ((myAfter.json && myAfter.json.attendance) || []).find(a => dd(a.date) === today);
    check(`after check-out, /attendance/my shows check_out on today's row`, !!(afterRow && afterRow.check_out), afterRow);

    const myDone = await api('GET', `/api/attendance/my?month=${month}&year=${year}`, T.done);
    const rowsDone = (myDone.json && myDone.json.attendance) || [];
    const foundDone = rowsDone.find(a => dd(a.date) === today);
    check('client "today" lookup finds the COMPLETED day (check_in + check_out intact)', !!(
        foundDone && String(foundDone.check_in).startsWith('09:15') && String(foundDone.check_out).startsWith('18:00') && foundDone.status === 'present'
    ), foundDone);

    // ---- 4. Admin register also ships plain dates ---------------------------
    const all = await api('GET', '/api/attendance/all?limit=50', T.admin);
    check('GET /attendance/all -> success', !!(all.json && all.json.success), all.json);
    const rowsAll = (all.json && all.json.attendance) || [];
    check('admin register: every date is plain YYYY-MM-DD', rowsAll.every(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date || '')), rowsAll.slice(0, 2));

    // ---- 5. Cleanup ----------------------------------------------------------
    const leftover = await cleanup();
    check('all QA employees fully removed after cleanup', leftover === 0, { leftover });
}

process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

main()
    .catch((e) => { console.error('[QA] fatal:', e); fail++; })
    .finally(async () => {
        await cleanup();
        console.log('\n[QA] attendance check-in status results:');
        console.log(results.join('\n'));
        console.log(`\n${pass} passed, ${fail} failed`);
        process.exit(fail === 0 ? 0 : 1);
    });