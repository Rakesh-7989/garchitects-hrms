const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken, isAdmin } = require('../middleware/auth');
const { runWithSchemaRepair } = require('../utils/schemaRepair');
const { logAudit } = require('../utils/audit');

// Self-healing query wrapper: heals missing projects-module tables per request.
const q = (sql, params) => runWithSchemaRepair(() => query(sql, params));

// Architecture-studio work categories for a daily update.
const TASK_CATEGORIES = ['design', 'drafting', 'site_visit', 'coordination', 'approvals', 'documentation', 'meeting', 'other'];

// Roles that may view every employee's updates (manager/team_lead see team +
// project progress; HR is read-only across the board; admin is everything).
const CAN_VIEW_ALL_ROLES = ['admin', 'manager', 'team_lead', 'hr'];

/**
 * GET /api/project-updates
 * Role-scoped listing:
 * - employees (not in CAN_VIEW_ALL_ROLES) see only their OWN updates
 * - admin/manager/team_lead/hr may list any update, optionally filtered
 * All rows join project + employee names so list views need no extra calls.
 */
router.get('/', verifyToken, async (req, res) => {
    try {
        const canViewAll = CAN_VIEW_ALL_ROLES.includes(req.user.role);
        const { projectId, employeeId, from, to, limit } = req.query;

        const conditions = [];
        const params = [];
        let p = 0;

        if (!canViewAll) {
            p++;
            conditions.push(`pu.employee_id = $${p}`);
            params.push(req.user.id);
        }
        if (projectId) {
            p++;
            conditions.push(`pu.project_id = $${p}`);
            params.push(projectId);
        }
        if (employeeId && canViewAll) {
            p++;
            conditions.push(`pu.employee_id = $${p}`);
            params.push(employeeId);
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
        const maxRows = Math.min(parseInt(limit, 10) || 200, 500);

        const result = await q(
            `SELECT pu.id, pu.project_id, pu.employee_id, pu.update_date, pu.task_cat,
                    pu.description, pu.hours, pu.notes, pu.created_at, pu.updated_at,
                    p.name as project_name,
                    e.first_name, e.last_name, e.employee_id as emp_code
             FROM project_daily_updates pu
             JOIN projects p ON p.id = pu.project_id
             JOIN employees e ON e.id = pu.employee_id
             ${where}
             ORDER BY pu.update_date DESC, pu.id DESC
             LIMIT $${p + 1}`,
            [...params, maxRows]
        );
        res.json({ success: true, updates: result.rows });
    } catch (error) {
        console.error('Error fetching project updates:', error);
        res.status(500).json({ success: false, message: (error && error.message) || 'Server error' });
    }
});

/**
 * POST /api/project-updates
 * Submit (or update) the caller's own daily update for a project+date.
 * - The employee must still be assigned to the project.
 * - One update per employee per project per date (upsert, like daily work counts).
 */
router.post('/', verifyToken, async (req, res) => {
    try {
        const { projectId, updateDate, taskCat, description, hours, notes } = req.body;
        if (!projectId || !updateDate || !taskCat || !description) {
            return res.status(400).json({ success: false, message: 'Project, date, category and description are required' });
        }
        if (!TASK_CATEGORIES.includes(taskCat)) {
            return res.status(400).json({ success: false, message: `Invalid category. Allowed: ${TASK_CATEGORIES.join(', ')}` });
        }
        const desc = String(description).trim();
        if (!desc) {
            return res.status(400).json({ success: false, message: 'Description is required' });
        }
        const hrs = (hours === undefined || hours === null || hours === '') ? 0 : Number(hours);
        if (!Number.isFinite(hrs) || hrs < 0 || hrs > 24) {
            return res.status(400).json({ success: false, message: 'Hours must be between 0 and 24' });
        }
        const myId = req.user.id;

        // Employee must be assigned to this project.
        const empCheck = await q(
            `SELECT id FROM project_employees WHERE project_id = $1 AND employee_id = $2`,
            [projectId, myId]
        );
        if (empCheck.rows.length === 0) {
            return res.status(403).json({ success: false, message: 'Employee is not assigned to this project' });
        }

        // One update per employee per project per day - create or refresh.
        const existing = await q(
            `SELECT id FROM project_daily_updates WHERE project_id = $1 AND employee_id = $2 AND update_date = $3`,
            [projectId, myId, updateDate]
        );

        if (existing.rows.length > 0) {
            const result = await q(
                `UPDATE project_daily_updates
                    SET task_cat = $1, description = $2, hours = $3, notes = $4, updated_at = NOW()
                  WHERE id = $5
                  RETURNING id, project_id, employee_id, update_date, task_cat, description, hours, notes`,
                [taskCat, desc, hrs, notes || null, existing.rows[0].id]
            );
            logAudit({
                actorId: myId, action: 'project.update.update', entityType: 'project_daily_update',
                entityId: result.rows[0].id, details: { projectId, updateDate, taskCat, hours: hrs }, ip: req.ip
            });
            res.json({ success: true, updated: true, update: result.rows[0], message: 'Daily update saved' });
        } else {
            const result = await q(
                `INSERT INTO project_daily_updates (project_id, employee_id, update_date, task_cat, description, hours, notes)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 RETURNING id, project_id, employee_id, update_date, task_cat, description, hours, notes`,
                [projectId, myId, updateDate, taskCat, desc, hrs, notes || null]
            );
            logAudit({
                actorId: myId, action: 'project.update.create', entityType: 'project_daily_update',
                entityId: result.rows[0].id, details: { projectId, updateDate, taskCat, hours: hrs }, ip: req.ip
            });
            res.json({ success: true, created: true, update: result.rows[0], message: 'Daily update submitted' });
        }
    } catch (error) {
        console.error('Error saving project update:', error);
        res.status(500).json({ success: false, message: (error && error.message) || 'Server error' });
    }
});

/**
 * PUT /api/project-updates/:id
 * Update an existing daily update - the owner employee or an admin.
 */
router.put('/:id', verifyToken, async (req, res) => {
    try {
        const { taskCat, description, hours, notes } = req.body;
        if (!taskCat || !description) {
            return res.status(400).json({ success: false, message: 'Category and description are required' });
        }
        if (!TASK_CATEGORIES.includes(taskCat)) {
            return res.status(400).json({ success: false, message: `Invalid category. Allowed: ${TASK_CATEGORIES.join(', ')}` });
        }
        const desc = String(description).trim();
        if (!desc) {
            return res.status(400).json({ success: false, message: 'Description is required' });
        }
        const hrs = (hours === undefined || hours === null || hours === '') ? 0 : Number(hours);
        if (!Number.isFinite(hrs) || hrs < 0 || hrs > 24) {
            return res.status(400).json({ success: false, message: 'Hours must be between 0 and 24' });
        }

        const found = await q(
            `SELECT id, employee_id FROM project_daily_updates WHERE id = $1`,
            [req.params.id]
        );
        if (found.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Daily update not found' });
        }
        const isOwner = String(found.rows[0].employee_id) === String(req.user.id);
        if (!isOwner && req.user.role !== 'admin') {
            return res.status(403).json({ success: false, message: 'You can only edit your own daily updates' });
        }

        const result = await q(
            `UPDATE project_daily_updates
                SET task_cat = $1, description = $2, hours = $3, notes = $4, updated_at = NOW()
              WHERE id = $5
              RETURNING id, project_id, employee_id, update_date, task_cat, description, hours, notes`,
            [taskCat, desc, hrs, notes || null, req.params.id]
        );
        logAudit({
            actorId: req.user.id, action: 'project.update.update', entityType: 'project_daily_update',
            entityId: req.params.id, details: { taskCat, hours: hrs }, ip: req.ip
        });
        res.json({ success: true, update: result.rows[0], message: 'Daily update updated' });
    } catch (error) {
        console.error('Error updating project update:', error);
        res.status(500).json({ success: false, message: (error && error.message) || 'Server error' });
    }
});

/**
 * DELETE /api/project-updates/:id
 * Delete a daily update - admin only (HR stays read-only).
 */
router.delete('/:id', verifyToken, isAdmin, async (req, res) => {
    try {
        const result = await q(
            `DELETE FROM project_daily_updates WHERE id = $1 RETURNING id, project_id, update_date`,
            [req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Daily update not found' });
        }
        logAudit({
            actorId: req.user.id, action: 'project.update.delete', entityType: 'project_daily_update',
            entityId: req.params.id, details: { projectId: result.rows[0].project_id, updateDate: result.rows[0].update_date }, ip: req.ip
        });
        res.json({ success: true, message: 'Daily update deleted' });
    } catch (error) {
        console.error('Error deleting project update:', error);
        res.status(500).json({ success: false, message: (error && error.message) || 'Server error' });
    }
});

module.exports = router;