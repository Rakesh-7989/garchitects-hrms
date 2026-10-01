// ============================================================
// PROJECT ACCESS — read access to projects you don't lead / aren't assigned to
// (workflow release).
//
// Anyone may REQUEST read access to a project. Approvers = the project's
// whole-project leads, or any manager/admin. On approval a GRANT is created:
//   - scope 'role'     → the grant mirrors the requester's own role level
//                        (employee → employee-level read, team_lead → TL view)
//   - scope 'extended' → the requester explicitly asked for a HIGHER level via
//                        requested_role (employee|team_lead|manager) — audited.
// Optional expires_at; grants are revoked (soft delete) any time by the grantor
// / manager / admin / project whole-lead.
//
// Enforcement today (honest scope): the bite is on EMPLOYEE visibility — a grant
// adds the project to the employee's My Projects list and to the status-updates
// GET scope (read-only). Manager-class users already read across projects via
// the manager GETs; the approval + grant trail still applies to everyone.
// ============================================================
const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { runWithSchemaRepair, pgErrorResponse } = require('../utils/schemaRepair');
const { logAudit } = require('../utils/audit');
const { sendToUser } = require('../services/push');
const { dateOnly, istDateString } = require('../utils/date');

const q = (sql, params) => runWithSchemaRepair(() => query(sql, params));

function mapRoleToLevel(role) {
    switch (role) {
        case 'admin':
        case 'manager': return 'manager';
        case 'team_lead':
        case 'hr': return 'team_lead';
        default: return 'employee';
    }
}

function validRoleLevel(v) {
    return ['employee', 'team_lead', 'manager'].includes(v);
}

// Approver: any manager/admin, or a whole-project lead of that project.
async function canApproveProject(meId, meRole, projectId) {
    if (meRole === 'admin' || meRole === 'manager') return true;
    const r = await q(
        `SELECT 1 FROM project_leads WHERE project_id = $1 AND lead_id = $2 AND unit_id IS NULL LIMIT 1`,
        [projectId, meId]
    );
    return r.rows.length > 0;
}

