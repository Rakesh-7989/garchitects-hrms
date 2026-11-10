#!/usr/bin/env node
/**
 * scripts/qa-cron.cjs — cron harness: fail-closed guard, REAL side effects,
 * liveness heartbeat, and scheduler/route parity.
 *
 * Why this harness was rewritten (2026-11-10): the old version asserted only
 * "401 without a secret" and "200 with a secret" - and it SKIPPED the second
 * half whenever CRON_SECRET was missing. Result: the suite stayed green while
 * all six production crons had never fired. A green HTTP status is not proof
 * that a scheduled job works.
 *
 * What it proves now:
 *   1. Every cron GET answers 401 without a secret and with a wrong secret
 *      (fail closed - audit-security F13).
 *   2. A secret with surrounding whitespace, or a lower-case "bearer" scheme,
 *      is still accepted - Vercel documents both as silent-401 failure modes
 *      ("if the header doesn't match the value your code reads, your endpoint
 *      returns 401 for every invocation").
 *   3. Each job, invoked with the right secret, ACTUALLY CHANGES THE DATABASE:
 *      photo purged, announcement deactivated, handover ended, unjustified
 *      late row swept to absent, forgotten check-out closed.
 *   4. Every job writes a liveness heartbeat (cron_runs) and
 *      GET /api/cron/health (admin-only) reports all jobs fresh + healthy.
 *   5. vercel.json, server/config/cronJobs.js and server/routes/cron.js agree
 *      on the job list - a scheduled-but-unrouted job fails silently.
 *
 * Run: node scripts/qa-cron.cjs
 *   Needs a running app server on :3000 whose CRON_SECRET equals
 *   QA_CRON_SECRET / CRON_SECRET. The QA commander injects both for this
 *   harness only (every other boot keeps CRON_SECRET empty so the RBAC
 *   matrix's "cron without a secret -> 401" rows still hold).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const BASE_URL = process.env.QA_BASE_URL || 'http://localhost:3000';
const CRON_SECRET = process.env.QA_CRON_SECRET || process.env.CRON_SECRET || '';
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

async function api(method, path, cronSecret, body, extraHeaders) {
    const headers = { 'Content-Type': 'application/json', ...(extraHeaders || {}) };
    if (cronSecret) headers.Authorization = 'Bearer ' + cronSecret;
    const res = await fetch(BASE_URL + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON */ }
    return { status: res.status, json };
}

