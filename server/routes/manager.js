const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken, isManager } = require('../middleware/auth');
const { istDateString } = require('../utils/date');
const { sendToUser } = require('../services/push');
const { getWorkWeekConfig } = require('../utils/workWeek');
const { runWithSchemaRepair } = require('../utils/schemaRepair');
const { logAudit } = require('../utils/audit');

// @route   GET /api/manager/team
// @desc    Get current user's direct reports (TL) or all employees (HR/Manager)
// @access  Private (Manager+)
router.get('/team', verifyToken, isManager, async (req, res) => {
    try {
        let result;
        const userRole = req.user.role;
        
        if (userRole === 'hr' || userRole === 'manager') {
            // HR/Manager: ALL active employees (except admin)
            result = await query(
                `SELECT e.id, e.employee_id, e.first_name, e.last_name, e.email, e.role, e.status,
                d.name as department_name, des.name as designation_name
                FROM employees e
                LEFT JOIN departments d ON e.department_id = d.id
                LEFT JOIN designations des ON e.designation_id = des.id
                WHERE e.status = 'active' AND e.role != 'admin'
                ORDER BY e.first_name`
            );
        } else {
            // Team Lead: direct reports only (admin: also everyone auto-assigned
            // to them as secondary reporting manager)
            result = await runWithSchemaRepair(() => query(
                `SELECT e.id, e.employee_id, e.first_name, e.last_name, e.email, e.role, e.status,
                d.name as department_name, des.name as designation_name
                FROM employees e
                LEFT JOIN departments d ON e.department_id = d.id
                LEFT JOIN designations des ON e.designation_id = des.id
                WHERE (e.reporting_manager_id = $1 OR e.secondary_reporting_manager_id = $1) AND e.status = 'active'
                ORDER BY e.first_name`,
                [req.user.id]
            ));
        }
        res.json({ success: true, team: result.rows });
    } catch (error) {
        console.error('Get team error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/manager/today
// @desc    Today's live status board for the team (present / WFH / leave / not checked in)
// @access  Private (Manager+)
router.get('/today', verifyToken, isManager, async (req, res) => {
    try {
        const today = istDateString();
        const userRole = req.user.role;

        let rows;
        if (userRole === 'hr' || userRole === 'manager') {
            // HR/Manager: ALL active employees (except admin)
            rows = await query(
                `SELECT e.id, e.employee_id, e.first_name, e.last_name, des.name as designation_name,
                    a.check_in::text AS check_in,
                    a.check_out::text AS check_out,
                    EXISTS (
                        SELECT 1 FROM leave_applications la
                        WHERE la.employee_id = e.id AND la.status = 'approved'
                          AND la.start_date <= $1::date AND la.end_date >= $1::date
                    ) AS on_leave,
                    EXISTS (
                        SELECT 1 FROM wfh_requests w
                        WHERE w.employee_id = e.id AND w.status = 'approved'
                          AND w.start_date <= $1::date AND w.end_date >= $1::date
                    ) AS on_wfh
                FROM employees e
                LEFT JOIN attendance a ON a.employee_id = e.id AND a.date = $1::date
                LEFT JOIN designations des ON e.designation_id = des.id
                WHERE e.status = 'active' AND e.role != 'admin'
                ORDER BY des.name NULLS LAST, e.first_name`,
                [today]
            );
        } else {
            // Team Lead: direct reports only (admin: also everyone auto-assigned
            // to them as secondary reporting manager)
            rows = await runWithSchemaRepair(() => query(
                `SELECT e.id, e.employee_id, e.first_name, e.last_name, des.name as designation_name,
                    a.check_in::text AS check_in,
                    a.check_out::text AS check_out,
                    EXISTS (
                        SELECT 1 FROM leave_applications la
                        WHERE la.employee_id = e.id AND la.status = 'approved'
                          AND la.start_date <= $2::date AND la.end_date >= $2::date
                    ) AS on_leave,
                    EXISTS (
                        SELECT 1 FROM wfh_requests w
                        WHERE w.employee_id = e.id AND w.status = 'approved'
                          AND w.start_date <= $2::date AND w.end_date >= $2::date
                    ) AS on_wfh
                FROM employees e
                LEFT JOIN attendance a ON a.employee_id = e.id AND a.date = $2::date
                LEFT JOIN designations des ON e.designation_id = des.id
                WHERE (e.reporting_manager_id = $1 OR e.secondary_reporting_manager_id = $1) AND e.status = 'active'
                ORDER BY des.name NULLS LAST, e.first_name`,
                [req.user.id, today]
            ));
        }

        const members = rows.rows.map(r => {
            let status;
            if (r.on_leave) status = 'leave';
            else if (r.check_in) status = r.on_wfh ? 'wfh' : 'present';
            else if (r.on_wfh) status = 'wfh';
            else status = 'not_checked_in';
            return {
                id: r.id,
                employee_id: r.employee_id,
                first_name: r.first_name,
                last_name: r.last_name,
                designation_name: r.designation_name || null,
                check_in: r.check_in ? String(r.check_in).slice(0, 5) : null,
                check_out: r.check_out ? String(r.check_out).slice(0, 5) : null,
                status
            };
        });

        res.json({ success: true, date: today, members });
    } catch (error) {
        console.error('Manager today error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/manager/leaves
// @desc    Pending leave requests (multi-approver: TL + Manager + HR)
// @access  Private (Manager+)
router.get('/leaves', verifyToken, isManager, async (req, res) => {
    try {
        const result = await runWithSchemaRepair(() => query(
            `SELECT la.*, lt.name as leave_type_name,
            e.first_name || ' ' || e.last_name as employee_name, e.employee_id as emp_id,
            d.name as department_name
            FROM leave_applications la
            LEFT JOIN leave_types lt ON la.leave_type_id = lt.id
            JOIN employees e ON la.employee_id = e.id
            LEFT JOIN departments d ON e.department_id = d.id
            WHERE la.status = 'pending' AND (la.reporting_manager_id = $1 OR la.manager_id = $1 OR la.hr_id = $1
                OR la.employee_id IN (SELECT id FROM employees WHERE secondary_reporting_manager_id = $1))
            ORDER BY la.created_at DESC`,
            [req.user.id]
        ));
        res.json({ success: true, leaves: result.rows });
    } catch (error) {
        console.error('Manager leaves error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/manager/wfh
// @desc    Pending WFH requests (multi-approver: TL + Manager + HR)
// @access  Private (Manager+)
router.get('/wfh', verifyToken, isManager, async (req, res) => {
    try {
        const result = await runWithSchemaRepair(() => query(
            `SELECT wr.*,
            e.first_name || ' ' || e.last_name as employee_name, e.employee_id as emp_id,
            d.name as department_name
            FROM wfh_requests wr
            JOIN employees e ON wr.employee_id = e.id
            LEFT JOIN departments d ON e.department_id = d.id
            WHERE wr.status = 'pending' AND (wr.reporting_manager_id = $1 OR wr.manager_id = $1 OR wr.hr_id = $1
                OR wr.employee_id IN (SELECT id FROM employees WHERE secondary_reporting_manager_id = $1))
            ORDER BY wr.created_at DESC`,
            [req.user.id]
        ));
        res.json({ success: true, wfhRequests: result.rows });
    } catch (error) {
        console.error('Manager WFH error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/manager/tickets
// @desc    Open/in-progress queries (multi-approver: TL + Manager + HR)
// @access  Private (Manager+)
router.get('/tickets', verifyToken, isManager, async (req, res) => {
    try {
        const result = await query(
            `SELECT st.*,
            e.first_name || ' ' || e.last_name as employee_name, e.employee_id as emp_id
            FROM support_tickets st
            JOIN employees e ON st.employee_id = e.id
            WHERE st.status IN ('open', 'in_progress') AND (st.reporting_manager_id = $1 OR st.manager_id = $1 OR st.hr_id = $1
                OR st.employee_id IN (SELECT id FROM employees WHERE secondary_reporting_manager_id = $1))
            ORDER BY st.created_at DESC`,
            [req.user.id]
        );
        res.json({ success: true, tickets: result.rows });
    } catch (error) {
        console.error('Manager tickets error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   PUT /api/manager/leaves/:id
// @desc    Approve or reject a leave request (multi-approver: TL + Manager + HR)
// @access  Private (Manager+)
router.put('/leaves/:id', verifyToken, isManager, async (req, res) => {
    try {
        const { status, remarks } = req.body;
        if (!['approved', 'rejected'].includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status' });
        }

        const appRes = await runWithSchemaRepair(() => query(
            `SELECT * FROM leave_applications WHERE id = $1 AND (reporting_manager_id = $2 OR manager_id = $2 OR hr_id = $2
                OR employee_id IN (SELECT id FROM employees WHERE secondary_reporting_manager_id = $2)) AND status = 'pending'`,
            [req.params.id, req.user.id]
        ));
        if (appRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Leave request not found or already decided' });
        }
        const leaveApp = appRes.rows[0];

        const result = await query(
            `UPDATE leave_applications 
            SET status = $1, approved_by = $2, approval_remarks = $3, updated_at = NOW() 
            WHERE id = $4 AND status = 'pending' RETURNING *`,
            [status, req.user.id, remarks, req.params.id]
        );
        // TOCTOU guard: another approver may have decided between our read above
        // and this write. Only the winner proceeds (no double approval).
        if (result.rows.length === 0) {
            return res.status(409).json({ success: false, message: 'This request was already decided' });
        }

        if (status === 'approved') {
            const start = new Date(leaveApp.start_date);
            const end = new Date(leaveApp.end_date);
            const wcfg = await getWorkWeekConfig();

            const holidayRows = await query(
                `SELECT to_char(date, 'YYYY-MM-DD') as d FROM holidays WHERE date BETWEEN $1 AND $2`,
                [leaveApp.start_date, leaveApp.end_date]
            );
            const holidays = new Set((holidayRows.rows || []).map(r => r.d));

            for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
                const dow = d.getDay();
                if (dow === wcfg.weekoffDay) continue;
                const dateStr = istDateString(d);
                if (holidays.has(dateStr)) continue;
                const existing = await query(
                    'SELECT id FROM attendance WHERE employee_id = $1 AND date = $2',
                    [leaveApp.employee_id, dateStr]
                );
                if (existing.rows.length === 0) {
                    await query(
                        `INSERT INTO attendance (employee_id, date, status, remarks) 
                        VALUES ($1, $2, 'absent', $3)`,
                        [leaveApp.employee_id, dateStr, 'On leave: ' + (remarks || leaveApp.reason || '')]
                    );
                }
            }
        }

        logAudit({
            actorId: req.user.id,
            action: status === 'approved' ? 'leave.approve' : 'leave.reject',
            entityType: 'leave_application',
            entityId: req.params.id,
            details: { employee_id: leaveApp.employee_id, remarks: remarks || null },
            ip: req.ip
        });
        res.json({ success: true, leave: result.rows[0] });

        const lt = await query('SELECT name FROM leave_types WHERE id = $1', [leaveApp.leave_type_id]).catch(() => ({ rows: [] }));
        const typeName = (lt.rows[0] && lt.rows[0].name) || 'Leave';
        try {
            await sendToUser(leaveApp.employee_id, {
                title: status === 'approved' ? 'Leave Approved' : 'Leave Rejected',
                body: `Your ${typeName} request was ${status}`,
                url: '/employee/leave'
            });
        } catch (e) { console.error('Push notify error:', e.message); }
    } catch (error) {
        console.error('Manager leave approve error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   PUT /api/manager/wfh/:id
// @desc    Approve or reject a WFH request (multi-approver: TL + Manager + HR)
// @access  Private (Manager+)
router.put('/wfh/:id', verifyToken, isManager, async (req, res) => {
    try {
        const { status, remarks } = req.body;
        if (!['approved', 'rejected'].includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status' });
        }

        const appRes = await runWithSchemaRepair(() => query(
            `SELECT * FROM wfh_requests WHERE id = $1 AND (reporting_manager_id = $2 OR manager_id = $2 OR hr_id = $2
                OR employee_id IN (SELECT id FROM employees WHERE secondary_reporting_manager_id = $2)) AND status = 'pending'`,
            [req.params.id, req.user.id]
        ));
        if (appRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'WFH request not found or already decided' });
        }

        const result = await query(
            `UPDATE wfh_requests 
            SET status = $1, approved_by = $2, approval_remarks = $3, updated_at = NOW() 
            WHERE id = $4 AND status = 'pending' RETURNING *`,
            [status, req.user.id, remarks, req.params.id]
        );
        // TOCTOU guard: another approver may have decided between read and write.
        if (result.rows.length === 0) {
            return res.status(409).json({ success: false, message: 'This request was already decided' });
        }

        logAudit({
            actorId: req.user.id,
            action: status === 'approved' ? 'wfh.approve' : 'wfh.reject',
            entityType: 'wfh_request',
            entityId: req.params.id,
            details: { employee_id: appRes.rows[0].employee_id, remarks: remarks || null },
            ip: req.ip
        });
        res.json({ success: true, wfh: result.rows[0] });

        const wfhApp = appRes.rows[0];
        try {
            await sendToUser(wfhApp.employee_id, {
                title: status === 'approved' ? 'WFH Approved' : 'WFH Rejected',
                body: `Your work-from-home request was ${status}`,
                url: '/employee/wfh'
            });
        } catch (e) { console.error('Push notify error:', e.message); }
    } catch (error) {
        console.error('Manager WFH approve error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/manager/leaves/history
// @desc    All leave requests (any status) — multi-approver
// @access  Private (Manager+)
router.get('/leaves/history', verifyToken, isManager, async (req, res) => {
    try {
        const userRole = req.user.role;
        let result;
        if (userRole === 'hr' || userRole === 'manager') {
            result = await query(
                `SELECT la.*, lt.name as leave_type_name,
                e.first_name || ' ' || e.last_name as employee_name, e.employee_id as emp_id,
                ab.first_name || ' ' || ab.last_name as approved_by_name
                FROM leave_applications la
                LEFT JOIN leave_types lt ON la.leave_type_id = lt.id
                JOIN employees e ON la.employee_id = e.id
                LEFT JOIN employees ab ON la.approved_by = ab.id
                ORDER BY la.created_at DESC LIMIT 100`
            );
        } else {
            result = await runWithSchemaRepair(() => query(
                `SELECT la.*, lt.name as leave_type_name,
                e.first_name || ' ' || e.last_name as employee_name, e.employee_id as emp_id,
                ab.first_name || ' ' || ab.last_name as approved_by_name
                FROM leave_applications la
                LEFT JOIN leave_types lt ON la.leave_type_id = lt.id
                JOIN employees e ON la.employee_id = e.id
                LEFT JOIN employees ab ON la.approved_by = ab.id
                WHERE la.reporting_manager_id = $1 OR la.manager_id = $1 OR la.hr_id = $1
                OR la.employee_id IN (SELECT id FROM employees WHERE secondary_reporting_manager_id = $1)
                ORDER BY la.created_at DESC LIMIT 100`,
                [req.user.id]
            ));
        }
        res.json({ success: true, leaves: result.rows });
    } catch (error) {
        console.error('Manager leaves history error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/manager/wfh/history
// @desc    All WFH requests (any status) — multi-approver
// @access  Private (Manager+)
router.get('/wfh/history', verifyToken, isManager, async (req, res) => {
    try {
        const userRole = req.user.role;
        let result;
        if (userRole === 'hr' || userRole === 'manager') {
            result = await query(
                `SELECT wr.*,
                e.first_name || ' ' || e.last_name as employee_name, e.employee_id as emp_id,
                ab.first_name || ' ' || ab.last_name as approved_by_name
                FROM wfh_requests wr
                JOIN employees e ON wr.employee_id = e.id
                LEFT JOIN employees ab ON wr.approved_by = ab.id
                ORDER BY wr.created_at DESC LIMIT 100`
            );
        } else {
            result = await runWithSchemaRepair(() => query(
                `SELECT wr.*,
                e.first_name || ' ' || e.last_name as employee_name, e.employee_id as emp_id,
                ab.first_name || ' ' || ab.last_name as approved_by_name
                FROM wfh_requests wr
                JOIN employees e ON wr.employee_id = e.id
                LEFT JOIN employees ab ON wr.approved_by = ab.id
                WHERE wr.reporting_manager_id = $1 OR wr.manager_id = $1 OR wr.hr_id = $1
                OR wr.employee_id IN (SELECT id FROM employees WHERE secondary_reporting_manager_id = $1)
                ORDER BY wr.created_at DESC LIMIT 100`,
                [req.user.id]
            ));
        }
        res.json({ success: true, wfhRequests: result.rows });
    } catch (error) {
        console.error('Manager WFH history error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/manager/regularizations/history
// @desc    All regularization requests (any status) from team subtree
// @access  Private (Manager+)
router.get('/regularizations/history', verifyToken, isManager, async (req, res) => {
    try {
        const isAdmin = req.user.role === 'admin' || req.user.role === 'hr' || req.user.role === 'manager';
        let rows;
        if (isAdmin) {
            rows = await query(
                `SELECT ar.*, e.first_name, e.last_name, e.employee_id,
                    rev.first_name as rev_first, rev.last_name as rev_last
                 FROM attendance_regularizations ar
                 JOIN employees e ON e.id = ar.employee_id
                 LEFT JOIN employees rev ON rev.id = ar.reviewed_by
                 ORDER BY ar.created_at DESC LIMIT 100`
            );
        } else {
            rows = await query(
                `WITH RECURSIVE subtree AS (
                    SELECT id FROM employees WHERE id = $1
                    UNION SELECT e.id FROM employees e JOIN subtree s ON e.reporting_manager_id = s.id
                 )
                 SELECT ar.*, e.first_name, e.last_name, e.employee_id,
                    rev.first_name as rev_first, rev.last_name as rev_last
                 FROM attendance_regularizations ar
                 JOIN employees e ON e.id = ar.employee_id
                 LEFT JOIN employees rev ON rev.id = ar.reviewed_by
                 WHERE ar.employee_id IN (SELECT id FROM subtree)
                 ORDER BY ar.created_at DESC LIMIT 100`,
                [req.user.id]
            );
        }
        res.json({ success: true, requests: rows.rows });
    } catch (error) {
        console.error('Manager reg history error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/manager/tickets/history
// @desc    All tickets (any status) — multi-approver
// @access  Private (Manager+)
router.get('/tickets/history', verifyToken, isManager, async (req, res) => {
    try {
        const userRole = req.user.role;
        let result;
        if (userRole === 'hr' || userRole === 'manager') {
            result = await query(
                `SELECT st.*,
                e.first_name || ' ' || e.last_name as employee_name, e.employee_id as emp_id,
                e2.first_name || ' ' || e2.last_name as responded_by_name
                FROM support_tickets st
                JOIN employees e ON st.employee_id = e.id
                LEFT JOIN employees e2 ON st.responded_by = e2.id
                ORDER BY st.created_at DESC LIMIT 100`
            );
        } else {
            result = await query(
                `SELECT st.*,
                e.first_name || ' ' || e.last_name as employee_name, e.employee_id as emp_id,
                e2.first_name || ' ' || e2.last_name as responded_by_name
                FROM support_tickets st
                JOIN employees e ON st.employee_id = e.id
                LEFT JOIN employees e2 ON st.responded_by = e2.id
                WHERE st.reporting_manager_id = $1 OR st.manager_id = $1 OR st.hr_id = $1
                    OR st.employee_id IN (SELECT id FROM employees WHERE secondary_reporting_manager_id = $1)
                ORDER BY st.created_at DESC LIMIT 100`,
                [req.user.id]
            );
        }
        res.json({ success: true, tickets: result.rows });
    } catch (error) {
        console.error('Manager tickets history error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/manager/attendance
// @desc    Team attendance for a month — TL: direct reports, HR/Manager: all employees
// @access  Private (Manager+)
router.get('/attendance', verifyToken, isManager, async (req, res) => {
    try {
        const month = parseInt(req.query.month, 10);
        const year = parseInt(req.query.year, 10);
        if (!month || !year) return res.status(400).json({ success: false, message: 'month and year required' });

        const lastDay = new Date(year, month, 0).getDate();
        const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

        const userRole = req.user.role;
        let teamRes;
        if (userRole === 'hr' || userRole === 'manager') {
            teamRes = await query(
                `SELECT e.id, e.employee_id, e.first_name, e.last_name, des.name as designation_name
                 FROM employees e
                 LEFT JOIN designations des ON e.designation_id = des.id
                 WHERE e.status = 'active' AND e.role != 'admin'
                 ORDER BY des.name NULLS LAST, e.first_name`
            );
        } else {
            teamRes = await query(
                `SELECT e.id, e.employee_id, e.first_name, e.last_name, des.name as designation_name
                 FROM employees e
                 LEFT JOIN designations des ON e.designation_id = des.id
                 WHERE e.reporting_manager_id = $1 AND e.status = 'active'
                 ORDER BY des.name NULLS LAST, e.first_name`,
                [req.user.id]
            );
        }
        const teamIds = teamRes.rows.map(r => r.id);
        if (teamIds.length === 0) return res.json({ success: true, team: [], attendance: [], holidays: [] });

        const attRes = await query(
            `SELECT employee_id, date::text as date, status, check_in::text as check_in, check_out::text as check_out
             FROM attendance WHERE employee_id = ANY($1) AND EXTRACT(MONTH FROM date) = $2 AND EXTRACT(YEAR FROM date) = $3 ORDER BY date`,
            [teamIds, month, year]
        );
        const holRes = await query(
            `SELECT name, date::text as date FROM holidays WHERE EXTRACT(MONTH FROM date) = $1 AND EXTRACT(YEAR FROM date) = $2`,
            [month, year]
        );
        const lvRes = await query(
            `SELECT la.employee_id, la.start_date::text as start_date, la.end_date::text as end_date, la.status
             FROM leave_applications la
             WHERE la.employee_id = ANY($1) AND la.status = 'approved'
               AND (EXTRACT(MONTH FROM la.start_date) = $2 AND EXTRACT(YEAR FROM la.start_date) = $3
                    OR EXTRACT(MONTH FROM la.end_date) = $2 AND EXTRACT(YEAR FROM la.end_date) = $3)
             ORDER BY la.start_date`,
            [teamIds, month, year]
        );
        res.json({ success: true, team: teamRes.rows, attendance: attRes.rows, holidays: holRes.rows, leaves: lvRes.rows });
    } catch (error) {
        console.error('Manager attendance error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   PUT /api/manager/tickets/:id
// @desc    Respond to / resolve a query (multi-approver: TL + Manager + HR)
// @access  Private (Manager+)
router.put('/tickets/:id', verifyToken, isManager, async (req, res) => {
    try {
        const { response, status } = req.body;
        if (!response && !status) {
            return res.status(400).json({ success: false, message: 'Response or status is required' });
        }

        const appRes = await query(
            `SELECT * FROM support_tickets WHERE id = $1 AND (reporting_manager_id = $2 OR manager_id = $2 OR hr_id = $2
                OR employee_id IN (SELECT id FROM employees WHERE secondary_reporting_manager_id = $2)) AND status IN ('open', 'in_progress')`,
            [req.params.id, req.user.id]
        );
        if (appRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Ticket not found or already closed' });
        }

        const newStatus = ['resolved', 'closed', 'in_progress'].includes(status) ? status : 'in_progress';
        const result = await query(
            `UPDATE support_tickets 
            SET admin_response = COALESCE($1, admin_response), status = $2, responded_by = $3, 
            responded_at = NOW(), updated_at = NOW() 
            WHERE id = $4 AND status IN ('open', 'in_progress') RETURNING *`,
            [response || null, newStatus, req.user.id, req.params.id]
        );
        // TOCTOU guard: another responder may have closed it between read/write.
        if (result.rows.length === 0) {
            return res.status(409).json({ success: false, message: 'Ticket was already resolved or closed' });
        }

        logAudit({
            actorId: req.user.id,
            action: 'ticket.respond',
            entityType: 'support_ticket',
            entityId: req.params.id,
            details: { status: newStatus, employee_id: appRes.rows[0].employee_id, response: response || null },
            ip: req.ip
        });
        res.json({ success: true, ticket: result.rows[0] });

        const ticket = appRes.rows[0];
        try {
            await sendToUser(ticket.employee_id, {
                title: 'Ticket Response',
                body: `Your query "${ticket.subject}" was ${newStatus}`,
                url: '/employee/tickets'
            });
        } catch (e) { console.error('Push notify error:', e.message); }
    } catch (error) {
        console.error('Manager ticket respond error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;