// ---------------- GET /projects — active project catalog (requester picker)
router.get('/projects', verifyToken, async (req, res) => {
    try {
        const r = await q(
            `SELECT p.id, p.name, p.status FROM projects p WHERE p.status = 'active' ORDER BY p.name`,
            []
        );
        res.json({ success: true, projects: r.rows });
    } catch (error) {
        console.error('project-access/projects error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ---------------- GET /requests
//   default           → my own requests (requester_id = me)
//   ?scope=incoming   → requests I can approve (whole-led projects; + manager/admin see all)
router.get('/requests', verifyToken, async (req, res) => {
    try {
        const incoming = req.query.scope === 'incoming';
        const where = [];
        const params = [];
        if (!incoming) {
            params.push(req.user.id);
            where.push(`r.requester_id = $${params.length}`);
        } else if (req.user.role === 'team_lead') {
            // Only requests on projects I whole-lead are mine to approve.
            params.push(req.user.id);
            where.push(`EXISTS (
                SELECT 1 FROM project_leads pl
                WHERE pl.project_id = r.project_id AND pl.lead_id = $${params.length} AND pl.unit_id IS NULL
            )`);
        }
        const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
        const sql = `
            SELECT r.id, r.project_id, r.requester_id, r.reason, r.scope, r.requested_role,
                   r.expires_at, r.status, r.decided_by, r.decided_at, r.created_at,
                   p.name AS project_name,
                   e.employee_id AS emp_code, e.first_name || ' ' || e.last_name AS employee_name,
                   e.role AS requester_role,
                   db.first_name || ' ' || db.last_name AS decided_by_name
            FROM project_access_requests r
            JOIN projects p ON p.id = r.project_id
            JOIN employees e ON e.id = r.requester_id
            LEFT JOIN employees db ON db.id = r.decided_by
            ${whereSql}
            ORDER BY r.created_at DESC LIMIT 300`;
        const result = await q(sql, params);
        res.json({ success: true, requests: result.rows });
    } catch (error) {
        console.error('project-access/requests error:', error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

// ---------------- GET /grants
//   /grants/my        → my active grants (any role)
//   /grants           → manager/admin/hr all; team_lead → grants on whole-led projects
router.get('/grants/my', verifyToken, async (req, res) => {
    try {
        const r = await q(
            `SELECT g.id, g.project_id, g.granted_by, g.scope, g.role_level, g.reason, g.expires_at, g.created_at,
                    p.name AS project_name,
                    gb.first_name || ' ' || gb.last_name AS granted_by_name
             FROM project_access_grants g
             JOIN projects p ON p.id = g.project_id
             LEFT JOIN employees gb ON gb.id = g.granted_by
             WHERE g.employee_id = $1 AND g.revoked_at IS NULL
               AND (g.expires_at IS NULL OR g.expires_at > NOW())
             ORDER BY g.created_at DESC`,
            [req.user.id]
        );
        res.json({ success: true, grants: r.rows });
    } catch (error) {
        console.error('project-access/grants/my error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.get('/grants', verifyToken, async (req, res) => {
    try {
        if (req.user.role === 'team_lead') {
            // Team leads see grants on the projects they whole-lead (oversight scope).
            const r = await q(
                `SELECT g.id, g.project_id, g.employee_id, g.granted_by, g.scope, g.role_level,
                        g.reason, g.expires_at, g.created_at, g.revoked_by, g.revoked_at,
                        p.name AS project_name,
                        e.employee_id AS emp_code, e.first_name || ' ' || e.last_name AS employee_name,
                        gb.first_name || ' ' || gb.last_name AS granted_by_name
                 FROM project_access_grants g
                 JOIN projects p ON p.id = g.project_id
                 JOIN employees e ON e.id = g.employee_id
                 LEFT JOIN employees gb ON gb.id = g.granted_by
                 WHERE g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > NOW())
                   AND EXISTS (
                       SELECT 1 FROM project_leads pl
                       WHERE pl.project_id = g.project_id AND pl.lead_id = $1 AND pl.unit_id IS NULL
                   )
                 ORDER BY g.created_at DESC LIMIT 300`,
                [req.user.id]
            );
            return res.json({ success: true, grants: r.rows });
        }
        if (!['admin', 'manager', 'hr'].includes(req.user.role)) {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }
        const withRevs = req.query.withRevoked === '1';
        const r = await q(
            `SELECT g.id, g.project_id, g.employee_id, g.granted_by, g.scope, g.role_level,
                    g.reason, g.expires_at, g.created_at, g.revoked_by, g.revoked_at,
                    p.name AS project_name,
                    e.employee_id AS emp_code, e.first_name || ' ' || e.last_name AS employee_name,
                    gb.first_name || ' ' || gb.last_name AS granted_by_name,
                    rb.first_name || ' ' || rb.last_name AS revoked_by_name
             FROM project_access_grants g
             JOIN projects p ON p.id = g.project_id
             JOIN employees e ON e.id = g.employee_id
             LEFT JOIN employees gb ON gb.id = g.granted_by
             LEFT JOIN employees rb ON rb.id = g.revoked_by
             ${withRevs ? '' : `WHERE g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > NOW())`}
             ORDER BY g.created_at DESC LIMIT 500`,
            []
        );
        res.json({ success: true, grants: r.rows });
    } catch (error) {
        console.error('project-access/grants error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ---------------- POST /requests — raise an access request
router.post('/requests', verifyToken, async (req, res) => {
    try {
        const projectId = parseInt(req.body.project_id || req.body.projectId, 10);
        const reason = String(req.body.reason || '').trim().slice(0, 1000);
        const scope = req.body.scope === 'extended' ? 'extended' : 'role';
        const requestedRole = scope === 'extended' ? String(req.body.requested_role || '').trim() : null;
        let expiresAt = req.body.expires_at || null;
        if (expiresAt && !/^\d{4}-\d{2}-\d{2}/.test(String(expiresAt))) {
            return res.status(400).json({ success: false, message: 'expires_at must be a date (YYYY-MM-DD)' });
        }
        if (isNaN(projectId)) return res.status(400).json({ success: false, message: 'project_id is required' });

        const proj = await q(`SELECT id, status FROM projects WHERE id = $1`, [projectId]);
        if (proj.rows.length === 0) return res.status(404).json({ success: false, message: 'Project not found' });
        if (proj.rows[0].status !== 'active') return res.status(400).json({ success: false, message: 'Project is not active' });

        if (scope === 'extended' && !validRoleLevel(requestedRole)) {
            return res.status(400).json({ success: false, message: 'requested_role must be employee, team_lead or manager for extended access' });
        }
        // expiresAt arrives as a client string OR a JS Date, and 'today' must be
        // the office-timezone day - toISOString() is UTC and reads as yesterday
        // between 00:00 and 05:29 IST, which rejected same-day-expiry requests.
        if (expiresAt && dateOnly(expiresAt) <= istDateString()) {
            return res.status(400).json({ success: false, message: 'expires_at must be in the future' });
        }

        const dup = await q(
            `SELECT 1 FROM project_access_requests WHERE project_id = $1 AND requester_id = $2 AND status = 'pending' LIMIT 1`,
            [projectId, req.user.id]
        );
        if (dup.rows.length > 0) return res.status(400).json({ success: false, message: 'You already have a pending request for this project' });

        const ins = await q(
            `INSERT INTO project_access_requests (project_id, requester_id, reason, scope, requested_role, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [projectId, req.user.id, reason || null, scope, requestedRole, expiresAt]
        );
        logAudit({ actorId: req.user.id, action: 'project-access.request', entityType: 'project', entityId: projectId,
            details: { requestId: ins.rows[0].id, scope, requestedRole, expiresAt } });

        // Notify approvers (whole-project leads + managers/admins).
        const approvers = await q(
            `SELECT DISTINCT e.id FROM employees e
             LEFT JOIN project_leads pl ON pl.lead_id = e.id AND pl.project_id = $1 AND pl.unit_id IS NULL
             WHERE e.status = 'active' AND (e.role IN ('admin','manager') OR pl.id IS NOT NULL)`,
            [projectId]
        );
        const ids = new Set(approvers.rows.map(r => r.id));
        ids.delete(req.user.id);
        for (const uid of ids) {
            sendToUser(uid, {
                title: 'Project access request',
                body: `${req.user.name} requested ${scope === 'extended' ? 'EXTENDED (' + requestedRole + ') ' : ''}read access to ${proj.rows[0].id ? '#' + projectId : projectId}`,
                url: '/manager/team-projects'
            }).catch(() => {});
        }
        res.status(201).json({ success: true, requestId: ins.rows[0].id });
    } catch (error) {
        console.error('project-access create error:', error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

// ---------------- approve / reject / cancel
async function decideRequest(req, res, action) {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ success: false, message: 'Invalid request id' });
    try {
        const r0 = await q(`SELECT * FROM project_access_requests WHERE id = $1`, [id]);
        if (r0.rows.length === 0) return res.status(404).json({ success: false, message: 'Access request not found' });
        const R = r0.rows[0];
        if (R.status !== 'pending') return res.status(400).json({ success: false, message: 'This request is already ' + R.status });

        if (action === 'cancel') {
            if (req.user.role !== 'admin' && R.requester_id !== req.user.id) {
                return res.status(403).json({ success: false, message: 'Only the requester or an admin can cancel this request' });
            }
            await q(`UPDATE project_access_requests SET status = 'cancelled', decided_by = $1, decided_at = NOW() WHERE id = $2`, [req.user.id, id]);
            return res.json({ success: true, message: 'Access request cancelled' });
        }

        // approve/reject → approver scope (whole-lead / manager / admin)
        if (!(await canApproveProject(req.user.id, req.user.role, R.project_id))) {
            return res.status(403).json({ success: false, message: 'Only the project lead, a manager or an admin can decide this request' });
        }

        if (action === 'reject') {
            await q(`UPDATE project_access_requests SET status = 'rejected', decided_by = $1, decided_at = NOW() WHERE id = $2`, [req.user.id, id]);
            logAudit({ actorId: req.user.id, action: 'project-access.reject', entityType: 'project', entityId: R.project_id,
                details: { requestId: id, requester: R.requester_id, scope: R.scope } });
            sendToUser(R.requester_id, {
                title: 'Project access request rejected',
                body: `Your ${R.scope} access request for project #${R.project_id} was declined`,
                url: '/employee/my-projects'
            }).catch(() => {});
            return res.json({ success: true, message: 'Access request rejected' });
        }

        // approve → role level = own role (scope role) or the explicit one (extended)
        const requester = await q(`SELECT id, role FROM employees WHERE id = $1`, [R.requester_id]);
        if (requester.rows.length === 0) return res.status(404).json({ success: false, message: 'Requester no longer exists' });
        const roleLevel = R.scope === 'extended' ? R.requested_role : mapRoleToLevel(requester.rows[0].role);
        if (!validRoleLevel(roleLevel)) {
            return res.status(400).json({ success: false, message: 'Invalid role level for grant' });
        }
        const ins = await q(
            `INSERT INTO project_access_grants (project_id, employee_id, granted_by, scope, role_level, reason, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [R.project_id, R.requester_id, req.user.id, R.scope, roleLevel, R.reason, R.expires_at]
        );
        await q(`UPDATE project_access_requests SET status = 'approved', decided_by = $1, decided_at = NOW() WHERE id = $2`, [req.user.id, id]);
        logAudit({ actorId: req.user.id, action: 'project-access.approve', entityType: 'project', entityId: R.project_id,
            details: { requestId: id, requester: R.requester_id, scope: R.scope, roleLevel, grantId: ins.rows[0].id } });
        sendToUser(R.requester_id, {
            title: 'Project access granted',
            body: `You now have ${roleLevel}-level read access to project #${R.project_id}${R.expires_at ? ' until ' + (dateOnly(R.expires_at) || '') : ''}`,
            url: '/employee/my-projects'
        }).catch(() => {});
        res.json({ success: true, message: 'Access granted', grantId: ins.rows[0].id });
    } catch (error) {
        console.error('project-access decide error:', error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
}

router.post('/requests/:id/approve', verifyToken, (req, res) => decideRequest(req, res, 'approve'));
router.post('/requests/:id/reject', verifyToken, (req, res) => decideRequest(req, res, 'reject'));
router.post('/requests/:id/cancel', verifyToken, (req, res) => decideRequest(req, res, 'cancel'));

// ---------------- DELETE /grants/:id — revoke (soft)
router.delete('/grants/:id', verifyToken, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ success: false, message: 'Invalid grant id' });
    try {
        const g = await q(`SELECT * FROM project_access_grants WHERE id = $1`, [id]);
        if (g.rows.length === 0) return res.status(404).json({ success: false, message: 'Grant not found' });
        const G = g.rows[0];
        if (G.revoked_at) return res.status(400).json({ success: false, message: 'Grant already revoked' });

        const delegated = req.user.role === 'manager' || req.user.role === 'admin';
        const isGrantor = G.granted_by === req.user.id;
        const isWholeLead = req.user.role === 'team_lead' && (await canApproveProject(req.user.id, req.user.role, G.project_id));
        if (!delegated && !isGrantor && !isWholeLead) {
            return res.status(403).json({ success: false, message: 'Only the grantor, the project lead, a manager or an admin can revoke this grant' });
        }
        await q(`UPDATE project_access_grants SET revoked_by = $1, revoked_at = NOW() WHERE id = $2`, [req.user.id, id]);
        logAudit({ actorId: req.user.id, action: 'project-access.revoke', entityType: 'project', entityId: G.project_id,
            details: { grantId: id, employee: G.employee_id, scope: G.scope, roleLevel: G.role_level } });
        res.json({ success: true, message: 'Access revoked' });
    } catch (error) {
        console.error('project-access revoke error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;