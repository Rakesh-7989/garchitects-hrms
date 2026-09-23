/**
 * _diag_smtp.js — one-shot SMTP transport diagnostic (temp, env-driven).
 *
 * Reads SMTP_* from env (injected by the temp workflow from the Vercel env
 * API — never committed). Reports ONLY safe facts: placeholder state,
 * configuration completeness, and transporter.verify() result. Secrets are
 * never printed.
 */
require('dotenv').config();
const nodemailer = require('nodemailer');

const PLACEHOLDER = 'your-email@gmail.com';

function check(name, val, critical) {
    const missing = !val || val === PLACEHOLDER;
    const tag = missing ? (critical ? 'MISSING/PLACEHOLDER' : 'absent(ok)') : 'set';
    console.log(`[${tag}] ${name}`);
    if (missing && critical) process.exitCode = 2;
}

(async () => {
    console.log('=== SMTP config presence ===');
    check('SMTP_HOST', process.env.SMTP_HOST, true);
    check('SMTP_PORT', process.env.SMTP_PORT, true);
    check('SMTP_USER', process.env.SMTP_USER, true);
    check('SMTP_PASS', process.env.SMTP_PASS, true);
    console.log('[info] SMTP_FROM:', process.env.SMTP_FROM && process.env.SMTP_FROM !== PLACEHOLDER ? 'set' : 'absent/placeholder');
    console.log('[info] NODE_ENV:', process.env.NODE_ENV || 'unset');

    const { SMTP_USER, SMTP_PASS, SMTP_HOST, SMTP_PORT } = process.env;
    if (!SMTP_USER || !SMTP_PASS || !SMTP_HOST || SMTP_USER === PLACEHOLDER) {
        console.log('=== result: NOT CONFIGURED — 502 expected (getTransporter returns null) ===');
        process.exit(process.exitCode || 0);
    }

    console.log('=== transport.verify() ===');
    const transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: parseInt(SMTP_PORT || '587', 10),
        secure: false,
        auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
    try {
        await transporter.verify();
        console.log('=== result: VERIFY OK — SMTP auth + host work ===');
    } catch (e) {
        console.log('=== result: VERIFY FAILED — ' + e.message.split('\n')[0] + ' ===');
        process.exit(1);
    }
})();