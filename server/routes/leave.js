const express = require('express');
const router = express.Router();
const { query, getClient } = require('../config/database');
const { verifyToken, isAdmin } = require('../middleware/auth');
const { validateLeave } = require('../middleware/validation');
const { istDateString, istYear } = require('../utils/date');
const { sendToUser } = require('../services/push');
const { buildReportWorkbook, sendWorkbook } = require('../utils/excel');
const { logAudit } = require('../utils/audit');
const { getWorkWeekConfig } = require('../utils/workWeek');
const { runWithSchemaRepair } = require('../utils/schemaRepair');
const { resolveApproverRouting } = require('../utils/approvalRouting');

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

router.get('/types', verifyToken, async (req, res) => {
    try {
        const user = await query('SELECT gender FROM employees WHERE id = $1', [req.user.id]);
        const gender = user.rows[0]?.gender || 'all';

        const result = await query(
            `SELECT * FROM leave_types WHERE is_active = 1 AND (gender_eligibility = 'all' OR gender_eligibility = $1) ORDER BY name`,
            [gender]
        );
        res.json({ success: true, leaveTypes: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.post('/apply', verifyToken, validateLeave, async (req, res) => {
    try {
        const { leave_type_id, start_date, end_date, reason } = req.body;

        const wcfg = await getWorkWeekConfig();

        if (new Date(end_date) < new Date(start_date)) {
            return res.status(400).json({ success: false, message: 'End date must be after start date' });
        }

        if (isWeekend(start_date, wcfg.weekoffDay)) {
            return res.status(400).json({ success: false, message: 'Start date cannot be a week off' });
        }

        const today = istDateString();
        if (start_date < today) {
            return res.status(400).json({ success: false, message: 'Start date cannot be in the past' });
        }

        // Shared approver routing (same source of truth as WFH/tickets):
        // the employee's team lead, or the admin as their secondary when no
        // lead exists - every non-admin employee is auto-assigned to the admin.
        const routing = await resolveApproverRouting(req.user.id);
        if (!routing) {
            return res.status(404).json({ success: false, message: 'Employee not found' });
        }
        if (routing.needsManager && !routing.primaryApprover) {
            return res.status(400).json({ success: false, message: 'No reporting manager assigned. Contact your administrator.' });
        }
        const reporting_manager_id = routing.reporting_manager_id;
        const managerId = routing.manager_id;
        const hrId = routing.hr_id;

        const genderCheck = await query(
            `SELECT lt.gender_eligibility, e.gender FROM leave_types lt
            JOIN employees e ON e.id = $2 WHERE lt.id = $1`,
            [leave_type_id, req.user.id]
        );
        if (genderCheck.rows.length > 0) {
            const { gender_eligibility, gender } = genderCheck.rows[0];
            if (gender_eligibility !== 'all' && gender_eligibility !== gender) {
                return res.status(400).json({ success: false, message: `This leave type is only available for ${gender_eligibility} employees` });
            }
        }

        const holRows = await query(`SELECT to_char(date, 'YYYY-MM-DD') as d FROM holidays WHERE date BETWEEN $1 AND $2 AND is_active = 1`, [start_date, end_date]);
        const holidays = new Set((holRows.rows || []).map(r => r.d));
        const totalDays = calcBusinessDays(start_date, end_date, holidays, wcfg.weekoffDay);

        // Reject overlapping approved/pending leave or WFH requests.
        const overlapLeave = await query(
            `SELECT id FROM leave_applications
            WHERE employee_id = $1 AND status IN ('approved', 'pending')
            AND start_date <= $2 AND end_date >= $3 LIMIT 1`,
            [req.user.id, end_date, start_date]
        );
        if (overlapLeave.rows.length > 0) {
            return res.status(400).json({ success: false, message: 'You already have a leave request that overlaps with these dates' });
        }
        const overlapWfh = await query(
            `SELECT id FROM wfh_requests
            WHERE employee_id = $1 AND status IN ('approved', 'pending')
            AND start_date <= $2 AND end_date >= $3 LIMIT 1`,
            [req.user.id, end_date, start_date]
        );
        if (overlapWfh.rows.length > 0) {
            return res.status(400).json({ success: false, message: 'You already have a WFH request that overlaps with these dates' });
        }

        // Check leave balance: 1 paid day per calendar month per leave type (yearly quota = days_per_year).
        // Extra days in same month are LOP and not blocked.
        const ltRes = await query(
            'SELECT days_per_year FROM leave_types WHERE id = $1 AND is_active = 1',
            [leave_type_id]
        );
        if (ltRes.rows.length > 0 && ltRes.rows[0].days_per_year) {
            const year = new Date(start_date).getFullYear();
            const usedRes = await query(
                `SELECT COUNT(DISTINCT to_char(start_date, 'YYYY-MM')) as used_months FROM leave_applications
                WHERE employee_id = $1 AND leave_type_id = $2
                AND to_char(start_date, 'YYYY') = $3
                AND status = 'approved'`,
                [req.user.id, leave_type_id, String(year)]
            );
            const usedMonths = parseInt(usedRes.rows[0].used_months) || 0;
            const newMonthKey = start_date.substring(0, 7); // YYYY-MM
            const sameMonthRes = await query(
                `SELECT 1 FROM leave_applications
                WHERE employee_id = $1 AND leave_type_id = $2
                AND to_char(start_date, 'YYYY-MM') = $3
                AND to_char(start_date, 'YYYY') = $4
                AND status = 'approved' LIMIT 1`,
                [req.user.id, leave_type_id, newMonthKey, String(year)]
            );
            const alreadyUsedThisMonth = sameMonthRes.rows.length > 0;
            // Only block if this is a NEW paid month and quota exhausted (extra same-month leaves are LOP and allowed).
            if (!alreadyUsedThisMonth && usedMonths >= ltRes.rows[0].days_per_year) {
                const remaining = 0;
                return res.status(400).json({
                    success: false,
                    message: `Insufficient leave balance. You have ${remaining} day(s) left for this leave type this year.`
                });
            }
        }

        const result = await query(
            `INSERT INTO leave_applications (employee_id, leave_type_id, reporting_manager_id, manager_id, hr_id, start_date, end_date, total_days, reason) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [req.user.id, leave_type_id, reporting_manager_id, managerId, hrId, start_date, end_date, totalDays, reason]
        );

        if (reporting_manager_id) {
            const applicant = await query(
                "SELECT first_name || ' ' || last_name as name FROM employees WHERE id = $1",
                [req.user.id]
            ).catch(() => ({ rows: [] }));
            const name = (applicant.rows[0] && applicant.rows[0].name) || req.user.employee_id;
            try {
                await sendToUser(reporting_manager_id, {
                    title: 'New Leave Request',
                    body: `${name} applied for leave (${totalDays} day${totalDays > 1 ? 's' : ''})`,
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
                    title: 'New Leave Request',
                    body: `${name} applied for leave (${totalDays} day${totalDays > 1 ? 's' : ''})`,
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
                    title: 'New Leave Request',
                    body: `${name} applied for leave (${totalDays} day${totalDays > 1 ? 's' : ''})`,
                    url: '/manager/my-team'
                });
            } catch (e) { console.error('Push notify error:', e.message); }
        }

        res.status(201).json({ success: true, leave: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.get('/my', verifyToken, async (req, res) => {
    try {
        const result = await query(
            `SELECT la.*, lt.name as leave_type_name, 
            e.first_name || ' ' || e.last_name as approved_by_name
            FROM leave_applications la
            LEFT JOIN leave_types lt ON la.leave_type_id = lt.id
            LEFT JOIN employees e ON la.approved_by = e.id
            WHERE la.employee_id = $1
            ORDER BY la.created_at DESC`,
            [req.user.id]
        );
        res.json({ success: true, leaves: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.get('/all', verifyToken, isAdmin, async (req, res) => {
    try {
        const { status } = req.query;
        let sqlQuery = `SELECT la.*, lt.name as leave_type_name, 
            e.first_name || ' ' || e.last_name as employee_name,
            e.employee_id as emp_id, d.name as department_name,
            ap.first_name || ' ' || ap.last_name as approved_by_name
            FROM leave_applications la
            LEFT JOIN leave_types lt ON la.leave_type_id = lt.id
            JOIN employees e ON la.employee_id = e.id
            LEFT JOIN departments d ON e.department_id = d.id
            LEFT JOIN employees ap ON la.approved_by = ap.id
            WHERE 1=1`;
        const params = [];
        let idx = 1;

        if (status && status !== 'all') {
            sqlQuery += ` AND la.status = $${idx}`;
            params.push(status);
            idx++;
        }

        sqlQuery += ' ORDER BY la.created_at DESC';
        const result = await query(sqlQuery, params);

        const counts = await query(
            `SELECT status, COUNT(*) as count FROM leave_applications GROUP BY status`
        );
        const statusCounts = { pending: 0, approved: 0, rejected: 0 };
        counts.rows.forEach(r => { statusCounts[r.status] = r.count; });

        res.json({ success: true, leaves: result.rows, counts: statusCounts });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.get('/pending', verifyToken, isAdmin, async (req, res) => {
    try {
        const result = await query(
            `SELECT la.*, lt.name as leave_type_name, 
            e.first_name || ' ' || e.last_name as employee_name,
            e.employee_id as emp_id
            FROM leave_applications la
            LEFT JOIN leave_types lt ON la.leave_type_id = lt.id
            JOIN employees e ON la.employee_id = e.id
            WHERE la.status = 'pending'
            ORDER BY la.created_at DESC`
        );
        res.json({ success: true, leaves: result.rows });
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

        const wcfg = await getWorkWeekConfig();
        
        const leaveApp = await query(
            'SELECT * FROM leave_applications WHERE id = $1', [req.params.id]
        );
        if (leaveApp.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Leave application not found' });
        }
        if (leaveApp.rows[0].status !== 'pending') {
            return res.status(400).json({ success: false, message: `This request has already been ${leaveApp.rows[0].status}. You can only review pending requests.` });
        }
        
        const result = await query(
            `UPDATE leave_applications 
            SET status = $1, approved_by = $2, approval_remarks = $3, updated_at = NOW() 
            WHERE id = $4 RETURNING *`,
            [status, req.user.id, remarks, req.params.id]
        );
        logAudit({ actorId: req.user.id, action: status === 'approved' ? 'leave.approve' : 'leave.reject', entityType: 'leave_application', entityId: req.params.id, details: { employee_id: leaveApp.rows[0].employee_id, remarks: remarks || null }, ip: req.ip });
        
        if (status === 'approved') {
            const app = leaveApp.rows[0];
            const start = new Date(app.start_date);
            const end = new Date(app.end_date);

            // Fetch holidays once for the range so week off/holiday days are not
            // back-filled as absent (they are not counted in total_days either).
            const holidayRows = await query(
                `SELECT to_char(date, 'YYYY-MM-DD') as d FROM holidays WHERE date BETWEEN $1 AND $2`,
                [app.start_date, app.end_date]
            );
            const holidays = new Set((holidayRows.rows || []).map(r => r.d));

            for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
                const dow = d.getDay();
                if (dow === wcfg.weekoffDay) continue;
                const dateStr = istDateString(d);
                if (holidays.has(dateStr)) continue;
                const existing = await query(
                    'SELECT id FROM attendance WHERE employee_id = $1 AND date = $2',
                    [app.employee_id, dateStr]
                );
                if (existing.rows.length === 0) {
                    await query(
                        `INSERT INTO attendance (employee_id, date, status, remarks) 
                        VALUES ($1, $2, 'absent', $3)`,
                        [app.employee_id, dateStr, 'On leave: ' + app.id + ' ' + (remarks || app.reason || '')]
                    );
                }
            }
        } else if (status === 'rejected') {
            // Remove only this application's rows (ID-tagged) so overlapping leaves are untouched.
            const app = leaveApp.rows[0];
            await query(
                `DELETE FROM attendance 
                WHERE employee_id = $1 AND date BETWEEN $2 AND $3 AND remarks LIKE 'On leave: ' || $4 || '%'`,
                [app.employee_id, app.start_date, app.end_date, String(app.id)]
            );
        }
        
        res.json({ success: true, leave: result.rows[0] });

        const app = leaveApp.rows[0];
        const lt = await query('SELECT name FROM leave_types WHERE id = $1', [app.leave_type_id]).catch(() => ({ rows: [] }));
        const typeName = (lt.rows[0] && lt.rows[0].name) || 'Leave';
        try {
            await sendToUser(app.employee_id, {
                title: status === 'approved' ? 'Leave Approved' : 'Leave Rejected',
                body: `Your ${typeName} request was ${status}`,
                url: '/employee/leave'
            });
        } catch (e) { console.error('Push notify error:', e.message); }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   POST /api/leave/:id/cancel
// @desc    Employee cancels their own leave request (pending, or approved before it starts)
// @access  Private
router.post('/:id/cancel', verifyToken, async (req, res) => {
    // Run the (read-approve-update) sequence on ONE checked-out connection so the
    // tx is real. Previously BEGIN/COMMIT went through the pool helper, which can
    // pick a different connection per statement and silently break atomicity.
    const client = await getClient();
    try {
        await client.query('BEGIN');
        const sel = await client.query(
            'SELECT id, status, start_date, end_date, employee_id FROM leave_applications WHERE id = $1 AND employee_id = $2 FOR UPDATE',
            [req.params.id, req.user.id]
        );
        if (sel.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Leave request not found' });
        }
        const app = sel.rows[0];
        const today = istDateString();
        const isApproved = app.status === 'approved';
        if (app.status !== 'pending' && !(isApproved && String(app.start_date).substring(0,10) > today)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'This request can no longer be cancelled' });
        }
        await client.query(`UPDATE leave_applications SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, [req.params.id]);
        if (isApproved) {
            await client.query(
                `DELETE FROM attendance WHERE employee_id = $1 AND date BETWEEN $2 AND $3 AND remarks LIKE 'On leave: ' || $4 || '%'`,
                [app.employee_id, app.start_date, app.end_date, String(app.id)]
            );
        }
        await client.query('COMMIT');
        logAudit({ actorId: req.user.id, action: 'leave.cancel', entityType: 'leave_application', entityId: req.params.id, details: { status: app.status, was_approved: isApproved }, ip: req.ip });
        res.json({ success: true, message: 'Leave request cancelled' });
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch(e) {}
        res.status(500).json({ success: false, message: 'Server error' });
    } finally {
        try { client.release(); } catch(e) {}
    }
});

router.get('/balance', verifyToken, async (req, res) => {
    try {
        const currentYear = istYear();
        
        const user = await query('SELECT gender FROM employees WHERE id = $1', [req.user.id]);
        const gender = user.rows[0]?.gender || 'all';
        
        const result = await query(
            `SELECT lt.id, lt.name, lt.days_per_year, lt.gender_eligibility,
            COALESCE(COUNT(DISTINCT CASE WHEN la.status = 'approved' THEN to_char(la.start_date, 'YYYY-MM') END), 0) as used_days,
            COALESCE(SUM(CASE WHEN la.status = 'pending' THEN la.total_days ELSE 0 END), 0) as pending_days
            FROM leave_types lt
            LEFT JOIN leave_applications la ON lt.id = la.leave_type_id 
            AND la.employee_id = $1 
            AND to_char(la.start_date, 'YYYY') = $2
            AND la.status IN ('approved', 'pending')
            WHERE lt.is_active = 1 AND (lt.gender_eligibility = 'all' OR lt.gender_eligibility = $3)
            GROUP BY lt.id, lt.name, lt.days_per_year, lt.gender_eligibility
            ORDER BY lt.name`,
            [req.user.id, String(currentYear), gender]
        );
        
        const balances = result.rows.map(row => ({
            ...row,
            remaining_days: Math.max(0, row.days_per_year - row.used_days),
            percentage: row.days_per_year > 0 ? Math.round((row.used_days / row.days_per_year) * 100) : 0
        }));
        
        res.json({ success: true, balances });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/leave/export
// @desc    Branded Excel leave register for a year (optional status filter)
// @access  Private (Admin)
router.get('/export', verifyToken, isAdmin, async (req, res) => {
    try {
        const year = parseInt(req.query.year) || istYear();
        const status = req.query.status && req.query.status !== 'all' ? String(req.query.status) : null;

        let sql = `SELECT la.*, lt.name AS leave_type_name,
                e.first_name || ' ' || e.last_name AS employee_name, e.employee_id AS emp_code,
                d.name AS department_name,
                ap.first_name || ' ' || ap.last_name AS approved_by_name
            FROM leave_applications la
            LEFT JOIN leave_types lt ON la.leave_type_id = lt.id
            JOIN employees e ON la.employee_id = e.id
            LEFT JOIN departments d ON e.department_id = d.id
            LEFT JOIN employees ap ON la.approved_by = ap.id
            WHERE to_char(la.start_date, 'YYYY') = $1`;
        const params = [String(year)];
        if (status) {
            sql += ` AND la.status = $2`;
            params.push(status);
        }
        sql += ` ORDER BY la.start_date ASC, e.employee_id ASC`;

        const result = await query(sql, params);

        const rows = result.rows.map(l => ({
            emp_code: l.emp_code,
            name: l.employee_name,
            department: l.department_name,
            type: l.leave_type_name || 'Leave',
            start_date: l.start_date,
            end_date: l.end_date,
            total_days: Number(l.total_days) || 0,
            reason: l.reason,
            status: l.status,
            approved_by: l.approved_by_name,
            approval_remarks: l.approval_remarks,
            applied_on: l.created_at
        }));

        const columns = [
            { header: 'Emp ID', key: 'emp_code', width: 12 },
            { header: 'Employee Name', key: 'name', width: 22 },
            { header: 'Department', key: 'department' },
            { header: 'Leave Type', key: 'type', width: 16 },
            { header: 'From', key: 'start_date', type: 'date', width: 13 },
            { header: 'To', key: 'end_date', type: 'date', width: 13 },
            { header: 'Days', key: 'total_days', type: 'number', width: 9 },
            { header: 'Reason', key: 'reason', width: 32 },
            { header: 'Status', key: 'status', type: 'status' },
            { header: 'Approved By', key: 'approved_by', width: 18 },
            { header: 'Remarks', key: 'approval_remarks', width: 28 },
            { header: 'Applied On', key: 'applied_on', type: 'datetime', width: 17 }
        ];

        const wb = await buildReportWorkbook({
            reportName: 'Leave Register',
            subtitleExtra: `Year ${year}${status ? ' • Status: ' + status : ' • All statuses'}`,
            columns,
            rows,
            footerNote: req.user.name || 'Admin'
        });

        logAudit({
            actorId: req.user.id,
            action: 'data.export',
            entityType: 'report',
            entityId: null,
            details: { report: 'leave_register', year, status: status || 'all', records: rows.length },
            ip: req.ip
        });

        await sendWorkbook(res, wb, `Leave_Register_${year}.xlsx`);
    } catch (error) {
        console.error('Leave export error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;
