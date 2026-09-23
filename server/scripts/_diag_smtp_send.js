/**
 * _diag_smtp_send.js — decisive live SMTP test (temp).
 * Injected SMTP_* come from temp GitHub secrets (never committed).
 * Verifies transporter, then attempts a real send to TEST_TO.
 */
require('dotenv').config();
const nodemailer = require('nodemailer');

const PLACEHOLDER = 'your-email@gmail.com';
const TEST_TO = process.env.TEST_TO || '';
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);

(async () => {
    if (!SMTP_USER || !SMTP_PASS || SMTP_USER === PLACEHOLDER) {
        console.log('[FAIL] SMTP_USER/PASS missing or placeholder');
        process.exit(2);
    }
    console.log(`[info] host=${SMTP_HOST} port=${SMTP_PORT} user=${SMTP_USER} to=${TEST_TO} secure=false`);
    const transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: false,
        auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
    try {
        await transporter.verify();
        console.log('[OK] transport.verify() passed — SMTP auth accepted');
    } catch (e) {
        console.log('[FAIL] verify: ' + e.message.split('\n')[0]);
        process.exit(1);
    }
    if (!TEST_TO) {
        console.log('[SKIP] no TEST_TO, skipping actual send');
        process.exit(0);
    }
    try {
        const info = await transporter.sendMail({
            from: `"G-Architects HRMS" <${SMTP_USER}>`,
            to: TEST_TO,
            subject: 'SMTP diagnostic — G-Architects HRMS',
            text: 'If you see this, Gmail SMTP is configured correctly for the HRMS.',
        });
        console.log('[OK] sendMail accepted, messageId=' + (info.messageId || 'n/a'));
    } catch (e) {
        console.log('[FAIL] sendMail: ' + e.message.split('\n')[0]);
        process.exit(1);
    }
})();