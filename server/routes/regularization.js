const express = require('express');
const router = express.Router();
const { query, getClient } = require('../config/database');
const { verifyToken, isAdmin } = require('../middleware/auth');
const { istDateString } = require('../utils/date');
const { runWithSchemaRepair } = require('../utils/schemaRepair');
const { logAudit } = require('../utils/audit');

// Every query below touches attendance_regularizations, which may not exist
// yet on a live database that predates the feature - repair and retry.
const q = (sql, params) => runWithSchemaRepair(() => query(sql, params));

// @route   POST /api/regularization
// @desc    Employee submits a regularization request for one date
// @access  Private
router.post('/', verifyToken, async (req, res) => {
    try {
        const { date, check_in, check_out, reason } = req.body || {};

        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
            return res.status(400).json({ success: false, message: 'A valid date (YYYY-MM-DD) is required' });
        }
        if (!reason || !String(reason).trim()) {
            return res.status(400).json({ success: false, message: 'Reason is required' });
        }
        if (!check_in && !check_out) {
            return res.status(400).json({ success: false, message: 'Provide at least a check-in or check-out time' });
        }
        for (const t of [check_in, check_out]) {
            if (t && !/^\d{2}:\d{2}(:\d{2})?$/.test(String(t))) {
                return res.status(400).json({ success: false, message: 'Times must be in HH:MM format' });
            }
        }
        if (String(date) >= istDateString()) {
            return res.status(400).json({ success: false, message: 'Regularization can only be requested for past dates' });
        }

        // One row per employee per date - pending or approved both block resubmission.
        const dup = await q(
            `SELECT id, status FROM attendance_regularizations WHERE employee_id = $1 AND date = $2`,
            [req.user.id, date]
        );
        if (dup.rows.length > 0) {
            return res.status(400).json({
                success: false,
                message: dup.rows[0].status === 'pending'
                    ? 'A request for this date is already pending approval'
                    : 'A request for this date was already approved'
            });
        }

        const result = await q(
            `INSERT INTO attendance_regularizations (employee_id, date, check_in, check_out, reason)
            VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [req.user.id, date, check_in ? String(check_in).slice(0, 5) : null, check_out ? String(check_out).slice(0, 5) : null, String(reason).trim()]
        );

        res.status(201).json({ success: true, request: result.rows[0] });
    } catch (error) {
        console.error('Create regularization error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/regularization/mine
// @desc    Own regularization requests (newest first)
// @access  Private
router.get('/mine', verifyToken, async (req, res) => {
    try {
        const result = await q(
            `SELECT r.*, e.first_name || ' ' || e.last_name AS reviewed_by_name
            FROM attendance_regularizations r
            LEFT JOIN employees e ON e.id = r.reviewed_by
            WHERE r.employee_id = $1
            ORDER BY r.created_at DESC LIMIT 60`,
            [req.user.id]
        );
        res.json({ success: true, requests: result.rows });
    } catch (error) {
        console.error('List my regularizations error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/regularization/pending
// @desc    Pending requests: admin sees all, managers see their subtree
// @access  Private (Admin/HR/Manager/Team Lead)
router.get('/pending', verifyToken, async (req, res) => {
    try {
        if (!['admin', 'hr', 'manager', 'team_lead'].includes(req.user.role)) {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        let rows;
        if (req.user.role === 'admin' || req.user.role === 'hr') {
            rows = await q(
                `SELECT r.*, e.first_name, e.last_name, e.employee_id,
                    rev.first_name || ' ' || rev.last_name as reviewed_by_name
                FROM attendance_regularizations r
                JOIN employees e ON e.id = r.employee_id
                LEFT JOIN employees rev ON rev.id = r.reviewed_by
                WHERE r.status = 'pending'
                ORDER BY r.created_at ASC LIMIT 100`
            );
        } else {
            rows = await q(
                `WITH RECURSIVE subtree AS (
                    SELECT id FROM employees WHERE id = $1
                    UNION
                    SELECT e.id FROM employees e JOIN subtree s ON e.reporting_manager_id = s.id
                )
                SELECT r.*, e.first_name, e.last_name, e.employee_id,
                    rev.first_name || ' ' || rev.last_name as reviewed_by_name
                FROM attendance_regularizations r
                JOIN employees e ON e.id = r.employee_id
                JOIN subtree st ON st.id = r.employee_id
                LEFT JOIN employees rev ON rev.id = r.reviewed_by
                WHERE r.status = 'pending'
                ORDER BY r.created_at ASC LIMIT 100`,
                [req.user.id]
            );
        }
        res.json({ success: true, requests: rows.rows });
    } catch (error) {
        console.error('Pending regularizations error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   POST /api/regularization/:id/review
// @desc    Approve or reject; on approve writes times into the attendance table
// @access  Private (Admin/HR/Manager of requester)
router.post('/:id/review', verifyToken, async (req, res) => {
    try {
        if (!['admin', 'hr', 'manager', 'team_lead'].includes(req.user.role)) {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }
        const { status, review_note } = req.body || {};
        if (!['approved', 'rejected'].includes(status)) {
            return res.status(400).json({ success: false, message: 'Status must be approved or rejected' });
        }

        const rows = await q(
            `SELECT r.*, e.reporting_manager_id FROM attendance_regularizations r
            JOIN employees e ON e.id = r.employee_id
            WHERE r.id = $1`,
            [req.params.id]
        );
        const requestRow = rows.rows[0];
        if (!requestRow) return res.status(404).json({ success: false, message: 'Request not found' });

        const isAdminUser = req.user.role === 'admin' || req.user.role === 'hr';
        if (!isAdminUser) {
            // Manager may only review requests from their own subtree.
            const chain = await q(
                `WITH RECURSIVE subtree AS (
                    SELECT id FROM employees WHERE id = $1
                    UNION
                    SELECT e.id FROM employees e JOIN subtree s ON e.reporting_manager_id = s.id
                )
                SELECT 1 AS found FROM subtree WHERE id = $2 LIMIT 1`,
                [req.user.id, requestRow.employee_id]
            );
            if (chain.rows.length === 0) {
                return res.status(403).json({ success: false, message: 'This request is not from your team' });
            }
        }

        if (requestRow.status !== 'pending') {
            return res.status(400).json({ success: false, message: 'This request was already reviewed' });
        }

        // Run the review + attendance write-back on ONE checked-out connection.
        // Previously BEGIN/COMMIT went through the pool helper, which can pick a
        // different connection per statement and silently break atomicity.
        const client = await getClient();
        try {
            await client.query('BEGIN');
            await client.query(
                `UPDATE attendance_regularizations
                SET status = $1, reviewed_by = $2, review_note = $3, reviewed_at = NOW()
                WHERE id = $4`,
                [status, req.user.id, (review_note || '').trim() || null, req.params.id]
            );

            if (status === 'approved') {
                // Write-back into attendance: update existing row or insert one.
                const att = await client.query(
                    'SELECT id, remarks FROM attendance WHERE employee_id = $1 AND date = $2',
                    [requestRow.employee_id, requestRow.date]
                );
                if (att.rows.length > 0) {
                    const alreadyTagged = String(att.rows[0].remarks || '').includes('[regularized]');
                    await client.query(
                        `UPDATE attendance SET
                            check_in = COALESCE($1, check_in),
                            check_out = COALESCE($2, check_out),
                            status = CASE WHEN status IN ('absent') THEN 'present' ELSE status END,
                            remarks = CASE WHEN $4 THEN remarks ELSE COALESCE(remarks, '') || ' [regularized]' END
                        WHERE id = $3`,
                        [requestRow.check_in, requestRow.check_out, att.rows[0].id, alreadyTagged]
                    );
                } else {
                    await client.query(
                        `INSERT INTO attendance (employee_id, date, check_in, check_out, status, remarks)
                        VALUES ($1, $2, $3, $4, 'present', '[regularized]')`,
                        [requestRow.employee_id, requestRow.date, requestRow.check_in, requestRow.check_out]
                    );
                }
            }
            await client.query('COMMIT');
        } catch (txErr) {
            try { await client.query('ROLLBACK'); } catch(e) {}
            throw txErr;
        } finally {
            try { client.release(); } catch(e) {}
        }
        logAudit({ actorId: req.user.id, action: status === 'approved' ? 'regularization.approve' : 'regularization.reject', entityType: 'attendance_regularization', entityId: req.params.id, details: { employee_id: requestRow.employee_id, date: requestRow.date, check_in: requestRow.check_in, check_out: requestRow.check_out }, ip: req.ip });

        res.json({ success: true, message: 'Request ' + status });
    } catch (error) {
        console.error('Review regularization error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;
