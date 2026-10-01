const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken, isManager } = require('../middleware/auth');
const { runWithSchemaRepair } = require('../utils/schemaRepair');
const { dateOnly } = require('../utils/date');

// A failing feed source must never break the whole bell feed.
const safe = (p) => p.catch((err) => {
    console.error('Notification query failed:', err.message);
    return { rows: [] };
});

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

        // Workflow-release bell sources (team transfers / project access /
        // handover covers). team_lead sees only items they must act on;
        // admin/manager/hr see everything. Tables lazy-heal like the rest.
        let transfersSql, transfersParams, accessSql, accessParams, handoversSql, handoversParams;
        if (req.user.role === 'team_lead') {
            transfersSql = `SELECT COUNT(*) as count FROM team_transfer_requests WHERE from_tl_id = $1 AND status = 'pending'`;
            transfersParams = [req.user.id];
            accessSql = `SELECT COUNT(*) as count FROM project_access_requests r WHERE r.status = 'pending' AND EXISTS (
                SELECT 1 FROM project_leads pl WHERE pl.project_id = r.project_id AND pl.lead_id = $1 AND pl.unit_id IS NULL)`;
            accessParams = [req.user.id];
            handoversSql = `SELECT COUNT(*) as count FROM team_handovers WHERE status = 'active' AND (cover_tl_id = $1 OR absent_tl_id = $1)`;
            handoversParams = [req.user.id];
        } else {
            transfersSql = `SELECT COUNT(*) as count FROM team_transfer_requests WHERE status = 'pending'`;
            transfersParams = [];
            accessSql = `SELECT COUNT(*) as count FROM project_access_requests WHERE status = 'pending'`;
            accessParams = [];
            handoversSql = `SELECT COUNT(*) as count FROM team_handovers WHERE status = 'active'`;
            handoversParams = [];
        }

        const [pendingLeaves, pendingWfh, pendingTickets, announcementsUnread, pendingProfileUpdates, pendingRegularizations, openWorkAssignments, openLeadProjects, pendingTransfers, pendingAccessRequests, activeHandovers] = await Promise.all([
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
                : safe(query("SELECT COUNT(*) as count FROM work_assignments WHERE status IN ('assigned','in_progress') AND assigned_by = $1", [req.user.id])),
            // Projects the caller leads (project-level or unit-level rows),
            // distinct per project — lights up the bell / nav badge on
            // "My Led Projects" the moment a lead is designated (P9).
            q("SELECT COUNT(DISTINCT project_id) as count FROM project_leads WHERE lead_id = $1", [req.user.id]),
            q(transfersSql, transfersParams),
            q(accessSql, accessParams),
            q(handoversSql, handoversParams)
        ]);

        const counts = {
            pendingLeaves: parseInt(pendingLeaves.rows[0].count),
            pendingWfh: parseInt(pendingWfh.rows[0].count),
            pendingProfileUpdates: parseInt(pendingProfileUpdates.rows[0].count),
            announcementsUnread: parseInt(announcementsUnread.rows[0].count),
            pendingTickets: parseInt(pendingTickets.rows[0].count),
            pendingRegularizations: parseInt(pendingRegularizations.rows[0].count),
            openWorkAssignments: parseInt(openWorkAssignments.rows[0].count),
            openLeadProjects: parseInt(openLeadProjects.rows[0].count),
            pendingTransfers: parseInt(pendingTransfers.rows[0].count),
            pendingAccessRequests: parseInt(pendingAccessRequests.rows[0].count),
            activeHandovers: parseInt(activeHandovers.rows[0].count)
        };
        counts.total = counts.pendingLeaves + counts.pendingWfh + counts.pendingProfileUpdates + counts.announcementsUnread + counts.pendingTickets + counts.pendingRegularizations + counts.openWorkAssignments + counts.openLeadProjects + counts.pendingTransfers + counts.pendingAccessRequests + counts.activeHandovers;

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

        // Workflow-release feed sources: pending team transfers, pending project
        // access requests, active handover covers. team_lead sees items they
        // must act on; admin/manager/hr see everything. New tables — repair/retry
        // so they can never break the bell.
        const isTl = req.user.role === 'team_lead';
        const transfersFeed = {
            text: `SELECT tr.id, tr.status, tr.created_at,
                e.employee_id AS emp_code, e.first_name || ' ' || e.last_name AS employee_name,
                ft.first_name || ' ' || ft.last_name AS from_tl_name,
                tt.first_name || ' ' || tt.last_name AS to_tl_name
                FROM team_transfer_requests tr
                JOIN employees e ON e.id = tr.employee_id
                JOIN employees ft ON ft.id = tr.from_tl_id
                JOIN employees tt ON tt.id = tr.to_tl_id
                WHERE tr.status = 'pending'${isTl ? ' AND tr.from_tl_id = $1' : ''}
                ORDER BY tr.created_at DESC LIMIT 8`,
            values: isTl ? [req.user.id] : []
        };
        const accessFeed = {
            text: `SELECT r.id, r.scope, r.requested_role, r.created_at,
                p.name AS project_name,
                e.employee_id AS emp_code, e.first_name || ' ' || e.last_name AS employee_name
                FROM project_access_requests r
                JOIN projects p ON p.id = r.project_id
                JOIN employees e ON e.id = r.requester_id
                WHERE r.status = 'pending'${isTl ? ` AND EXISTS (
                    SELECT 1 FROM project_leads pl
                    WHERE pl.project_id = r.project_id AND pl.lead_id = $1 AND pl.unit_id IS NULL)` : ''}
                ORDER BY r.created_at DESC LIMIT 8`,
            values: isTl ? [req.user.id] : []
        };
        const handoversFeed = {
            text: `SELECT th.id, th.status, th.start_date, th.end_date, th.created_at,
                ab.first_name || ' ' || ab.last_name AS absent_name, ab.employee_id AS absent_code,
                cv.first_name || ' ' || cv.last_name AS cover_name, cv.employee_id AS cover_code
                FROM team_handovers th
                JOIN employees ab ON ab.id = th.absent_tl_id
                JOIN employees cv ON cv.id = th.cover_tl_id
                WHERE th.status = 'active'${isTl ? ' AND (th.cover_tl_id = $1 OR th.absent_tl_id = $1)' : ''}
                ORDER BY th.created_at DESC LIMIT 8`,
            values: isTl ? [req.user.id] : []
        };

        const [leaves, wfh, tickets, profiles, regs, transfers, accessReqs, handovers] = await Promise.all([
            query(leavesQuery.text, leavesQuery.values),
            query(wfhQuery.text, wfhQuery.values),
            query(ticketsQuery.text, ticketsQuery.values),
            profilesQuery ? query(profilesQuery.text, profilesQuery.values) : Promise.resolve({ rows: [] }),
            // Regularizations live in a table that may predate the feature -
            // repair/retry and never let it break the bell.
            regsQuery ? safe(runWithSchemaRepair(() => query(regsQuery.text, regsQuery.values)))
                .catch(() => ({ rows: [] })) : Promise.resolve({ rows: [] }),
            safe(runWithSchemaRepair(() => query(transfersFeed.text, transfersFeed.values))).catch(() => ({ rows: [] })),
            safe(runWithSchemaRepair(() => query(accessFeed.text, accessFeed.values))).catch(() => ({ rows: [] })),
            safe(runWithSchemaRepair(() => query(handoversFeed.text, handoversFeed.values))).catch(() => ({ rows: [] }))
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
                // r.date is a DATE column (JS Date); dateOnly() keeps this from
                // rendering as 'Thu Sep 03' in the notification subtitle.
                subtitle: `${r.emp_id} · ${dateOnly(r.date) || ''}${r.check_in ? ' · ' + r.check_in : ''}${r.check_out ? '-' + r.check_out : ''}`,
                created_at: r.created_at,
                url: regUrl
            })),
            ...transfers.rows.map(r => ({
                type: 'transfer',
                id: r.id,
                status: r.status,
                title: `${r.employee_name} → ${r.to_tl_name}'s team`,
                subtitle: `${r.emp_code} · from ${r.from_tl_name} · pending`,
                created_at: r.created_at,
                url: '/manager/my-team?tab=transfers'
            })),
            ...accessReqs.rows.map(r => ({
                type: 'access_request',
                id: r.id,
                status: r.status,
                title: `${r.employee_name} requested access to ${r.project_name}`,
                subtitle: `${r.emp_code} · ${r.scope === 'extended' ? 'EXTENDED (' + (r.requested_role || '') + ')' : 'role-level'} · pending`,
                created_at: r.created_at,
                url: '/manager/team-projects'
            })),
            ...handovers.rows.map(r => ({
                type: 'handover',
                id: r.id,
                status: r.status,
                title: `Cover: ${r.absent_name} → ${r.cover_name}`,
                subtitle: `${r.absent_code}/${r.cover_code} · ${r.start_date} → ${r.end_date} · active`,
                created_at: r.created_at,
                url: '/manager/my-team?tab=handover'
            }))
        ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 12);

        res.json({ success: true, feed });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;
