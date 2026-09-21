const express = require('express');
const router = express.Router();

// TEMP DIAGNOSTIC ROUTE - delete after SMTP root cause is fixed.
// Reveals SMTP config state (masked) and attempts a real test send.
// Guarded by SMTP_DIAG_KEY env var so it is not publicly exposed.
router.get('/smtp', async (req, res) => {
    const key = process.env.SMTP_DIAG_KEY;
    if (!key || req.query.key !== key) {
        return res.status(403).json({ success: false, message: 'forbidden' });
    }
    const email = require('../services/email');
    const user = process.env.SMTP_USER || '';
    const pass = process.env.SMTP_PASS || '';
    const host = process.env.SMTP_HOST || '';
    const port = process.env.SMTP_PORT || '';
    const from = process.env.SMTP_FROM || '';

    const info = {
        SMTP_HOST: host,
        SMTP_PORT: port,
        SMTP_FROM: from,
        SMTP_USER_set: !!user,
        SMTP_USER_is_placeholder: user === 'your-email@gmail.com',
        SMTP_USER_masked: user ? user.slice(0, 4) + '***@' + (user.split('@')[1] || '') : '(empty)',
        SMTP_PASS_set: !!pass,
        SMTP_PASS_len: pass.length,
        transporter_ready: !!email.getTransporter?.() || false,
    };

    let sendResult = null;
    const target = typeof req.query.to === 'string' ? req.query.to : null;
    if (target) {
        try {
            sendResult = await email.sendOTPEmail(target, 123456, { empId: 'DIAG' });
        } catch (e) {
            sendResult = { exception: e.message };
        }
    }
    res.json({ success: true, info, sendResult });
});

module.exports = router;