/**
 * test-smtp.js — verify the SMTP/email configuration and (optionally) send a
 * test mail, WITHOUT needing the database.
 *
 * Reads the same env vars as server/services/email.js:
 *   SMTP_USER (required), SMTP_PASS (required), SMTP_HOST (default smtp.gmail.com),
 *   SMTP_PORT (default 587), SMTP_FROM (falls back to SMTP_USER)
 *
 * Usage:
 *   npm run test:smtp                 # validate config + login only
 *   npm run test:smtp -- <email>      # also send a test mail to <email>
 *   SMTP_TEST_TO=<email> npm run test:smtp
 *
 * Exit codes: 0 = OK, 1 = config missing/invalid, 2 = SMTP login failed,
 *             3 = send failed.
 */
require('dotenv').config();
const nodemailer = require('nodemailer');

const PLACEHOLDERS = ['your-email@gmail.com', 'your-app-password', 'your-password'];

function isPlaceholder(v) {
    return PLACEHOLDERS.some((p) => String(v || '').trim().toLowerCase() === p);
}

function configured() {
    const u = (process.env.SMTP_USER || '').trim();
    const p = (process.env.SMTP_PASS || '').trim();
    if (!u || !p) return { ok: false, reason: 'SMTP_USER / SMTP_PASS are not set.' };
    if (isPlaceholder(u) || isPlaceholder(p)) {
        return { ok: false, reason: 'SMTP_USER / SMTP_PASS still contain placeholder values. Fill them with the real Gmail address and App Password.' };
    }
    return { ok: true, user: u };
}

const cfg = configured();
if (!cfg.ok) {
    console.error('✖ SMTP not configured: ' + cfg.reason);
    console.error('  See .env.example — set SMTP_USER + SMTP_PASS (Gmail App Password, 16 chars, spaces allowed).');
    process.exit(1);
}

const host = process.env.SMTP_HOST || 'smtp.gmail.com';
const port = parseInt(process.env.SMTP_PORT || '587', 10);
const from = (process.env.SMTP_FROM || '').trim() || cfg.user;

(async () => {
    const transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user: cfg.user, pass: process.env.SMTP_PASS }
    });

    // transporter.verify() attempts the SMTP login — this is what catches a
    // wrong App Password. For Gmail also confirm "2-Step Verification" is ON
    // on the account, otherwise App Passwords cannot be created/used.
    try {
        await transporter.verify();
        console.log('✔ SMTP login OK  ' + host + ':' + port + ' as ' + cfg.user);
    } catch (e) {
        console.error('✖ SMTP login failed: ' + (e && e.message ? e.message : e));
        console.error('  - For Gmail use an App Password (not the account password).');
        console.error('  - App Passwords require 2-Step Verification enabled on the Google account.');
        console.error('  - Make sure SMTP_USER is correct (the login account, not just the From-address).');
        process.exit(2);
    }

    const to = process.env.SMTP_TEST_TO || process.argv[2];
    if (!to) {
        console.log('✔ Configuration valid. To send a test mail:  npm run test:smtp -- <recipient@example.com>');
        process.exit(0);
    }

    try {
        const info = await transporter.sendMail({
            from: `"G-Architects HRMS" <${from}>`,
            to,
            subject: `G-Architects HRMS - SMTP test ${new Date().toISOString()}`,
            text: 'This is a test email from the G-Architects HRMS SMTP verification script.\n\nIf you received this, the mail pipeline is working.\n\n- G-Architects HRMS',
            html: '<p>This is a test email from the <strong>G-Architects HRMS</strong> SMTP verification script.</p><p>If you received this, the mail pipeline is working.</p>'
        });
        console.log('✔ Test mail sent to ' + to + ' (messageId ' + info.messageId + ')');
        process.exit(0);
    } catch (e) {
        console.error('✖ Send failed: ' + (e && e.message ? e.message : e));
        console.error('  - If using SMTP_FROM different from SMTP_USER, Gmail requires that From address be added as a "Send mail as" alias in the account.');
        process.exit(3);
    }
})();