#!/usr/bin/env node
/**
 * scripts/qa-consent-ui.cjs — consent records + consent UI contract harness.
 *
 * Story: a user must be able to read the privacy notices, record their
 * consent choices, and see them again in "Manage Consent" - on EVERY page,
 * not only on the profile page.
 *
 * Fixes under test (2026-11-10, all found in the browser):
 *   - POST /api/consent/record failed with Postgres 22001 ("value too long"):
 *     consent_records.purpose was VARCHAR(100) while a notice purpose is a
 *     300+ character paragraph => widened to TEXT on all three schema layers.
 *   - the client called apiCall('/api/consent/mine') while apiCall already
 *     prefixes '/api' => '/api/api/consent/mine' (404 on every page).
 *   - the consent modal markup existed only on the login page and the employee
 *     profile, so the footer link threw a TypeError on every other page.
 *   - the "I Agree & Continue" / "Skip for now" buttons were never bound to
 *     any handler => the consent could not be recorded at all.
 *   - formatIstTime lived in admin/audit-logs.html only, so the admin
 *     dashboard's "Recent Activity" feed threw a ReferenceError on load.
 *
 * Run: node scripts/qa-consent-ui.cjs
 *   (needs a running server on :3000 and DATABASE_URL pointing at a
 *    throwaway database; the QA commander provides both)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const BASE_URL = process.env.QA_BASE_URL || 'http://localhost:3000';
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

async function api(method, p, token, body) {
    const res = await fetch(BASE_URL + p, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: 'Bearer ' + token } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* not json */ }
    return { status: res.status, json };
}

// The full privacy-notice purpose (the real one is ~320 chars - the column
// was VARCHAR(100) and every insert failed with 22001).
const LONG_PURPOSE = 'We collect and process your personal data to administer your employment, run payroll, track attendance, and comply with statutory obligations (PAN, Aadhaar, PF/ESI, bank details). Data is stored in India and accessed only by authorized HR/Admin staff.';

async function cleanup(empId) {
    try {
        await pool.query('DELETE FROM consent_records WHERE user_id = $1', [empId]);
        await pool.query('DELETE FROM employees WHERE id = $1', [empId]);
    } catch (e) { /* best-effort */ }
}

