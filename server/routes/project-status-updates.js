const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { runWithSchemaRepair, pgErrorResponse } = require('../utils/schemaRepair');
const { logAudit } = require('../utils/audit');
const { coversProjectArea } = require('./project-leads');

// Self-healing query wrapper: heals missing projects-module tables per request.
const q = (sql, params) => runWithSchemaRepair(() => query(sql, params));

// Management-level categories for a project / unit status update.
const CATEGORIES = ['progress', 'site_status', 'coordination', 'risk', 'milestone', 'approval', 'other'];

// Roles allowed to AUTHOR updates (HR stays read-only; employees never author).
const CAN_AUTHOR = ['admin', 'manager', 'team_lead'];

// Roles that may view every project's updates. Employees see only the updates
// on projects they are assigned to (read-only).
const CAN_VIEW_ALL = ['admin', 'manager', 'team_lead', 'hr'];

/**
 * GET /api/project-status-updates
 * Role-scoped listing:
 * - admin/manager/team_lead/hr: all project/unit updates, optionally filtered.
 * - employees: only updates on projects they are assigned to (read-only).
 * All rows join project + unit + author names so list views need no extra calls.
 */
router.get('/', verifyToken, async (req, res) => {
    try {
        const canViewAll = CAN_VIEW_ALL.includes(req.user.role);
        const { projectId, unitId, from, to, limit } = req.query;

        const conditions = [];
        const params = [];
        let p = 0;

        if (!canViewAll) {
            // Employees: updates on assigned projects OR projects granted to
            // them via project_access_grants (active, not revoked/expired).
            p++;
            conditions.push(`(pu.project_id IN (SELECT project_id FROM project_employees WHERE employee_id = $${p})`);
            p++;
            conditions.push(`pu.project_id IN (SELECT project_id FROM project_access_grants WHERE employee_id = $${p} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())))`);
            params.push(req.user.id, req.user.id);
        }
        if (projectId) {
            p++;
            conditions.push(`pu.project_id = $${p}`);
            params.push(projectId);
        }
        if (unitId) {
            p++;
            conditions.push(`pu.unit_id = $${p}`);
            params.push(unitId);
        }
        if (from) {
            p++;
            conditions.push(`pu.update_date >= $${p}::date`);
            params.push(from);
        }
        if (to) {
            p++;
            conditions.push(`pu.update_date <= $${p}::date`);
            params.push(to);
        }

        const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
        const maxRows = Math.min(parseInt(limit, 10) || 100, 300);

        const result = await q(
            `SELECT pu.id, pu.project_id, pu.unit_id, pu.author_id, pu.update_date, pu.category,
                    pu.description, pu.notes, pu.created_at, pu.updated_at,
                    p.name as project_name,
                    u.name as unit_name,
                    e.first_name, e.last_name, e.employee_id as emp_code,
                    e.role as author_role
             FROM project_status_updates pu
             JOIN projects p ON p.id = pu.project_id
             JOIN employees e ON e.id = pu.author_id
             LEFT JOIN project_units u ON u.id = pu.unit_id
             ${where}
             ORDER BY pu.update_date DESC, pu.id DESC
             LIMIT $${p + 1}`,
            [...params, maxRows]
        );
        res.json({ success: true, updates: result.rows });
    } catch (error) {
        console.error('Error fetching project status updates:', error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

/**
 * POST /api/project-status-updates
 * Create a project/unit management update. ONLY team leads, managers and
 * admins may author one (HR and employees are read-only). A team lead is
 * restricted to the projects/units they lead (P9/D11).
 * body: { projectId, unitId?, updateDate?, category, description, notes? }
 */
router.post('/', verifyToken, async (req, res) => {
    try {
        if (!CAN_AUTHOR.includes(req.user.role)) {
            return res.status(403).json({ success: false, message: 'Only team leads and managers can post project status updates' });
        }
        const { projectId, unitId, updateDate, category, description, notes } = req.body;

        const proj = parseInt(projectId, 10);
        if (isNaN(proj)) {
            return res.status(400).json({ success: false, message: 'Project is required' });
        }
        if (!CATEGORIES.includes(category)) {
            return res.status(400).json({ success: false, message: `Invalid category. Allowed: ${CATEGORIES.join(', ')}` });
        }
        const desc = String(description || '').trim();
        if (!desc) {
            return res.status(400).json({ success: false, message: 'Description is required' });
        }

        let date = null;
        if (updateDate !== undefined && updateDate !== null && String(updateDate).trim() !== '') {
            date = String(updateDate).slice(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                return res.status(400).json({ success: false, message: 'Invalid date (YYYY-MM-DD)' });
            }
        }

        // Project must exist.
        const projCheck = await q(`SELECT id FROM projects WHERE id = $1`, [proj]);
        if (projCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Project not found' });
        }

        // Optional unit must belong to this project.
        let unit = (unitId === undefined || unitId === null || unitId === '') ? null : parseInt(unitId, 10);
        if (unit !== null) {
            if (isNaN(unit)) {
                return res.status(400).json({ success: false, message: 'Invalid unit selected' });
            }
            const unitCheck = await q(
                `SELECT id FROM project_units WHERE id = $1 AND project_id = $2`,
                [unit, proj]
            );
            if (unitCheck.rows.length === 0) {
                return res.status(400).json({ success: false, message: 'Selected unit does not belong to this project' });
            }
        }

        // P9/D11 + P10: a team lead posts only on projects/units they lead —
        // or, while an active handover is in force, on the absent lead's
        // projects/units they are covering (authoring scope carried along).
        if (req.user.role === 'team_lead') {
            const covers = await coversProjectArea(proj, unit, req.user.id);
            if (!covers) {
                return res.status(403).json({ success: false, message: 'You can only post updates on projects/units you lead (or cover during a handover)' });
            }
        }

        const result = await q(
            `INSERT INTO project_status_updates (project_id, unit_id, author_id, update_date, category, description, notes)
             VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE), $5, $6, $7)
             RETURNING id, project_id, unit_id, author_id, update_date, category, description, notes`,
            [proj, unit, req.user.id, date, category, desc, notes || null]
        );
        logAudit({
            actorId: req.user.id, action: 'project.status_update.create', entityType: 'project_status_update',
            entityId: result.rows[0].id, details: { projectId: proj, unitId: unit, updateDate: date, category }, ip: req.ip
        });
        res.json({ success: true, created: true, update: result.rows[0], message: 'Project update posted' });
    } catch (error) {
        console.error('Error posting project status update:', error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

/**
 * PUT /api/project-status-updates/:id
 * Edit an existing project/unit status update - the author, a manager or an
 * admin may edit it (manager = oversight over team-lead posts; HR stays
 * read-only).
 */
router.put('/:id', verifyToken, async (req, res) => {
    try {
        const { category, description, notes, unitId } = req.body;
        if (!CATEGORIES.includes(category)) {
            return res.status(400).json({ success: false, message: `Invalid category. Allowed: ${CATEGORIES.join(', ')}` });
        }
        const desc = String(description || '').trim();
        if (!desc) {
            return res.status(400).json({ success: false, message: 'Description is required' });
        }

        const found = await q(
            `SELECT id, author_id, project_id FROM project_status_updates WHERE id = $1`,
            [req.params.id]
        );
        if (found.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Project update not found' });
        }
        const row = found.rows[0];
        const isOwner = String(row.author_id) === String(req.user.id);
        if (!isOwner && !['admin', 'manager'].includes(req.user.role)) {
            return res.status(403).json({ success: false, message: 'You can only edit your own project updates' });
        }

        // Optional unit must belong to the same project as this update.
        let unit = (unitId === undefined || unitId === null || unitId === '') ? null : parseInt(unitId, 10);
        if (unit !== null) {
            if (isNaN(unit)) {
                return res.status(400).json({ success: false, message: 'Invalid unit selected' });
            }
            const unitCheck = await q(
                `SELECT id FROM project_units WHERE id = $1 AND project_id = $2`,
                [unit, row.project_id]
            );
            if (unitCheck.rows.length === 0) {
                return res.status(400).json({ success: false, message: 'Selected unit does not belong to this project' });
            }
        }

        const result = await q(
            `UPDATE project_status_updates
                SET unit_id = $1, category = $2, description = $3, notes = $4, updated_at = NOW()
              WHERE id = $5
              RETURNING id, project_id, unit_id, author_id, update_date, category, description, notes`,
            [unit, category, desc, notes || null, req.params.id]
        );
        logAudit({
            actorId: req.user.id, action: 'project.status_update.update', entityType: 'project_status_update',
            entityId: req.params.id, details: { category }, ip: req.ip
        });
        res.json({ success: true, update: result.rows[0], message: 'Project update updated' });
    } catch (error) {
        console.error('Error updating project status update:', error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

/**
 * DELETE /api/project-status-updates/:id
 * Delete a project/unit status update - the author, a manager or an admin may
 * delete it (HR stays read-only).
 */
router.delete('/:id', verifyToken, async (req, res) => {
    try {
        const found = await q(
            `SELECT id, author_id, project_id FROM project_status_updates WHERE id = $1`,
            [req.params.id]
        );
        if (found.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Project update not found' });
        }
        const row = found.rows[0];
        const isOwner = String(row.author_id) === String(req.user.id);
        if (!isOwner && !['admin', 'manager'].includes(req.user.role)) {
            return res.status(403).json({ success: false, message: 'You can only delete your own project updates' });
        }
        const result = await q(
            `DELETE FROM project_status_updates WHERE id = $1 RETURNING id, project_id, update_date`,
            [req.params.id]
        );
        logAudit({
            actorId: req.user.id, action: 'project.status_update.delete', entityType: 'project_status_update',
            entityId: req.params.id, details: { projectId: result.rows[0].project_id, updateDate: result.rows[0].update_date }, ip: req.ip
        });
        res.json({ success: true, message: 'Project update deleted' });
    } catch (error) {
        console.error('Error deleting project status update:', error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

module.exports = router;