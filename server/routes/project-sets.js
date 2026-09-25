const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken, isAdmin } = require('../middleware/auth');
const { runWithSchemaRepair, pgErrorResponse, hasColumn } = require('../utils/schemaRepair');
const projectMath = require('../utils/projectMath');
const { logAudit } = require('../utils/audit');

// Self-healing query wrapper: heals missing projects-module tables per request.
const q = (sql, params) => runWithSchemaRepair(() => query(sql, params));

// Statuses accepted by the project_sets.status CHECK constraint.
const SET_STATUSES = ['active', 'paused', 'completed'];

/**
 * GET /api/project-sets/single/:id
 * Get a single set by ID (MUST be before /:projectId to avoid route conflict)
 * Administrators see any set; employees/others may only read sets of projects
 * they are assigned to (closes a cross-project read hole).
 */
router.get('/single/:id', verifyToken, async (req, res) => {
    try {
        const hasDeletedAt = await hasColumn('project_sets', 'deleted_at');
        const deletedFilter = hasDeletedAt ? 'AND ps.deleted_at IS NULL' : '';
        const result = await q(
            `SELECT ps.*, p.name as project_name, COALESCE(p.client, p.customer) as project_client,
             (
                 SELECT COUNT(*) FROM employees e
                 JOIN project_employees pe ON e.id = pe.employee_id
                 WHERE pe.project_id = ps.project_id
             ) as project_employee_count,
             (
                 SELECT COUNT(*) FROM daily_work_counts dc
                 WHERE dc.set_id = ps.id
             ) as submission_count
             FROM project_sets ps
             JOIN projects p ON ps.project_id = p.id
             WHERE ps.id = $1 ${deletedFilter}`,
            [req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Set not found' });
        }
        if (req.user.role !== 'admin') {
            const member = await q(
                `SELECT 1 FROM project_employees WHERE project_id = $1 AND employee_id = $2`,
                [result.rows[0].project_id, req.user.id]
            );
            if (member.rows.length === 0) {
                return res.status(403).json({ success: false, message: 'You are not assigned to this project' });
            }
        }
        res.json({ success: true, set: result.rows[0] });
    } catch (error) {
        console.error(`Error fetching set ${req.params.id}:`, error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

/**
 * GET /api/project-sets/:projectId
 * Get all sets for a project
 */
router.get('/:projectId', verifyToken, isAdmin, async (req, res) => {
    try {
        // Legacy databases created before soft-delete / assignment-status have no
        // deleted_at / status columns. Gate both filters on their existence so
        // this never 500s with 42703.
        const hasDeletedAt = await hasColumn('project_sets', 'deleted_at');
        const deletedFilter = hasDeletedAt ? 'AND ps.deleted_at IS NULL' : '';
        const hasPeStatus = await hasColumn('project_employees', 'status');
        const teamFilter = hasPeStatus ? "AND (pe.status = 'active' OR pe.status IS NULL)" : '';
        const result = await q(
            `SELECT ps.id, ps.name, ps.start_date, ps.end_date, ps.total_target, ps.status, ps.working_days,
             (SELECT COUNT(DISTINCT pe.employee_id) FROM project_employees pe WHERE pe.project_id = $1 ${teamFilter}) as team_size,
             (SELECT COUNT(*) FROM daily_work_counts dc WHERE dc.set_id = ps.id) as submission_count
             FROM project_sets ps
             WHERE ps.project_id = $1 ${deletedFilter}
             ORDER BY ps.name`,
            [req.params.projectId]
        );
        res.json({ success: true, sets: result.rows });
    } catch (error) {
        console.error(`Error fetching sets for project ${req.params.projectId}:`, error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: (error && error.message) || r.message });
    }
});

/**
 * POST /api/project-sets/:projectId
 * Create a new set for a project
 */
router.post('/:projectId', verifyToken, isAdmin, async (req, res) => {
    try {
        const { name, start_date, end_date, total_target } = req.body;
        if (!name || !String(name).trim() || !start_date || !end_date || total_target === undefined) {
            return res.status(400).json({ success: false, message: 'Set name, start_date, end_date, and total_target are required' });
        }

        const projectCheck = await q(`SELECT id FROM projects WHERE id = $1`, [req.params.projectId]);
        if (projectCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Project not found' });
        }

        if (String(end_date) < String(start_date)) {
            return res.status(400).json({ success: false, message: 'End date must be on or after the start date' });
        }
        const target = Number(total_target);
        if (!Number.isFinite(target) || target < 0) {
            return res.status(400).json({ success: false, message: 'Total target must be a non-negative number' });
        }

        const trimmedName = String(name).trim();
        // Single authoritative working-day count (weekly off day + company holidays).
        const workingDays = await projectMath.workingDays(start_date, end_date);

        const result = await q(
            `INSERT INTO project_sets (project_id, name, start_date, end_date, total_target, working_days, status) 
             VALUES ($1, $2, $3, $4, $5, $6, 'active') 
             RETURNING id, project_id, name, start_date, end_date, total_target, working_days, status`,
            [req.params.projectId, trimmedName, start_date, end_date, target, workingDays]
        );

        logAudit({
            actorId: req.user.id, action: 'project_set.create', entityType: 'project_set',
            entityId: result.rows[0].id,
            details: { projectId: req.params.projectId, name: trimmedName, start_date, end_date, total_target: target, workingDays },
            ip: req.ip
        });

        res.json({ success: true, set: result.rows[0], workingDays });
    } catch (error) {
        console.error(`Error creating set for project ${req.params.projectId}:`, error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

/**
 * PUT /api/project-sets/:id
 * Edit an existing set (name, dates, target, status). working_days is
 * recomputed via the shared projectMath whenever the date range changes.
 */
router.put('/:id', verifyToken, isAdmin, async (req, res) => {
    try {
        const { name, start_date, end_date, total_target, status } = req.body;

        const exists = await q(
            `SELECT id, name, start_date, end_date, total_target, working_days, status FROM project_sets WHERE id = $1`,
            [req.params.id]
        );
        if (exists.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Set not found' });
        }
        const current = exists.rows[0];

        if (start_date && end_date && String(end_date) < String(start_date)) {
            return res.status(400).json({ success: false, message: 'End date must be on or after the start date' });
        }
        if (total_target !== undefined) {
            const target = Number(total_target);
            if (!Number.isFinite(target) || target < 0) {
                return res.status(400).json({ success: false, message: 'Total target must be a non-negative number' });
            }
        }
        if (status !== undefined && !SET_STATUSES.includes(status)) {
            return res.status(400).json({ success: false, message: `Invalid set status. Allowed: ${SET_STATUSES.join(', ')}` });
        }

        const newName = name !== undefined && String(name).trim() !== '' ? String(name).trim() : current.name;
        const newStart = start_date || String(current.start_date).slice(0, 10);
        const newEnd = end_date || String(current.end_date).slice(0, 10);
        const newTarget = total_target !== undefined ? Number(total_target) : current.total_target;
        const datesChanged = String(newStart) !== String(current.start_date).slice(0, 10)
            || String(newEnd) !== String(current.end_date).slice(0, 10);
        const workingDays = datesChanged
            ? await projectMath.workingDays(newStart, newEnd)
            : current.working_days;

        const result = await q(
            `UPDATE project_sets
             SET name = $1, start_date = $2, end_date = $3, total_target = $4, working_days = $5,
                 status = COALESCE($6::varchar, status), updated_at = NOW()
             WHERE id = $7
             RETURNING id, project_id, name, start_date, end_date, total_target, working_days, status, deleted_at`,
            [newName, newStart, newEnd, newTarget, workingDays, status || null, req.params.id]
        );

        logAudit({
            actorId: req.user.id, action: 'project_set.update', entityType: 'project_set',
            entityId: req.params.id,
            details: { name: newName, start_date: newStart, end_date: newEnd, total_target: newTarget, workingDays, status: status || current.status, datesChanged },
            ip: req.ip
        });

        res.json({ success: true, set: result.rows[0] });
    } catch (error) {
        console.error(`Error updating set ${req.params.id}:`, error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: (error && error.message) || r.message });
    }
});

/**
 * DELETE /api/project-sets/:id
 * Soft-delete a set (marks deleted_at) whenever the column exists - this is what
 * the GET routes filter on, and it lets the admin UI's "undo delete set" restore
 * the set. Hard-delete fallback only for legacy databases that predate the
 * deleted_at column (there the cascade to daily_work_counts still applies).
 */
router.delete('/:id', verifyToken, isAdmin, async (req, res) => {
    try {
        const hasDeletedAt = await hasColumn('project_sets', 'deleted_at');
        const result = hasDeletedAt
            ? await q(
                `UPDATE project_sets SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL
                 RETURNING id, name, project_id`,
                [req.params.id]
            )
            : await q(
                `DELETE FROM project_sets WHERE id = $1 RETURNING id, name, project_id`,
                [req.params.id]
            );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Set not found' });
        }
        logAudit({
            actorId: req.user.id, action: 'project_set.delete', entityType: 'project_set',
            entityId: req.params.id, details: { name: result.rows[0].name, soft: hasDeletedAt },
            ip: req.ip
        });
        res.json({ success: true, message: 'Set deleted successfully', set: result.rows[0] });
    } catch (error) {
        console.error(`Error deleting set ${req.params.id}:`, error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: (error && error.message) || r.message });
    }
});

/**
 * POST /api/project-sets/:id/restore
 * Restore a soft-deleted set - backs the admin "undo delete" toast in
 * project-management.html (restoreSet()). Registered after POST /:projectId, but
 * /:projectId matches a single path segment only, so there is no conflict.
 */
router.post('/:id/restore', verifyToken, isAdmin, async (req, res) => {
    try {
        const result = await q(
            `UPDATE project_sets SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL
             RETURNING id, name, project_id`,
            [req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Set not found or not deleted' });
        }
        logAudit({
            actorId: req.user.id, action: 'project_set.restore', entityType: 'project_set',
            entityId: req.params.id, details: { name: result.rows[0].name }, ip: req.ip
        });
        res.json({ success: true, message: 'Set restored successfully', set: result.rows[0] });
    } catch (error) {
        console.error(`Error restoring set ${req.params.id}:`, error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: (error && error.message) || r.message });
    }
});

module.exports = router;