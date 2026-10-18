const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { runWithSchemaRepair, pgErrorResponse } = require('../utils/schemaRepair');
const { logAudit } = require('../utils/audit');

// Self-heals the consent_records table on a database that predates it.
const q = (sql, params) => runWithSchemaRepair(() => query(sql, params));

// Allowed consent choices. 'withdrawn' records a withdrawal of a prior grant.
// 'acknowledged' is for notice receipt/read acknowledgement (no choice).
const ALLOWED_CHOICES = ['granted', 'declined', 'withdrawn', 'acknowledged'];

// Notice keys currently in use. Adding a new notice requires a new entry here
// and a matching notice_version (see docs/POLICY_PRIVACY.md versioning).
const KNOWN_NOTICE_KEYS = [
    'privacy',
    'employee_notice',
    'attendance_camera',
    'attendance_location',
    'push_notifications',
    'terms_acceptable_use',
];

function validateConsentBody(body) {
    const errors = [];
    if (!body || typeof body !== 'object') {
        errors.push('Request body is required');
        return { ok: false, errors };
    }
    const { notice_key, notice_version, purpose, choice } = body;

    if (!notice_key || String(notice_key).trim() === '') {
        errors.push('notice_key is required');
    } else if (!KNOWN_NOTICE_KEYS.includes(String(notice_key))) {
        errors.push(`Unknown notice_key '${notice_key}'. Add it to KNOWN_NOTICE_KEYS first.`);
    }
    if (!notice_version || String(notice_version).trim() === '') {
        errors.push('notice_version is required');
    }
    if (!purpose || String(purpose).trim() === '') {
        errors.push('purpose is required');
    }
    if (!choice || !ALLOWED_CHOICES.includes(String(choice))) {
        errors.push(`choice must be one of ${ALLOWED_CHOICES.join(', ')}`);
    }

    return { ok: errors.length === 0, errors };
}

// @route   POST /api/consent/record
// @desc    Record an employee's consent/acknowledgement/withdrawal for a notice.
//          Written server-side only — the client cannot forge the user_id,
//          timestamp or method. Appends an audit event.
// @access  Private (authenticated)
router.post('/record', verifyToken, async (req, res) => {
    try {
        const { ok, errors } = validateConsentBody(req.body);
        if (!ok) {
            return res.status(400).json({ success: false, errors });
        }

        const { notice_key, notice_version, purpose, choice, method, notice_hash, locale } = req.body;
        const userId = Number(req.user.id);

        const result = await q(
            `INSERT INTO consent_records
                (user_id, notice_key, notice_version, purpose, choice, timestamp, method, notice_hash, locale)
             VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8)
             RETURNING id, user_id, notice_key, notice_version, purpose, choice, timestamp, method, locale`,
            [userId, notice_key, notice_version, purpose, choice, method || null, notice_hash || null, locale || null]
        );

        // Append an audit event (fire-and-forget; must not break the business op).
        logAudit({
            actorId: userId,
            action: 'consent.record',
            entityType: 'consent_record',
            entityId: String(result.rows[0].id),
            details: {
                notice_key,
                notice_version,
                purpose,
                choice,
                method: method || null,
            },
            ip: req.ip || null,
        });

        return res.status(201).json({
            success: true,
            consent: result.rows[0],
        });
    } catch (error) {
        const mapped = pgErrorResponse(error);
        return res.status(mapped.status).json({ success: false, message: mapped.message });
    }
});

// @route   GET /api/consent/mine
// @desc    List the caller's own consent records (newest first).
// @access  Private (authenticated)
router.get('/mine', verifyToken, async (req, res) => {
    try {
        const userId = Number(req.user.id);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

        const rows = await q(
            `SELECT id, notice_key, notice_version, purpose, choice, timestamp, method, locale, withdrawal_timestamp
             FROM consent_records
             WHERE user_id = $1
             ORDER BY timestamp DESC
             LIMIT $2 OFFSET $3`,
            [userId, limit, offset]
        );

        return res.json({
            success: true,
            consent: rows.rows,
            limit,
            offset,
        });
    } catch (error) {
        const mapped = pgErrorResponse(error);
        return res.status(mapped.status).json({ success: false, message: mapped.message });
    }
});

module.exports = router;
