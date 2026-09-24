const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken, isAdmin } = require('../middleware/auth');
const { istDateString } = require('../utils/date');
const { sendToUser } = require('../services/push');
const { getWorkWeekConfig } = require('../utils/workWeek');
const { runWithSchemaRepair } = require('../utils/schemaRepair');

function isWeekend(dateStr, weekoffDay = 0) {
    const d = new Date(dateStr);
    const day = d.getDay();
    return day === weekoffDay;
}

function calcBusinessDays(start, end, holidays = new Set(), weekoffDay = 0) {
    let count = 0;
    const s = new Date(start);
    const e = new Date(end);
    for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
        if (d.getDay() === weekoffDay) continue;
        const ds = istDateString(d);
        if (holidays.has(ds)) continue;
        count++;
    }
    return count;
}

router.post('/apply', verifyToken, async (req, res) => {
    try {
        const { start_date, end_date, reason } = req.body;

        if (!start_date || !end_date) {
            return res.status(400).json({ success: false, message: 'Start and end dates are required' });
        }

        const wcfg = await getWorkWeekConfig();

        if (new Date(end_date) < new Date(start_date)) {
            return res.status(400).json({ success: false, message: 'End date must be after start date' });
        }

        if (isWeekend(start_date, wcfg.weekoffDay)) {
            return res.status(400).json({ success: false, message: 'Start date cannot be a week off' });
        }

        const empRes = await runWithSchemaRepair(() => query(
            'SELECT role, reporting_manager_id, secondary_reporting_manager_id FROM employees WHERE id = $1', [req.user.id]
        ));
        const emp = empRes.rows[0];
        if (!emp) {
            return res.status(404).json({ success: false, message: 'Employee not found' });
        }
        const needsManager = emp.role === 'employee' || emp.role === 'manager' || emp.role === 'team_lead' || emp.role === 'hr';
        // Every new employee is auto-assigned to the admin as their secondary
        // reporting manager, so applying for WFH is never blocked when only
        // the team lead is missing.
        const primaryApprover = emp.reporting_manager_id || emp.secondary_reporting_manager_id || null;
        if (needsManager && !primaryApprover) {
            return res.status(400).json({ success: false, message: 'No reporting manager assigned. Contact your administrator.' });
        }
        const reporting_manager_id = needsManager ? primaryApprover : null;

        // Get manager and HR for multi-approver routing
        const approverRes = await query(
            `SELECT 
                (SELECT id FROM employees WHERE role = 'manager' AND status = 'active' LIMIT 1) as manager_id,
                (SELECT id FROM employees WHERE role = 'hr' AND status = 'active' LIMIT 1) as hr_id`
        );
        const managerId = approverRes.rows[0]?.manager_id || null;
        const hrId = approverRes.rows[0]?.hr_id || null;

        // Overlap check: no approved/pending leave or WFH on same dates
        const overlapLeave = await query(
            `SELECT id FROM leave_applications WHERE employee_id = $1 AND status IN ('pending','approved') AND NOT (end_date < $2::date OR start_date > $3::date) LIMIT 1`,
            [req.user.id, start_date, end_date]
        );
        if (overlapLeave.rows.length > 0) return res.status(400).json({ success: false, message: 'You already have a leave request on these dates' });
        const overlapWfh = await query(
            `SELECT id FROM wfh_requests WHERE employee_id = $1 AND status IN ('pending','approved') AND NOT (end_date < $2::date OR start_date > $3::date) LIMIT 1`,
            [req.user.id, start_date, end_date]
        );
        if (overlapWfh.rows.length > 0) return res.status(400).json({ success: false, message: 'You already have a WFH request on these dates' });

        const holRows = await query(`SELECT to_char(date, 'YYYY-MM-DD') as d FROM holidays WHERE date BETWEEN $1 AND $2 AND is_active = 1`, [start_date, end_date]);
        const holidays = new Set((holRows.rows || []).map(r => r.d));
        const totalDays = calcBusinessDays(start_date, end_date, holidays, wcfg.weekoffDay);

        const result = await query(
            `INSERT INTO wfh_requests (employee_id, reporting_manager_id, manager_id, hr_id, start_date, end_date, total_days, reason)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [req.user.id, reporting_manager_id, managerId, hrId, start_date, end_date, totalDays, reason]
        );

        if (reporting_manager_id) {
            const applicant = await query(
                "SELECT first_name || ' ' || last_name as name FROM employees WHERE id = $1",
                [req.user.id]
            ).catch(() => ({ rows: [] }));
            const name = (applicant.rows[0] && applicant.rows[0].name) || req.user.employee_id;
            try {
                await sendToUser(reporting_manager_id, {
                    title: 'New WFH Request',
                    body: `${name} requested work from home (${totalDays} day${totalDays > 1 ? 's' : ''})`,
                    url: '/manager/my-team'
                });
            } catch (e) { console.error('Push notify error:', e.message); }
        }

        // Notify manager
        if (managerId && managerId !== reporting_manager_id) {
            const applicant = await query(
                "SELECT first_name || ' ' || last_name as name FROM employees WHERE id = $1",
                [req.user.id]
            ).catch(() => ({ rows: [] }));
            const name = (applicant.rows[0] && applicant.rows[0].name) || req.user.employee_id;
            try {
                await sendToUser(managerId, {
                    title: 'New WFH Request',
                    body: `${name} requested work from home (${totalDays} day${totalDays > 1 ? 's' : ''})`,
                    url: '/manager/my-team'
                });
            } catch (e) { console.error('Push notify error:', e.message); }
        }

        // Notify HR
        if (hrId && hrId !== reporting_manager_id && hrId !== managerId) {
            const applicant = await query(
                "SELECT first_name || ' ' || last_name as name FROM employees WHERE id = $1",
                [req.user.id]
            ).catch(() => ({ rows: [] }));
            const name = (applicant.rows[0] && applicant.rows[0].name) || req.user.employee_id;
            try {
                await sendToUser(hrId, {
                    title: 'New WFH Request',
                    body: `${name} requested work from home (${totalDays} day${totalDays > 1 ? 's' : ''})`,
                    url: '/manager/my-team'
                });
            } catch (e) { console.error('Push notify error:', e.message); }
        }

        res.status(201).json({ success: true, wfh: result.rows[0] });
    } catch (error) {
        console.error('WFH apply error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   POST /api/wfh/:id/cancel
// @desc    Employee cancels their own WFH request (pending, or approved before it starts)
// @access  Private
router.post('/:id/cancel', verifyToken, async (req, res) => {
    try {
        await query('BEGIN');
        const sel = await query(
            'SELECT id, status, start_date, end_date, employee_id FROM wfh_requests WHERE id = $1 AND employee_id = $2 FOR UPDATE',
            [req.params.id, req.user.id]
        );
        if (sel.rows.length === 0) {
            await query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'WFH request not found' });
        }
        const app = sel.rows[0];
        const today = istDateString();
        const isApproved = app.status === 'approved';
        if (app.status !== 'pending' && !(isApproved && String(app.start_date).substring(0,10) > today)) {
            await query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'This request can no longer be cancelled' });
        }
        await query(`UPDATE wfh_requests SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, [req.params.id]);
        if (isApproved) {
            await query(
                `DELETE FROM attendance WHERE employee_id = $1 AND date BETWEEN $2 AND $3 AND remarks LIKE 'Work from home: ' || $4 || '%'`,
                [app.employee_id, app.start_date, app.end_date, String(app.id)]
            );
        }
        await query('COMMIT');
        res.json({ success: true, message: 'WFH request cancelled' });
    } catch (error) {
        try { await query('ROLLBACK'); } catch(e) {}
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.get('/my', verifyToken, async (req, res) => {
    try {
        const result = await query(
            `SELECT wr.*,
            e.first_name || ' ' || e.last_name as approved_by_name
            FROM wfh_requests wr
            LEFT JOIN employees e ON wr.approved_by = e.id
            WHERE wr.employee_id = $1
            ORDER BY wr.created_at DESC`,
            [req.user.id]
        );
        res.json({ success: true, wfhRequests: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.get('/all', verifyToken, isAdmin, async (req, res) => {
    try {
        const { status } = req.query;
        let sqlQuery = `SELECT wr.*,
            e.first_name || ' ' || e.last_name as employee_name,
            e.employee_id as emp_id, d.name as department_name,
            ap.first_name || ' ' || ap.last_name as approved_by_name
            FROM wfh_requests wr
            JOIN employees e ON wr.employee_id = e.id
            LEFT JOIN departments d ON e.department_id = d.id
            LEFT JOIN employees ap ON wr.approved_by = ap.id
            WHERE 1=1`;
        const params = [];
        let idx = 1;

        if (status && status !== 'all') {
            sqlQuery += ` AND wr.status = $${idx}`;
            params.push(status);
            idx++;
        }

        sqlQuery += ' ORDER BY wr.created_at DESC';
        const result = await query(sqlQuery, params);

        const counts = await query(
            `SELECT status, COUNT(*) as count FROM wfh_requests GROUP BY status`
        );
        const statusCounts = { pending: 0, approved: 0, rejected: 0 };
        counts.rows.forEach(r => { statusCounts[r.status] = r.count; });

        res.json({ success: true, wfhRequests: result.rows, counts: statusCounts });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.get('/pending', verifyToken, isAdmin, async (req, res) => {
    try {
        const result = await query(
            `SELECT wr.*,
            e.first_name || ' ' || e.last_name as employee_name,
            e.employee_id as emp_id
            FROM wfh_requests wr
            JOIN employees e ON wr.employee_id = e.id
            WHERE wr.status = 'pending'
            ORDER BY wr.created_at DESC`
        );
        res.json({ success: true, wfhRequests: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.put('/approve/:id', verifyToken, isAdmin, async (req, res) => {
    try {
        const { status, remarks } = req.body;
        if (!['approved', 'rejected'].includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status' });
        }

        const wfhApp = await query(
            'SELECT * FROM wfh_requests WHERE id = $1', [req.params.id]
        );
        if (wfhApp.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'WFH request not found' });
        }
        if (wfhApp.rows[0].status !== 'pending') {
            return res.status(400).json({ success: false, message: `This request has already been ${wfhApp.rows[0].status}. You can only review pending requests.` });
        }

        const result = await query(
            `UPDATE wfh_requests
            SET status = $1, approved_by = $2, approval_remarks = $3, updated_at = NOW()
            WHERE id = $4 RETURNING *`,
            [status, req.user.id, remarks, req.params.id]
        );

        if (status === 'approved') {
            const app = wfhApp.rows[0];
            const wcfg = await getWorkWeekConfig();
            const holidayRows = await query(
                `SELECT to_char(date, 'YYYY-MM-DD') as d FROM holidays WHERE date BETWEEN $1 AND $2`,
                [app.start_date, app.end_date]
            );
            const holidays = new Set((holidayRows.rows || []).map(r => r.d));

            for (let d = new Date(app.start_date); d <= new Date(app.end_date); d.setDate(d.getDate() + 1)) {
                if (d.getDay() === wcfg.weekoffDay) continue;
                const dateStr = istDateString(d);
                if (holidays.has(dateStr)) continue;
                const existing = await query(
                    'SELECT id FROM attendance WHERE employee_id = $1 AND date = $2',
                    [app.employee_id, dateStr]
                );
                if (existing.rows.length === 0) {
                    await query(
                        `INSERT INTO attendance (employee_id, date, status, remarks) 
                        VALUES ($1, $2, 'wfh', $3)`,
                        [app.employee_id, dateStr, 'Work from home: ' + app.id + ' ' + (remarks || '')]
                    );
                }
            }
        } else if (status === 'rejected') {
            const app = wfhApp.rows[0];
            await query(
                `DELETE FROM attendance 
                WHERE employee_id = $1 AND date BETWEEN $2 AND $3 AND remarks LIKE 'Work from home: ' || $4 || '%'`,
                [app.employee_id, app.start_date, app.end_date, String(app.id)]
            );
        }

        res.json({ success: true, wfh: result.rows[0] });

        try {
            await sendToUser(wfhApp.rows[0].employee_id, {
                title: status === 'approved' ? 'WFH Approved' : 'WFH Rejected',
                body: `Your work-from-home request was ${status}`,
                url: '/employee/wfh'
            });
        } catch (e) { console.error('Push notify error:', e.message); }
    } catch (error) {
        console.error('WFH approve error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;
