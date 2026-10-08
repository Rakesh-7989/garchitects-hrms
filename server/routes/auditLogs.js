const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken, isAdmin } = require('../middleware/auth');
const { runWithSchemaRepair } = require('../utils/schemaRepair');

// Self-heals the audit_logs table on a database that predates it.
const q = (sql, params) => runWithSchemaRepair(() => query(sql, params));

// @route   GET /api/audit-logs
// @desc    Paginated audit trail with optional filters (admin only)
// @access  Private/Admin
router.get('/', verifyToken, isAdmin, async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

        const conditions = [];
        const params = [];

        if (req.query.action) {
            params.push(String(req.query.action));
            conditions.push(`a.action = $${params.length}`);
        }
        if (req.query.actor_id) {
            const actorId = parseInt(req.query.actor_id, 10);
            if (!Number.isNaN(actorId)) {
                params.push(actorId);
                conditions.push(`a.actor_id = $${params.length}`);
            }
        }
        if (req.query.from) {
            params.push(String(req.query.from));
            conditions.push(`a.created_at >= ($${params.length})::timestamptz`);
        }
        if (req.query.to) {
            params.push(String(req.query.to));
            conditions.push(`a.created_at < (($${params.length})::date + INTERVAL '1 day')`);
        }

        const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

        params.push(limit);
        const limitIdx = params.length;
        params.push(offset);
        const offsetIdx = params.length;

        // security F12 decision (2026-10-09): audit logs exist for
        // accountability and this page is admin-only — show ALL rows,
        // including admin-actor entries (the previous filter hid the admin's
        // own trail, creating a blind spot).
        const fromJoin = 'FROM audit_logs a LEFT JOIN employees e ON e.id = a.actor_id';
        const visibilityClause = 'TRUE';

        const rows = await q(
            `SELECT a.id, a.action, a.entity_type, a.entity_id, a.details,
                    a.ip_address, a.created_at,
                    a.actor_id,
                    e.first_name || ' ' || e.last_name AS actor_name,
                    e.employee_id AS actor_employee_id
            ${fromJoin}
            WHERE ${visibilityClause}${conditions.length ? ' AND ' + conditions.join(' AND ') : ''}
            ORDER BY a.created_at DESC
            LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
            params
        );

        // Count with the same filters for pagination display.
        const countParams = params.slice(0, limitIdx - 1);
        const countResult = await q(
            `SELECT COUNT(*)::int AS total ${fromJoin}
            WHERE ${visibilityClause}${conditions.length ? ' AND ' + conditions.join(' AND ') : ''}`,
            countParams
        );

        res.json({
            success: true,
            logs: rows.rows,
            total: countResult.rows[0] ? countResult.rows[0].total : 0,
            limit,
            offset
        });
    } catch (error) {
        console.error('Audit logs fetch error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;
