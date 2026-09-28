// ============================================================
// TEAM TRANSFERS — cross-team employee movement (workflow release).
//
// A team_lead/manager who needs headcount requests an employee who currently
// reports to ANOTHER team lead ("source"). The source lead (the employee's
// CURRENT reporting manager at decision time) — or any manager/admin (oversight)
// — approves/rejects the release. On approval the employee's
// reporting_manager_id moves to the requester, so the requester can then place
// them into their projects (reporting tree, P8/D8) and assign work.
//
// Access model:
//   - team_lead / manager / admin may request, and admin/manager oversee all.
//   - HR is read-only (monitor view) — matches the projects-module direction.
//   - employees never request (the requester is always a lead/manager).
// Notifications: web push (best-effort) + bell "pending transfers" count.
// ============================================================
const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { runWithSchemaRepair, pgErrorResponse } = require('../utils/schemaRepair');
const { logAudit } = require('../utils/audit');
const { sendToUser, sendToUsers } = require('../services/push');

const q = (sql, params) => runWithSchemaRepair(() => query(sql, params));

const ACTORS = ['team_lead', 'manager', 'admin'];
const isActor = (role) => ACTORS.includes(role);
const isOverlord = (role) => role === 'admin' || role === 'manager';

async function adminsAndManagersIds() {
    const r = await q(`SELECT id FROM employees WHERE role IN ('admin','manager') AND status = 'active'`);
    return r.rows.map(x => x.id);
}