// --- settings snapshot (company_settings is global - restore it!) -----------
const SETTING_KEYS = ['office_end_time', 'checkout_grace_minutes'];
const settingsBackup = {};
async function saveSetting(key) {
    const r = await pool.query('SELECT setting_value FROM company_settings WHERE setting_key = $1', [key]);
    settingsBackup[key] = r.rows.length ? r.rows[0].setting_value : null; // null => row did not exist
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

// YYYY-MM-DD in the office timezone (same helper the server uses).
function istToday() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}
function istDayOffset(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

async function main() {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

    // ---- 0. The authorized half of this test is the whole point ------------
    if (!CRON_SECRET) {
        check('CRON_SECRET available for the authorized cron run', false,
            'set QA_CRON_SECRET (or CRON_SECRET) to the value the server booted with - '
            + 'without it the authorized half of this harness is skipped, which is exactly how six dead production crons passed QA');
        await pool.end();
        console.log(`\nqa-cron: ${pass} pass / ${fail} fail`);
        results.forEach(r => console.log(r));
        process.exit(1);
    }

    // ---- 1. Throwaway world -------------------------------------------------
    const adminHash = await bcrypt.hash('Qa!' + ts + 'adm', 6);
    const admin = await pool.query(
        `INSERT INTO employees (employee_id, first_name, last_name, email, password_hash, joining_date, salary, role, status, must_change_password)
         VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,0,'admin','active',0) RETURNING id`,
        [`qa${ts}adm`, 'QA', 'ADMIN', `qa${ts}adm@hrms-qa.invalid`, adminHash]);
    const adminId = admin.rows[0].id;

    const empHash = await bcrypt.hash('Qa!' + ts + 'emp', 6);
    const emp = await pool.query(
        `INSERT INTO employees (employee_id, first_name, last_name, email, password_hash, joining_date, salary, role, status, must_change_password)
         VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,0,'employee','active',0) RETURNING id`,
        [`qa${ts}emp`, 'QA', 'EMP', `qa${ts}emp@hrms-qa.invalid`, empHash]);
    const empId = emp.rows[0].id;

    const today = istToday();

    // (a) today, checked in, never checked out -> auto-checkout must close it
    await pool.query(
        `INSERT INTO attendance (employee_id, date, check_in, status) VALUES ($1, $2, '09:00:00', 'present')`,
        [empId, today]);
    const openRow = (await pool.query('SELECT id FROM attendance WHERE employee_id = $1 AND date = $2', [empId, today])).rows[0];

    // (b) a past day that is still 'late' with no approved justification -> sweep-late
    const pastDay = istDayOffset(-3);
    await pool.query(
        `INSERT INTO attendance (employee_id, date, check_in, status) VALUES ($1, $2, '10:30:00', 'late')`,
        [empId, pastDay]);

    // (c) an expired announcement -> expire-announcements
    await pool.query(
        `INSERT INTO announcements (title, content, priority, posted_by, is_active, expires_at)
         VALUES ($1,$2,'urgent',$3,1, CURRENT_DATE - INTERVAL '1 day')`,
        ['Expired announcement', 'Should be expired by cron', adminId]);

    // (d) an active handover past its end_date -> expire-handovers
    await pool.query(
        `INSERT INTO team_handovers (absent_tl_id, cover_tl_id, start_date, end_date, status, requested_by)
         VALUES ($1,$1,CURRENT_DATE - INTERVAL '2 day',CURRENT_DATE - INTERVAL '1 day','active',$1)`,
        [adminId]);

    // (e) an expired check-in photo -> purge-photos
    await pool.query(
        `INSERT INTO attendance_photos (attendance_id, employee_id, photo, token, viewed, expires_at, type)
         VALUES ($1,$2,decode('00','hex'),$3,0, NOW() - INTERVAL '1 day','check_in')`,
        [openRow.id, empId, `qa${ts}photo`]);

    // ---- 2. Fail-closed + header-hygiene -----------------------------------
    const noSecret = await api('GET', '/api/cron/auto-attendance', undefined);
    check('cron without secret -> 401', noSecret.status === 401, { status: noSecret.status });

    const wrongSecret = await api('GET', '/api/cron/purge-photos', 'wrong-secret');
    check('cron with wrong secret -> 401', wrongSecret.status === 401, { status: wrongSecret.status });

    // Same length, different bytes: the timing-safe compare must still reject.
    const sameLengthWrong = 'X'.repeat(CRON_SECRET.length);
    const sameLen = await api('GET', '/api/cron/purge-photos', sameLengthWrong);
    check('cron with same-length wrong secret -> 401', sameLen.status === 401, { status: sameLen.status });

    // A Vercel invocation that reaches us with a bad secret must be recorded
    // as 'unauthorized' - that is what separates "the scheduler never called
    // us" from "the scheduler called us and we rejected it".
    const rejected = await api('GET', '/api/cron/purge-photos', 'wrong-secret', null, { 'x-vercel-cron-schedule': '0 3 * * *' });
    check('vercel cron invocation with a wrong secret -> 401', rejected.status === 401, { status: rejected.status });
    const rejBeat = (await pool.query('SELECT last_status, last_result FROM cron_runs WHERE job = $1', ['purge-photos'])).rows[0];
    check('a rejected vercel invocation is recorded as unauthorized',
        rejBeat && rejBeat.last_status === 'unauthorized', rejBeat);
    check('the rejected invocation records its cron schedule',
        rejBeat && /0 3 \* \* \*/.test(rejBeat.last_result || ''), rejBeat);
    // A plain (non-Vercel) unauthorized request must NOT be recorded.
    const beforePlain = (await pool.query('SELECT last_status FROM cron_runs WHERE job = $1', ['expire-handovers'])).rows[0];
    await api('GET', '/api/cron/expire-handovers', 'wrong-secret');
    const afterPlain = (await pool.query('SELECT last_status FROM cron_runs WHERE job = $1', ['expire-handovers'])).rows[0];
    check('a plain unauthorized request is not written to the heartbeat',
        (beforePlain && beforePlain.last_status) === (afterPlain && afterPlain.last_status),
        { before: beforePlain, after: afterPlain });

    // Vercel failure mode #1: a secret pasted with trailing whitespace/newline.
    const padded = await api('GET', '/api/cron/purge-photos', CRON_SECRET + ' \n');
    check('cron with whitespace-padded secret -> 200 (trimmed)', padded.status === 200, { status: padded.status });

    // Vercel failure mode #2: the bearer scheme is case-insensitive (RFC 7235).
    const lowerScheme = await api('GET', '/api/cron/purge-photos', null, null, { Authorization: 'bearer ' + CRON_SECRET });
    check('cron with lower-case bearer scheme -> 200', lowerScheme.status === 200, { status: lowerScheme.status });

    // ---- 3. Real side effects ----------------------------------------------
    // auto-checkout: force the deadline into the past so the job is
    // deterministic regardless of the wall clock.
    await saveSetting('office_end_time');
    await saveSetting('checkout_grace_minutes');
    await setSetting('office_end_time', '00:00');
    await setSetting('checkout_grace_minutes', '0');

    const co = await api('GET', '/api/cron/auto-checkout', CRON_SECRET);
    check('cron auto-checkout -> 200', co.status === 200, { status: co.status, body: co.json });
    const closed = (await pool.query('SELECT check_out, auto_checkout FROM attendance WHERE id = $1', [openRow.id])).rows[0];
    check('auto-checkout closed the forgotten check-out',
        !!closed && !!closed.check_out && closed.auto_checkout === true, closed);

    const ea = await api('GET', '/api/cron/expire-announcements', CRON_SECRET);
    check('cron expire-announcements -> 200', ea.status === 200, { status: ea.status, body: ea.json });
    const ann = (await pool.query('SELECT is_active FROM announcements WHERE posted_by = $1 ORDER BY id DESC LIMIT 1', [adminId])).rows[0];
    check('expire-announcements deactivated the expired announcement', ann && Number(ann.is_active) === 0, ann);

    const eh = await api('GET', '/api/cron/expire-handovers', CRON_SECRET);
    check('cron expire-handovers -> 200', eh.status === 200, { status: eh.status, body: eh.json });
    const ho = (await pool.query('SELECT status FROM team_handovers WHERE requested_by = $1 ORDER BY id DESC LIMIT 1', [adminId])).rows[0];
    check('expire-handovers ended the past handover', ho && ho.status === 'ended', ho);

    const sl = await api('GET', '/api/cron/sweep-late', CRON_SECRET);
    check('cron sweep-late -> 200', sl.status === 200, { status: sl.status, body: sl.json });
    const late = (await pool.query('SELECT status, remarks FROM attendance WHERE employee_id = $1 AND date = $2', [empId, pastDay])).rows[0];
    check('sweep-late turned the unjustified late row into absent',
        late && late.status === 'absent' && /late justification missing/.test(late.remarks || ''), late);

    const pp = await api('GET', '/api/cron/purge-photos', CRON_SECRET);
    check('cron purge-photos -> 200', pp.status === 200, { status: pp.status, body: pp.json });
    const photo = (await pool.query('SELECT COUNT(*)::int AS n FROM attendance_photos WHERE token = $1', [`qa${ts}photo`])).rows[0];
    check('purge-photos deleted the expired photo', photo && photo.n === 0, photo);
    // The header-hygiene probes above already ran purge-photos, so seed a
    // second expired photo to prove THIS call did the deleting.
    await pool.query(
        `INSERT INTO attendance_photos (attendance_id, employee_id, photo, token, viewed, expires_at, type)
         VALUES ($1,$2,decode('00','hex'),$3,0, NOW() - INTERVAL '1 day','check_in')`,
        [openRow.id, empId, `qa${ts}photo2`]);
    const pp2 = await api('GET', '/api/cron/purge-photos', CRON_SECRET);
    const photo2 = (await pool.query('SELECT COUNT(*)::int AS n FROM attendance_photos WHERE token = $1', [`qa${ts}photo2`])).rows[0];
    check('purge-photos deleted the photo seeded for this run',
        pp2.status === 200 && photo2 && photo2.n === 0 && Number(pp2.json && pp2.json.deleted) >= 1,
        { status: pp2.status, body: pp2.json, remaining: photo2 });

    // auto-attendance: it marks EVERY active non-admin employee without a row
    // on the past workdays absent, so the harness snapshots the affected rows
    // first and removes exactly what the job added (keeps the DB pristine).
    const beforeRows = (await pool.query(`SELECT id FROM attendance WHERE remarks LIKE 'Auto-marked absent%'`)).rows.map(r => r.id);
    const beforeNotifs = (await pool.query(`SELECT id FROM user_notifications WHERE type = 'attendance_marked_absent'`)).rows.map(r => r.id);
    const aa = await api('GET', '/api/cron/auto-attendance', CRON_SECRET);
    check('cron auto-attendance -> 200', aa.status === 200, { status: aa.status, body: aa.json });
    const newAbsent = (await pool.query(`SELECT id FROM attendance WHERE remarks LIKE 'Auto-marked absent%'`)).rows.map(r => r.id)
        .filter(id => !beforeRows.includes(id));
    const newNotifs = (await pool.query(`SELECT id FROM user_notifications WHERE type = 'attendance_marked_absent'`)).rows.map(r => r.id)
        .filter(id => !beforeNotifs.includes(id));
    check('auto-attendance marked the missing check-ins absent', newAbsent.length > 0, { marked: newAbsent.length });
    check('auto-attendance notified each newly-marked employee', newNotifs.length >= newAbsent.length, { notifs: newNotifs.length, absent: newAbsent.length });

    // ---- 4. Liveness heartbeat ---------------------------------------------
    const jobs = ['auto-attendance', 'auto-checkout', 'purge-photos', 'expire-announcements', 'expire-handovers', 'sweep-late'];
    const beats = (await pool.query('SELECT job, last_run_at, last_success_at, last_status FROM cron_runs')).rows;
    const byJob = new Map(beats.map(b => [b.job, b]));
    const missingBeat = jobs.filter(j => !byJob.has(j));
    check('every cron job wrote a liveness heartbeat', missingBeat.length === 0, { missing: missingBeat });
    const badStatus = jobs.filter(j => byJob.has(j) && byJob.get(j).last_status !== 'ok');
    check('every heartbeat is marked ok', badStatus.length === 0, { bad: badStatus });

    // ---- 5. Admin health endpoint ------------------------------------------
    const login = await fetch(BASE_URL + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employee_id: `qa${ts}adm`, password: 'Qa!' + ts + 'adm', portal: 'admin' })
    });
    const loginJson = await login.json().catch(() => ({}));
    const token = loginJson && loginJson.token;
    check('admin login for the health endpoint', !!token, { status: login.status });
    if (token) {
        const health = await api('GET', '/api/cron/health', null, null, { Authorization: 'Bearer ' + token });
        check('GET /api/cron/health -> 200 for an admin', health.status === 200, { status: health.status, body: health.json });
        const h = health.json || {};
        check('health reports every scheduled job', h.jobs && h.jobs.length === jobs.length, { count: h.jobs && h.jobs.length });
        check('health reports no stale job right after the run', h.stale_jobs && h.stale_jobs.length === 0, { stale: h.stale_jobs });
        check('health reports the system as healthy', h.healthy === true, { healthy: h.healthy, failing: h.failing_jobs });
        // Non-admin must not read the health surface.
        const empLogin = await fetch(BASE_URL + '/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ employee_id: `qa${ts}emp`, password: 'Qa!' + ts + 'emp', portal: 'employee' })
        });
        const empToken = (await empLogin.json().catch(() => ({}))).token;
        if (empToken) {
            const denied = await api('GET', '/api/cron/health', null, null, { Authorization: 'Bearer ' + empToken });
            check('GET /api/cron/health -> 403 for an employee', denied.status === 403, { status: denied.status });
        } else {
            check('employee login for the health-endpoint role check', false, { status: empLogin.status });
        }
    }

    // ---- 6. Scheduler <-> route parity --------------------------------------
    const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    const scheduled = (vercel.crons || []).map(c => ({ path: c.path, schedule: c.schedule }));
    const registry = require(path.join(ROOT, 'server', 'config', 'cronJobs.js'));
    const declared = registry.CRON_JOBS.map(j => ({ path: j.path, schedule: j.schedule }));
    const sameSet = scheduled.length === declared.length
        && scheduled.every(s => declared.some(d => d.path === s.path && d.schedule === s.schedule));
    check('vercel.json crons match server/config/cronJobs.js exactly', sameSet, { scheduled, declared });

    const routeSrc = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'cron.js'), 'utf8');
    const unrouted = declared.filter(d => !routeSrc.includes(`'${d.path.replace('/api/cron', '')}'`));
    check('every scheduled cron path is implemented in server/routes/cron.js', unrouted.length === 0, { unrouted: unrouted.map(u => u.path) });

    // ---- 7. Rollback the world ---------------------------------------------
    // Remove exactly what auto-attendance added, then the throwaway rows.
    if (newAbsent.length) {
        await pool.query('DELETE FROM attendance WHERE id = ANY($1::int[])', [newAbsent]);
    }
    if (newNotifs.length) {
        await pool.query('DELETE FROM user_notifications WHERE id = ANY($1::int[])', [newNotifs]);
    }
    await pool.query('DELETE FROM attendance_photos WHERE token = ANY($1::text[])', [[`qa${ts}photo`, `qa${ts}photo2`]]);
    await pool.query('DELETE FROM attendance WHERE employee_id = $1', [empId]);
    await pool.query('DELETE FROM announcements WHERE posted_by = $1', [adminId]);
    await pool.query('DELETE FROM team_handovers WHERE requested_by = $1', [adminId]);
    await pool.query('DELETE FROM user_notifications WHERE employee_id = $1', [empId]);
    await pool.query('DELETE FROM employees WHERE id = $1', [empId]);
    await pool.query('DELETE FROM employees WHERE id = $1', [adminId]);
    await restoreSettings();
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
