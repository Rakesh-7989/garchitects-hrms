const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { runAutoMark } = require('../services/attendanceAutoMark');
const { runAutoCheckout } = require('../services/attendanceAutoCheckout');
const { runWithSchemaRepair } = require('../utils/schemaRepair');

// Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` if configured, and also
// an `x-vercel-cron` header. Require the secret so the endpoints can't be hit
// publicly; when no secret is configured they are disabled entirely.
function isCronAuthorized(req) {
    const secret = process.env.CRON_SECRET;
    if (!secret) return false;
    return req.headers.authorization === `Bearer ${secret}`;
}

router.get('/auto-attendance', async (req, res) => {
    if (!isCronAuthorized(req)) return res.status(401).json({ success: false, message: 'Unauthorized' });
    try {
        const marked = await runAutoMark();
        res.json({ success: true, marked });
    } catch (error) {
        console.error('Auto-attendance cron error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.get('/auto-checkout', async (req, res) => {
    if (!isCronAuthorized(req)) return res.status(401).json({ success: false, message: 'Unauthorized' });
    try {
        const result = await runAutoCheckout();
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('Auto-checkout cron error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.get('/purge-photos', async (req, res) => {
    if (!isCronAuthorized(req)) return res.status(401).json({ success: false, message: 'Unauthorized' });
    try {
        const result = await query("DELETE FROM attendance_photos WHERE expires_at < NOW() OR viewed = 1");
        res.json({ success: true, deleted: result.changes });
    } catch (error) {
        console.error('Purge photos cron error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.get('/expire-announcements', async (req, res) => {
    if (!isCronAuthorized(req)) return res.status(401).json({ success: false, message: 'Unauthorized' });
    try {
        const result = await runWithSchemaRepair(() =>
            query("UPDATE announcements SET is_active = 0 WHERE is_active = 1 AND expires_at IS NOT NULL AND expires_at <= NOW()")
        );
        res.json({ success: true, expired: result.changes || 0 });
    } catch (error) {
        console.error('Expire announcements cron error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Flips active TL handovers whose window has passed to 'ended'. Mirrors the
// lazy expirePastHandovers() semantics (team-handovers.js) exactly, so the
// cron and the read-time path can never disagree; covers the studio case
// where nobody visits the handover pages during the window gap.
router.get('/expire-handovers', async (req, res) => {
    if (!isCronAuthorized(req)) return res.status(401).json({ success: false, message: 'Unauthorized' });
    try {
        const result = await runWithSchemaRepair(() =>
            query(`UPDATE team_handovers SET status = 'ended', ended_at = NOW()
                   WHERE status = 'active' AND end_date < CURRENT_DATE`)
        );
        res.json({ success: true, ended: result.changes || 0 });
    } catch (error) {
        console.error('Expire handovers cron error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;