async function main() {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

    // ---- 1. Client-side contract (source level) ---------------------------
    const authSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'auth.js'), 'utf8');
    const dashSrc = fs.readFileSync(path.join(ROOT, 'public', 'pages', 'admin', 'dashboard.html'), 'utf8');
    const auditSrc = fs.readFileSync(path.join(ROOT, 'public', 'pages', 'admin', 'audit-logs.html'), 'utf8');

    check('client: no double-prefixed apiCall("/api/...") left',
        !/apiCall\(['"]\/api\//.test(authSrc), null);
    check('client: formatIstTime is defined in the shared auth.js',
        /function formatIstTime\(/.test(authSrc), null);
    check('client: the admin dashboard no longer defines its own copy',
        !/function formatIstTime\(/.test(dashSrc) && !/function formatIstTime\(/.test(auditSrc), null);
    check('client: the consent modal can be injected on demand',
        /function ensureConsentModals\(/.test(authSrc), null);
    check('client: the consent buttons are bound to an action',
        /getElementById\('consentBtnConfirm'\)[\s\S]{0,160}?onclick = confirmConsents/.test(authSrc)
        && /getElementById\('consentBtnSkip'\)[\s\S]{0,160}?onclick = closeConsentModal/.test(authSrc), null);
    check('client: closing the consent modal is null-safe',
        /function closeConsentModal\(\)\s*\{\s*const m = document\.getElementById\('consentModal'\);/.test(authSrc), null);

    // ---- 2. Schema: purpose must be wide enough ---------------------------
    for (const [label, file] of [
        ['schema.sql', path.join(ROOT, 'server', 'schema.sql')],
        ['startup migration', path.join(ROOT, 'server', 'index.js')],
        ['lazy self-heal', path.join(ROOT, 'server', 'utils', 'schemaRepair.js')],
    ]) {
        const src = fs.readFileSync(file, 'utf8');
        const block = src.slice(src.indexOf('consent_records'));
        check(`schema (${label}): consent_records.purpose is TEXT, not VARCHAR(100)`,
            /purpose TEXT NOT NULL/.test(block.slice(0, 600)) && !/purpose VARCHAR\(100\)/.test(block.slice(0, 600)), null);
    }
    // The live column must actually be wide enough.
    const col = (await pool.query(
        `SELECT character_maximum_length AS len FROM information_schema.columns
          WHERE table_name = 'consent_records' AND column_name = 'purpose'`
    )).rows[0];
    check('schema (live): consent_records.purpose accepts a full notice paragraph',
        col && (col.len === null || col.len === -1 || col.len > 300), col);

    // ---- 3. API: record + read back ---------------------------------------
    const hash = await bcrypt.hash('Qa!' + ts + 'emp', 6);
    const emp = await pool.query(
        `INSERT INTO employees (employee_id, first_name, last_name, email, password_hash, joining_date, salary, role, status, must_change_password)
         VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,0,'employee','active',0) RETURNING id`,
        [`qa${ts}consent`, 'QA', 'CONSENT', `qa${ts}consent@hrms-qa.invalid`, hash]);
    const empId = emp.rows[0].id;

    const login = await api('POST', '/api/auth/login', null, { employee_id: `qa${ts}consent`, password: 'Qa!' + ts + 'emp', portal: 'employee' });
    const token = login.json && login.json.token;
    check('employee login for the consent API', !!token, { status: login.status });

    if (token) {
        const rec = await api('POST', '/api/consent/record', token, {
            notice_key: 'privacy',
            notice_version: '1.0',
            purpose: LONG_PURPOSE,
            choice: 'granted',
            method: 'ui_modal',
            locale: 'en'
        });
        check('POST /api/consent/record with a full-length purpose -> 201',
            rec.status === 201 && !!(rec.json && rec.json.success), { status: rec.status, body: rec.json });
        check('the recorded purpose is stored intact',
            !!(rec.json && rec.json.consent && rec.json.consent.purpose === LONG_PURPOSE), rec.json && rec.json.consent);

        const mine = await api('GET', '/api/consent/mine', token);
        const rows = (mine.json && mine.json.consent) || [];
        check('GET /api/consent/mine returns the record', mine.status === 200 && rows.length === 1, { status: mine.status, rows: rows.length });
        check('the returned record keeps the notice key + choice',
            rows.length === 1 && rows[0].notice_key === 'privacy' && rows[0].choice === 'granted', rows[0]);

        const ack = await api('POST', '/api/consent/record', token, {
            notice_key: 'terms_acceptable_use', notice_version: '1.0', purpose: 'Acceptable use terms.', choice: 'acknowledged'
        });
        check('a second notice can be recorded -> 201', ack.status === 201, { status: ack.status, body: ack.json });

        const badKey = await api('POST', '/api/consent/record', token, {
            notice_key: 'not_a_real_notice', notice_version: '1.0', purpose: 'x', choice: 'granted'
        });
        check('unknown notice_key -> 400', badKey.status === 400, { status: badKey.status });

        const badChoice = await api('POST', '/api/consent/record', token, {
            notice_key: 'privacy', notice_version: '1.0', purpose: 'x', choice: 'maybe'
        });
        check('invalid choice -> 400', badChoice.status === 400, { status: badChoice.status });

        const noAuth = await api('GET', '/api/consent/mine', null);
        check('GET /api/consent/mine without a token -> 401', noAuth.status === 401, { status: noAuth.status });
    }

    await cleanup(empId);
    await pool.end();

    console.log(`\nqa-consent-ui: ${pass} pass / ${fail} fail`);
    results.forEach(r => console.log(r));
    process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
    console.error('qa-consent-ui fatal:', e.message);
    try { await pool.end(); } catch (_) { /* ignore */ }
    process.exit(1);
});
