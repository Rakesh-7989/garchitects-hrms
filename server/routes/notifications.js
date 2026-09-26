const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken, isManager } = require('../middleware/auth');
const { runWithSchemaRepair } = require('../utils/schemaRepair');

// @route   GET /api/notifications/counts
// @desc    Get pending-action counts for the notification bell
// @access  Private (Admin/HR sees all, Manager/Team Lead sees own team)
router.get('/counts', verifyToken, isManager, async (req, res) => {
    try {
        const isAdminRole = req.user.role === 'admin';
        // Admin sees everything. A manager/team-lead sees requests routed
        // directly to them OR raised by employees for whom they are the
        // secondary reporting manager (every non-admin employee auto-reports
        // to the admin, so the admin's scope always covers all employees).
        const scopeClause = isAdminRole ? '' : ` AND (reporting_manager_id = $1 OR employee_id IN (SELECT id FROM employees WHERE secondary_reporting_manager_id = $1))`;
        const scopeParams = isAdminRole ? [] : [req.user.id];

        // A count failing must not break the whole bell - fall back to 0 for
        // that source only. Regularization counts also self-heal their table.
        const safe = (p) => p.catch((err) => {
            console.error('Notification count failed:', err.message);
            return { rows: [{ count: '0' }] };
        });
        const q = (sql, params) => safe(runWithSchemaRepair(() => query(sql, params)));

        const [pendingLeaves, pendingWfh, pendingTickets, announcementsUnread, pendingProfileUpdates, pendingRegularizations, openWorkAssignments] = await Promise.all([
            safe(query("SELECT COUNT(*) as count FROM leave_applications WHERE status = 'pending'" + scopeClause, scopeParams)),
            safe(query("SELECT COUNT(*) as count FROM wfh_requests WHERE status = 'pending'" + scopeClause, scopeParams)),
            safe(query("SELECT COUNT(*) as count FROM support_tickets WHERE status IN ('open', 'in_progress')" + scopeClause, scopeParams)),
            safe(runWithSchemaRepair(() => query(
                `SELECT COUNT(*) as count FROM announcements a
                WHERE a.is_active = 1
                AND a.id NOT IN (SELECT announcement_id FROM announcement_reads WHERE employee_id = $1)`,
                [req.user.id]
            ))),
            isAdminRole
                ? safe(query("SELECT COUNT(*) as count FROM profile_update_requests WHERE status = 'pending'"))
                : Promise.resolve({ rows: [{ count: '0' }] }),
            isAdminRole
                ? q("SELECT COUNT(*) as count FROM attendance_regularizations WHERE status = 'pending'")
                : q(
                    `SELECT COUNT(*) as count FROM attendance_regularizations r
                    JOIN employees e ON e.id = r.employee_id
                    WHERE r.status = 'pending' AND (e.reporting_manager_id = $1 OR e.secondary_reporting_manager_id = $1)`,
                    [req.user.id]
                ),
            // Work assignments still open in the caller's scope (D3): admin/HR see
            // all, manager/team-lead see the ones THEY created (same scope as GET /).
            (req.user.role === 'admin' || req.user.role === 'hr')
                ? safe(query("SELECT COUNT(*) as count FROM work_assignments WHERE status IN ('assigned','in_progress')"))
                : safe(query("SELECT COUNT(*) as count FROM work_assignments WHERE status IN ('assigned','in_progress') AND assigned_by = $1", [req.user.id]))
        ]);

        const counts = {
            pendingLeaves: parseInt(pendingLeaves.rows[0].count),
            pendingWfh: parseInt(pendingWfh.rows[0].count),
            pendingProfileUpdates: parseInt(pendingProfileUpdates.rows[0].count),
            announcementsUnread: parseInt(announcementsUnread.rows[0].count),
            pendingTickets: parseInt(pendingTickets.rows[0].count),
            pendingRegularizations: parseInt(pendingRegularizations.rows[0].count),
            openWorkAssignments: parseInt(openWorkAssignments.rows[0].count)
        };
        counts.total = counts.pendingLeaves + counts.pendingWfh + counts.pendingProfileUpdates + counts.announcementsUnread + counts.pendingTickets + counts.pendingRegularizations + counts.openWorkAssignments;

        res.json({ success: true, counts });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/notifications/requests
// @desc    Latest pending employee requests (leave / WFH / queries) for the notification bell
// @access  Private (Admin/HR sees all, Manager/Team Lead sees own team)
router.get('/requests', verifyToken, isManager, async (req, res) => {
    try {
        const isAdminRole = req.user.role === 'admin';

        let leaveUrl, wfhUrl, ticketUrl;
        let leavesQuery, wfhQuery, ticketsQuery, profilesQuery = null, regsQuery = null;

        const REG_SELECT = `SELECT r.id, r.status, r.date, r.check_in, r.check_out, r.created_at,
                e.first_name || ' ' || e.last_name as employee_name, e.employee_id as emp_id
                FROM attendance_regularizations r
                JOIN employees e ON e.id = r.employee_id
                WHERE r.status = 'pending'`;
        const regUrl = '/manager/my-team?tab=regularization';

        if (isAdminRole) {
            leaveUrl = '/admin/leave?status=pending';
            wfhUrl = '/admin/wfh?status=pending';
            ticketUrl = '/admin/tickets?status=open';
            leavesQuery = {
                text: `SELECT la.id, la.status, la.start_date, la.end_date, la.total_days, la.created_at,
                lt.name as leave_type_name,
                e.first_name || ' ' || e.last_name as employee_name, e.employee_id as emp_id
                FROM leave_applications la
                LEFT JOIN leave_types lt ON la.leave_type_id = lt.id
                JOIN employees e ON la.employee_id = e.id
                WHERE la.status = 'pending'
                ORDER BY la.created_at DESC LIMIT 8`,
                values: []
            };
            wfhQuery = {
                text: `SELECT wr.id, wr.status, wr.start_date, wr.end_date, wr.total_days, wr.created_at,
                e.first_name || ' ' || e.last_name as employee_name, e.employee_id as emp_id
                FROM wfh_requests wr
                JOIN employees e ON wr.employee_id = e.id
                WHERE wr.status = 'pending'
                ORDER BY wr.created_at DESC LIMIT 8`,
                values: []
            };
            ticketsQuery = {
                text: `SELECT st.id, st.status, st.priority, st.subject, st.created_at,
                e.first_name || ' ' || e.last_name as employee_name, e.employee_id as emp_id
                FROM support_tickets st
                JOIN employees e ON st.employee_id = e.id
                WHERE st.status IN ('open', 'in_progress')
                ORDER BY st.created_at DESC LIMIT 8`,
                values: []
            };
            profilesQuery = {
                text: `SELECT r.id, r.status, r.field, r.created_at,
                e.first_name || ' ' || e.last_name as employee_name, e.employee_id as emp_id
                FROM profile_update_requests r
                JOIN employees e ON r.employee_id = e.id
                WHERE r.status = 'pending'
                ORDER BY r.created_at DESC LIMIT 8`,
                values: []
            };
            regsQuery = {
                text: REG_SELECT + ' ORDER BY r.created_at DESC LIMIT 8',
                values: []
            };
        } else {
            leaveUrl = '/manager/my-team';
            wfhUrl = '/manager/my-team';
            ticketUrl = '/manager/my-team';
            regsQuery = {
                text: REG_SELECT + ' AND (e.reporting_manager_id = $1 OR e.secondary_reporting_manager_id = $1) ORDER BY r.created_at DESC LIMIT 8',
                values: [req.user.id]
            };
            leavesQuery = {
                text: `SELECT la.id, la.status, la.start_date, la.end_date, la.total_days, la.created_at,
                lt.name as leave_type_name,
                e.first_name || ' ' || e.last_name as employee_name, e.employee_id as emp_id
                FROM leave_applications la
                LEFT JOIN leave_types lt ON la.leave_type_id = lt.id
                JOIN employees e ON la.employee_id = e.id
                WHERE la.status = 'pending' AND (la.reporting_manager_id = $1 OR la.employee_id IN (SELECT id FROM employees WHERE secondary_reporting_manager_id = $1))
                ORDER BY la.created_at DESC LIMIT 8`,
                values: [req.user.id]
            };
            wfhQuery = {
                text: `SELECT wr.id, wr.status, wr.start_date, wr.end_date, wr.total_days, wr.created_at,
                e.first_name || ' ' || e.last_name as employee_name, e.employee_id as emp_id
                FROM wfh_requests wr
                JOIN employees e ON wr.employee_id = e.id
                WHERE wr.status = 'pending' AND (wr.reporting_manager_id = $1 OR wr.employee_id IN (SELECT id FROM employees WHERE secondary_reporting_manager_id = $1))
                ORDER BY wr.created_at DESC LIMIT 8`,
                values: [req.user.id]
            };
            ticketsQuery = {
                text: `SELECT st.id, st.status, st.priority, st.subject, st.created_at,
                e.first_name || ' ' || e.last_name as employee_name, e.employee_id as emp_id
                FROM support_tickets st
                JOIN employees e ON st.employee_id = e.id
                WHERE st.status IN ('open', 'in_progress') AND (st.reporting_manager_id = $1 OR st.employee_id IN (SELECT id FROM employees WHERE secondary_reporting_manager_id = $1))
                ORDER BY st.created_at DESC LIMIT 8`,
                values: [req.user.id]
            };
        }

        const [leaves, wfh, tickets, profiles, regs] = await Promise.all([
            query(leavesQuery.text, leavesQuery.values),
            query(wfhQuery.text, wfhQuery.values),
            query(ticketsQuery.text, ticketsQuery.values),
            profilesQuery ? query(profilesQuery.text, profilesQuery.values) : Promise.resolve({ rows: [] }),
            // Regularizations live in a table that may predate the feature -
            // repair/retry and never let it break the bell.
            regsQuery ? safe(runWithSchemaRepair(() => query(regsQuery.text, regsQuery.values)))
                .catch(() => ({ rows: [] })) : Promise.resolve({ rows: [] })
        ]);

        const feed = [
            ...leaves.rows.map(r => ({
                type: 'leave',
                id: r.id,
                status: r.status,
                title: `${r.employee_name} applied ${r.leave_type_name}`,
                subtitle: `${r.emp_id} · ${r.start_date} to ${r.end_date} (${r.total_days} day${r.total_days > 1 ? 's' : ''})`,
                created_at: r.created_at,
                url: leaveUrl
            })),
            ...wfh.rows.map(r => ({
                type: 'wfh',
                id: r.id,
                status: r.status,
                title: `${r.employee_name} requested WFH`,
                subtitle: `${r.emp_id} · ${r.start_date} to ${r.end_date} (${r.total_days} day${r.total_days > 1 ? 's' : ''})`,
                created_at: r.created_at,
                url: wfhUrl
            })),
            ...tickets.rows.map(r => ({
                type: 'ticket',
                id: r.id,
                status: r.status,
                title: `${r.employee_name} raised a query`,
                subtitle: `${r.emp_id} · ${r.subject}`,
                created_at: r.created_at,
                url: ticketUrl
            })),
            ...profiles.rows.map(r => ({
                type: 'profile',
                id: r.id,
                status: r.status,
                title: `${r.employee_name} requested profile update`,
                subtitle: `${r.emp_id} · ${r.field}`,
                created_at: r.created_at,
                url: '/admin/employees'
            })),
            ...regs.rows.map(r => ({
                type: 'regularization',
                id: r.id,
                status: r.status,
                title: `${r.employee_name} requested attendance regularization`,
                subtitle: `${r.emp_id} · ${String(r.date).substring(0, 10)}${r.check_in ? ' · ' + r.check_in : ''}${r.check_out ? '-' + r.check_out : ''}`,
                created_at: r.created_at,
                url: regUrl
            }))
        ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 12);

        res.json({ success: true, feed });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;