// ---------------- GET /my — requests I raised (as requester) or must release
router.get('/my', verifyToken, async (req, res) => {
    if (!isActor(req.user.role)) {
        return res.status(403).json({ success: false, message: 'Only team leads, managers and admins use transfers' });
    }
    try {
        const r = await q(
            `SELECT tr.id, tr.employee_id, tr.from_tl_id, tr.to_tl_id, tr.reason, tr.status,
                    tr.decided_by, tr.decided_at, tr.created_at,
                    e.employee_id AS emp_code, e.first_name AS emp_first, e.last_name AS emp_last,
                    e.first_name || ' ' || e.last_name AS employee_name,
                    ft.first_name || ' ' || ft.last_name AS from_tl_name,
                    ft.employee_id AS from_tl_code,
                    tt.first_name || ' ' || tt.last_name AS to_tl_name,
                    tt.employee_id AS to_tl_code,
                    db.first_name || ' ' || db.last_name AS decided_by_name,
                    e.reporting_manager_id AS current_rm
             FROM team_transfer_requests tr
             JOIN employees e ON e.id = tr.employee_id
             JOIN employees ft ON ft.id = tr.from_tl_id
             JOIN employees tt ON tt.id = tr.to_tl_id
             LEFT JOIN employees db ON db.id = tr.decided_by
             WHERE tr.from_tl_id = $1 OR tr.to_tl_id = $1
             ORDER BY tr.created_at DESC
             LIMIT 200`,
            [req.user.id]
        );
        res.json({ success: true, requests: r.rows });
    } catch (error) {
        console.error('team-transfers/my error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ---------------- GET / — all requests (manager/admin monitor, HR read-only)
router.get('/', verifyToken, async (req, res) => {
    if (!['admin', 'manager', 'hr'].includes(req.user.role)) {
        return res.status(403).json({ success: false, message: 'Only managers, admins and HR monitor transfers' });
    }
    try {
        const r = await q(
            `SELECT tr.id, tr.employee_id, tr.from_tl_id, tr.to_tl_id, tr.reason, tr.status,
                    tr.decided_by, tr.decided_at, tr.created_at,
                    e.employee_id AS emp_code, e.first_name || ' ' || e.last_name AS employee_name,
                    ft.first_name || ' ' || ft.last_name AS from_tl_name, ft.employee_id AS from_tl_code,
                    tt.first_name || ' ' || tt.last_name AS to_tl_name, tt.employee_id AS to_tl_code,
                    db.first_name || ' ' || db.last_name AS decided_by_name,
                    e.reporting_manager_id AS current_rm
             FROM team_transfer_requests tr
             JOIN employees e ON e.id = tr.employee_id
             JOIN employees ft ON ft.id = tr.from_tl_id
             JOIN employees tt ON tt.id = tr.to_tl_id
             LEFT JOIN employees db ON db.id = tr.decided_by
             ORDER BY tr.created_at DESC
             LIMIT 300`,
            []
        );
        res.json({ success: true, requests: r.rows });
    } catch (error) {
        console.error('team-transfers list error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ---------------- GET /candidates — employees in OTHER leads' teams (picker)
router.get('/candidates', verifyToken, async (req, res) => {
    if (!isActor(req.user.role)) {
        return res.status(403).json({ success: false, message: 'Only team leads, managers and admins use transfers' });
    }
    try {
        const r = await q(
            `SELECT e.id, e.employee_id, e.first_name || ' ' || e.last_name AS full_name,
                    g.name AS designation_name,
                    rm.id AS current_tl_id,
                    rm.employee_id AS current_tl_code,
                    rm.first_name || ' ' || rm.last_name AS current_tl_name
             FROM employees e
             LEFT JOIN designations g ON g.id = e.designation_id
             JOIN employees rm ON rm.id = e.reporting_manager_id
             WHERE e.status = 'active' AND e.role != 'admin' AND e.id <> $1
               AND e.reporting_manager_id IS NOT NULL AND rm.status = 'active'
             ORDER BY rm.first_name, e.first_name`,
            [req.user.id]
        );
        res.json({ success: true, candidates: r.rows });
    } catch (error) {
        console.error('team-transfers/candidates error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ---------------- POST / — raise a transfer request
router.post('/', verifyToken, async (req, res) => {
    if (!isActor(req.user.role)) {
        return res.status(403).json({ success: false, message: 'Only team leads, managers and admins can request transfers' });
    }
    try {
        const employeeId = parseInt(req.body.employeeId, 10);
        const reason = String(req.body.reason || '').trim().slice(0, 1000);
        if (isNaN(employeeId)) return res.status(400).json({ success: false, message: 'Employee ID is required' });

        const emp = await q(`SELECT id, role, status, reporting_manager_id FROM employees WHERE id = $1`, [employeeId]);
        if (emp.rows.length === 0) return res.status(404).json({ success: false, message: 'Employee not found' });
        const E = emp.rows[0];
        if (E.status !== 'active') return res.status(400).json({ success: false, message: 'Employee is not active' });
        if (E.role === 'admin') return res.status(400).json({ success: false, message: 'Admins cannot be transferred' });
        if (!E.reporting_manager_id) return res.status(400).json({ success: false, message: 'Employee has no reporting manager to release them' });
        if (E.reporting_manager_id === req.user.id) return res.status(400).json({ success: false, message: 'This employee is already in your team' });

        // One pending request per (employee, requester).
        const dup = await q(
            `SELECT 1 FROM team_transfer_requests WHERE employee_id = $1 AND to_tl_id = $2 AND status = 'pending' LIMIT 1`,
            [employeeId, req.user.id]
        );
        if (dup.rows.length > 0) return res.status(400).json({ success: false, message: 'You already have a pending request for this employee' });

        const ins = await q(
            `INSERT INTO team_transfer_requests (employee_id, from_tl_id, to_tl_id, reason)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [employeeId, E.reporting_manager_id, req.user.id, reason || null]
        );
        const rm = await q(
            `SELECT id, employee_id, first_name, last_name FROM employees WHERE id = $1`,
            [E.reporting_manager_id]
        );
        const rmRow = rm.rows[0] || {};
        const requester = req.user;

        logAudit({ actorId: req.user.id, action: 'transfer.request', entityType: 'employee', entityId: employeeId,
            details: { requestId: ins.rows[0].id, fromTl: E.reporting_manager_id, toTl: req.user.id, reason } });

        // Notify: source lead (release approval) + manager/admin oversight.
        const notifyIds = new Set([E.reporting_manager_id, ...(await adminsAndManagersIds())]);
        sendToUsers([...notifyIds], {
            title: 'Transfer request — action needed',
            body: `${requester.name} requested ${E.employee_id}${rmRow.employee_id ? ' (from ' + rmRow.employee_id + ')' : ''} to join their team`,
            url: '/manager/my-team?tab=transfers'
        }).catch(() => {});

        res.status(201).json({ success: true, requestId: ins.rows[0].id });
    } catch (error) {
        console.error('team-transfers create error:', error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

// ---------------- approve / reject — source lead (current RM) or manager/admin
async function canDecideTransfer(meId, meRole, E) {
    if (isOverlord(meRole)) return true;
    return E.reporting_manager_id === meId; // the CURRENT source lead
}

async function decide(req, res, action) {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ success: false, message: 'Invalid request id' });
    // Only a source lead / manager / admin can decide.
    if (!isActor(req.user.role)) {
        return res.status(403).json({ success: false, message: 'Only team leads, managers and admins can decide transfers' });
    }
    try {
        const tr = await q(`SELECT * FROM team_transfer_requests WHERE id = $1`, [id]);
        if (tr.rows.length === 0) return res.status(404).json({ success: false, message: 'Transfer request not found' });
        const T = tr.rows[0];
        if (T.status !== 'pending') return res.status(400).json({ success: false, message: 'This request is already ' + T.status });

        const emp = await q(`SELECT id, employee_id, role, status, reporting_manager_id FROM employees WHERE id = $1`, [T.employee_id]);
        if (emp.rows.length === 0) return res.status(404).json({ success: false, message: 'Transferred employee no longer exists' });
        const E = emp.rows[0];

        if (!(await canDecideTransfer(req.user.id, req.user.role, E))) {
            return res.status(403).json({ success: false, message: 'Only the employee\'s current team lead, a manager or an admin can decide' });
        }
        // Stale guard: the request snapshot must still match reality.
        if (E.reporting_manager_id !== T.from_tl_id) {
            return res.status(400).json({ success: false, message: 'This request is stale — the employee has already changed teams. Ask for a fresh request.' });
        }

        if (action === 'approve') {
            await q(`UPDATE employees SET reporting_manager_id = $1 WHERE id = $2`, [T.to_tl_id, T.employee_id]);
            await q(`UPDATE team_transfer_requests SET status = 'approved', decided_by = $1, decided_at = NOW() WHERE id = $2`, [req.user.id, id]);
            logAudit({ actorId: req.user.id, action: 'transfer.approve', entityType: 'employee', entityId: T.employee_id,
                details: { requestId: id, fromTl: T.from_tl_id, toTl: T.to_tl_id } });
            const names = await q(
                `SELECT id, employee_id, first_name, last_name FROM employees WHERE id = ANY($1::int[])`,
                [[T.to_tl_id, T.from_tl_id, T.employee_id]]
            );
            const byId = {};
            names.rows.forEach(r => { byId[r.id] = r; });
            const toTl = byId[T.to_tl_id] || {}, fromTl = byId[T.from_tl_id] || {}, empU = byId[T.employee_id] || {};
            const send = new Set([T.to_tl_id, T.employee_id, ...(await adminsAndManagersIds())]);
            if (T.from_tl_id !== req.user.id) send.add(T.from_tl_id);
            sendToUsers([...send], {
                title: 'Transfer approved',
                body: `${empU.employee_id} moved to ${toTl.employee_id}'s team (released by ${fromTl.employee_id})`,
                url: '/manager/my-team?tab=transfers'
            }).catch(() => {});
            return res.json({ success: true, message: 'Transfer approved — employee moved to the requesting lead' });
        }

        // reject
        await q(`UPDATE team_transfer_requests SET status = 'rejected', decided_by = $1, decided_at = NOW() WHERE id = $2`, [req.user.id, id]);
        logAudit({ actorId: req.user.id, action: 'transfer.reject', entityType: 'employee', entityId: T.employee_id,
            details: { requestId: id, fromTl: T.from_tl_id, toTl: T.to_tl_id } });
        const requester = await q(`SELECT id, first_name, last_name FROM employees WHERE id = $1`, [T.to_tl_id]);
        if (requester.rows[0]) {
            sendToUser(T.to_tl_id, {
                title: 'Transfer request rejected',
                body: `${req.user.name} declined the transfer of employee #${T.employee_id} to your team`,
                url: '/manager/my-team?tab=transfers'
            }).catch(() => {});
        }
        return res.json({ success: true, message: 'Transfer request rejected' });
    } catch (error) {
        console.error('team-transfers decide error:', error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
}

router.post('/:id/approve', verifyToken, (req, res) => decide(req, res, 'approve'));
router.post('/:id/reject', verifyToken, (req, res) => decide(req, res, 'reject'));

// ---------------- POST /:id/cancel — the requester (or admin) may withdraw
router.post('/:id/cancel', verifyToken, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ success: false, message: 'Invalid request id' });
    if (!isActor(req.user.role)) {
        return res.status(403).json({ success: false, message: 'Only team leads, managers and admins can cancel transfers' });
    }
    try {
        const tr = await q(`SELECT * FROM team_transfer_requests WHERE id = $1`, [id]);
        if (tr.rows.length === 0) return res.status(404).json({ success: false, message: 'Transfer request not found' });
        const T = tr.rows[0];
        if (T.status !== 'pending') return res.status(400).json({ success: false, message: 'Only pending requests can be cancelled' });
        if (req.user.role !== 'admin' && T.to_tl_id !== req.user.id && T.from_tl_id !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Only the requester or an admin can cancel this request' });
        }
        await q(`UPDATE team_transfer_requests SET status = 'cancelled', decided_by = $1, decided_at = NOW() WHERE id = $2`, [req.user.id, id]);
        res.json({ success: true, message: 'Transfer request cancelled' });
    } catch (error) {
        console.error('team-transfers cancel error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;