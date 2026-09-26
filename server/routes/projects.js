const express = require('express');
const router = express.Router();
const { query, getClient } = require('../config/database');
const { verifyToken, isAdmin } = require('../middleware/auth');
const { runWithSchemaRepair, pgErrorResponse } = require('../utils/schemaRepair');
const { logAudit } = require('../utils/audit');

// Self-healing query wrapper: if a legacy database is missing the projects
// module tables, the first 42P01 error creates them and the request retries.
const q = (sql, params) => runWithSchemaRepair(() => query(sql, params));

// Statuses accepted by the projects.status CHECK constraint (7 lifecycle states).
const ALLOWED_STATUSES = ['active', 'inactive', 'on_hold', 'completed', 'cancelled', 'paused', 'terminated'];
// Project classification (kept; the construction phase field was removed).
const PROJECT_TYPES = ['residential', 'commercial', 'institutional', 'industrial', 'infrastructure', 'interior', 'landscape', 'other'];

// Guard the Phase 1 lifecycle fields shared by POST and PUT.
// Returns { ok:true, values } or { ok:false, status, message }.
function parseLifecycle(body) {
    const values = {
        start_date: null, end_date: null,
        location: null, project_type: null
    };
    const has = (k) => body[k] !== undefined && body[k] !== null && String(body[k]) !== '';

    if (has('start_date')) values.start_date = String(body.start_date).slice(0, 10);
    if (has('end_date')) values.end_date = String(body.end_date).slice(0, 10);
    if (values.start_date && values.end_date && values.end_date < values.start_date) {
        return { ok: false, status: 400, message: 'End date must be on or after the start date' };
    }
    if (has('location')) values.location = String(body.location).trim();
    if (has('project_type')) {
        if (!PROJECT_TYPES.includes(body.project_type)) {
            return { ok: false, status: 400, message: `Invalid project type. Allowed: ${PROJECT_TYPES.join(', ')}` };
        }
        values.project_type = body.project_type;
    }
    return { ok: true, values };
}

// Columns every project list/detail query returns (kept in sync so the UI
// always sees the same shape).
const PROJECT_SELECT_COLS = `p.id, p.name, COALESCE(p.client, p.customer) as client, p.description, p.status,
    p.start_date, p.end_date, p.location, p.project_type,
    p.created_at, p.updated_at`;

/**
 * GET /api/projects/my
 * Get projects assigned to the logged-in employee (no admin role required)
 */
router.get('/my', verifyToken, async (req, res) => {
    try {
        const result = await q(
            `SELECT ${PROJECT_SELECT_COLS}
             FROM projects p
             JOIN project_employees pe ON p.id = pe.project_id
             WHERE pe.employee_id = $1 AND p.status = 'active'
             ORDER BY p.name`,
            [req.user.id]
        );
        // Attach the units of the caller's assignments (unit per project).
        const unitResult = await q(
            `SELECT pe.project_id, u.id, u.name, u.code
             FROM project_employees pe
             JOIN project_units u ON u.id = pe.unit_id
             WHERE pe.employee_id = $1 AND pe.unit_id IS NOT NULL
             ORDER BY u.name`,
            [req.user.id]
        );
        const unitsByProject = {};
        unitResult.rows.forEach(r => {
            if (!unitsByProject[r.project_id]) unitsByProject[r.project_id] = [];
            unitsByProject[r.project_id].push({ id: r.id, name: r.name, code: r.code });
        });
        res.json({
            success: true,
            projects: result.rows.map(p => ({ ...p, units: unitsByProject[p.id] || [] }))
        });
    } catch (error) {
        console.error('Error fetching employee projects:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

/**
 * GET /api/projects
 * Get all projects
 */
router.get('/', verifyToken, isAdmin, async (req, res) => {
    try {
        const result = await q(
            `SELECT ${PROJECT_SELECT_COLS},
             (SELECT COUNT(*) FROM project_employees pe WHERE pe.project_id = p.id) as employees_count,
             (SELECT COUNT(*) FROM project_units u WHERE u.project_id = p.id) as units_count
             FROM projects p
             ORDER BY p.name`
        );
        res.json({ success: true, projects: result.rows });
    } catch (error) {
        console.error('Error fetching projects:', error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: (error && error.message) || r.message });
    }
});

/**
 * GET /api/projects/stats
 * Global counters for the top summary cards (MUST be before /:id)
 */
router.get('/stats', verifyToken, isAdmin, async (req, res) => {
    try {
        const result = await q(
            `SELECT
             (SELECT COUNT(*) FROM projects) as projects,
             (SELECT COUNT(DISTINCT employee_id) FROM project_employees) as assigned_employees`
        );
        res.json({
            success: true,
            stats: {
                projects: parseInt(result.rows[0].projects, 10) || 0,
                assigned_employees: parseInt(result.rows[0].assigned_employees, 10) || 0
            }
        });
    } catch (error) {
        console.error('Error fetching project stats:', error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

/**
 * POST /api/projects
 * Create a new project
 */
router.post('/', verifyToken, isAdmin, async (req, res) => {
    try {
        const { name, client, description, status } = req.body;
        if (!name) {
            return res.status(400).json({ success: false, message: 'Project name is required' });
        }
        const finalStatus = ALLOWED_STATUSES.includes(status) ? status : 'active';
        const lc = parseLifecycle(req.body);
        if (!lc.ok) {
            return res.status(lc.status).json({ success: false, message: lc.message });
        }
        const v = lc.values;

        const result = await q(
            `INSERT INTO projects (name, client, description, status,
                start_date, end_date, location, project_type)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id, name, client, description, status,
                start_date, end_date, location, project_type, created_at`,
            [name, client || null, description || null, finalStatus,
             v.start_date, v.end_date,
             v.location, v.project_type || 'other']
        );
        const created = result.rows[0];
        created.employees_count = 0;
        logAudit({
            actorId: req.user.id, action: 'project.create', entityType: 'project',
            entityId: created.id, details: { name: created.name, client: created.client || null, status: created.status },
            ip: req.ip
        });
        res.json({ success: true, project: created });
    } catch (error) {
        console.error('Error creating project:', error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

/**
 * GET /api/projects/:id
 * Get a single project by ID
 */
router.get('/:id', verifyToken, isAdmin, async (req, res) => {
    try {
        const result = await q(
            `SELECT id, name, COALESCE(client, customer) as client, description, status,
                start_date, end_date, location, project_type, created_at, updated_at
             FROM projects WHERE id = $1`,
            [req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Project not found' });
        }
        res.json({ success: true, project: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

/**
 * PUT /api/projects/:id
 * Update a project
 */
router.put('/:id', verifyToken, isAdmin, async (req, res) => {
    try {
        const { name, client, description, status } = req.body;
        if (!name || !String(name).trim()) {
            return res.status(400).json({ success: false, message: 'Project name is required' });
        }
        const trimmedName = String(name).trim();
        // When status is omitted/blank, keep the CURRENT status instead of
        // silently resetting the project to 'active' (the old default).
        const hasStatus = status !== undefined && status !== null && status !== '';
        const finalStatus = hasStatus && ALLOWED_STATUSES.includes(status) ? status : null;
        if (hasStatus && !finalStatus) {
            return res.status(400).json({ success: false, message: `Invalid status. Allowed: ${ALLOWED_STATUSES.join(', ')}` });
        }
        const lc = parseLifecycle(req.body);
        if (!lc.ok) {
            return res.status(lc.status).json({ success: false, message: lc.message });
        }
        const v = lc.values;

        const result = await q(
            `UPDATE projects SET name = $1, client = $2, description = $3, status = COALESCE($4::varchar, status),
                start_date = COALESCE($5::date, start_date),
                end_date = COALESCE($6::date, end_date),
                location = COALESCE($7, location),
                project_type = COALESCE($8, project_type),
                updated_at = NOW()
             WHERE id = $9
             RETURNING id, name, client, description, status,
                start_date, end_date, location, project_type, created_at, updated_at`,
            [trimmedName, client || null, description || null, finalStatus,
             v.start_date, v.end_date, v.location, v.project_type, req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Project not found' });
        }
        logAudit({
            actorId: req.user.id, action: 'project.update', entityType: 'project',
            entityId: req.params.id, details: { name: trimmedName, client: client || null, statusChange: hasStatus ? { to: finalStatus } : null },
            ip: req.ip
        });
        res.json({ success: true, project: result.rows[0] });
    } catch (error) {
        console.error(`Error updating project ${req.params.id}:`, error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

/**
 * DELETE /api/projects/:id
 * Delete/deactivate a project
 */
router.delete('/:id', verifyToken, isAdmin, async (req, res) => {
    const projectId = req.params.id;
    const client = await getClient();
    try {
        const exists = await client.query(`SELECT id, name FROM projects WHERE id = $1`, [projectId]);
        if (exists.rows.length === 0) {
            client.release();
            return res.status(404).json({ success: false, message: 'Project not found' });
        }

        // Delete descendants atomically (daily updates, documents, assignments)
        // so the project can be removed even when it has associated records -
        // and so a legacy DB without FK CASCADE is handled too. Hard delete is
        // intentional here: the admin UI warns it is permanent (no undo).
        await client.query('BEGIN');
        await client.query(`DELETE FROM project_daily_updates WHERE project_id = $1`, [projectId]);
        await client.query(`DELETE FROM project_documents WHERE project_id = $1`, [projectId]);
        await client.query(`DELETE FROM project_employees WHERE project_id = $1`, [projectId]);
        const result = await client.query(
            `DELETE FROM projects WHERE id = $1 RETURNING id, name`,
            [projectId]
        );
        await client.query('COMMIT');
        client.release();

        logAudit({
            actorId: req.user.id, action: 'project.delete', entityType: 'project',
            entityId: projectId, details: { name: result.rows[0].name, hard: true }, ip: req.ip
        });
        res.json({ success: true, project: result.rows[0], message: 'Project deleted successfully' });
    } catch (error) {
        try { if (client) await client.query('ROLLBACK'); } catch (_) {}
        if (client) client.release();
        console.error(`Error deleting project ${projectId}:`, error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

/**
 * GET /api/projects/:projectId/employees
 * Get employees assigned to a project
 */
router.get('/:projectId/employees', verifyToken, isAdmin, async (req, res) => {
    try {
        const result = await q(
            `SELECT e.id, e.employee_id, e.first_name, e.last_name, e.email, e.phone, 
              e.role, e.status, e.department_id, d.name as department_name,
              pe.unit_id, u.name as unit_name
             FROM project_employees pe
             JOIN employees e ON pe.employee_id = e.id
             LEFT JOIN departments d ON e.department_id = d.id
             LEFT JOIN project_units u ON u.id = pe.unit_id
             WHERE pe.project_id = $1 AND e.role != 'admin'
             ORDER BY e.first_name, e.last_name`,
            [req.params.projectId]
        );
        res.json({ success: true, employees: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

/**
 * POST /api/projects/:projectId/employees
 * Assign employees to a project
 */
router.post('/:projectId/employees', verifyToken, isAdmin, async (req, res) => {
    try {
        const { employeeIds, assignments } = req.body;
        // Backwards compatible: `{ employeeIds: [1, 2] }` → no-unit assignments.
        // New shape: `{ assignments: [{ employeeId, unitId }] }` (unitId optional).
        let list = [];
        if (Array.isArray(assignments) && assignments.length > 0) {
            list = assignments;
        } else if (Array.isArray(employeeIds) && employeeIds.length > 0) {
            list = employeeIds.map(id => ({ employeeId: id, unitId: null }));
        } else {
            return res.status(400).json({ success: false, message: 'Employee IDs are required' });
        }

        const projectId = parseInt(req.params.projectId, 10);
        if (isNaN(projectId)) {
            return res.status(400).json({ success: false, message: 'Invalid project id' });
        }

        // Check if project exists
        const projectCheck = await q(`SELECT id FROM projects WHERE id = $1`, [projectId]);
        if (projectCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Project not found' });
        }

        // Every supplied unit must belong to this project.
        const unitIds = [...new Set(list.map(a => a.unitId).filter(u => u !== null && u !== undefined && u !== ''))];
        if (unitIds.length > 0) {
            const units = await q(
                `SELECT id FROM project_units WHERE project_id = $1 AND id = ANY($2::int[])`,
                [projectId, unitIds]
            );
            const found = new Set(units.rows.map(r => r.id));
            const bad = unitIds.find(u => !found.has(u));
            if (bad !== undefined) {
                return res.status(400).json({ success: false, message: `Unit ${bad} does not belong to this project` });
            }
        }

        // Assign employees (idempotent): skip an assignment that already exists
        // for the same project + employee + unit.
        const results = [];
        for (const a of list) {
            const empId = parseInt(a.employeeId ?? a.employee_id, 10);
            if (isNaN(empId)) continue;
            const rawUnit = a.unitId ?? a.unit_id;
            const unitId = (rawUnit === null || rawUnit === undefined || rawUnit === '') ? null : parseInt(rawUnit, 10);
            if (unitId !== null && isNaN(unitId)) continue;

            const existing = unitId === null
                ? await q(
                    `SELECT id FROM project_employees
                     WHERE project_id = $1 AND employee_id = $2 AND unit_id IS NULL`,
                    [projectId, empId]
                )
                : await q(
                    `SELECT id FROM project_employees
                     WHERE project_id = $1 AND employee_id = $2 AND unit_id = $3`,
                    [projectId, empId, unitId]
                );
            if (existing.rows.length > 0) {
                results.push({ id: existing.rows[0].id, project_id: projectId, employee_id: empId, unit_id: unitId, duplicate: true });
                continue;
            }

            const r2 = await q(
                `INSERT INTO project_employees (project_id, employee_id, unit_id)
                 VALUES ($1, $2, $3)
                 RETURNING id, project_id, employee_id, unit_id`,
                [projectId, empId, unitId]
            );
            results.push(r2.rows[0]);
        }

        // Get the full updated employee list
        const employeeResult = await q(
            `SELECT e.id, e.employee_id, e.first_name, e.last_name, e.email, e.phone, 
              e.role, e.status, e.department_id, d.name as department_name,
              pe.unit_id, u.name as unit_name
             FROM project_employees pe
             JOIN employees e ON pe.employee_id = e.id
             LEFT JOIN departments d ON e.department_id = d.id
             LEFT JOIN project_units u ON u.id = pe.unit_id
             WHERE pe.project_id = $1 AND e.role != 'admin'
             ORDER BY e.first_name, e.last_name`,
            [projectId]
        );

        logAudit({
            actorId: req.user.id, action: 'project.assign', entityType: 'project',
            entityId: projectId,
            details: { assignments: list.map(a => ({ employeeId: parseInt(a.employeeId ?? a.employee_id, 10) || null, unitId: (a.unitId ?? a.unit_id) || null })) },
            ip: req.ip
        });

        res.json({ 
            success: true, 
            assigned: results.filter(r => r.id && !r.duplicate),
            totalAssigned: employeeResult.rows.length,
            employees: employeeResult.rows
        });
    } catch (error) {
        console.error('Error assigning employees to project:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

/**
 * DELETE /api/projects/:projectId/employees/:employeeId
 * Remove employee from project
 */
router.delete('/:projectId/employees/:employeeId', verifyToken, isAdmin, async (req, res) => {
    try {
        // Do NOT delete historical daily update data
        const result = await q(
            `DELETE FROM project_employees WHERE project_id = $1 AND employee_id = $2 RETURNING employee_id`,
            [req.params.projectId, req.params.employeeId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Employee not assigned to project' });
        }

        logAudit({
            actorId: req.user.id, action: 'project.unassign', entityType: 'project',
            entityId: req.params.projectId,
            details: { employeeId: Number(req.params.employeeId) }, ip: req.ip
        });

        res.json({ 
            success: true, 
            message: 'Employee removed from project successfully' 
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ============================================================
// UNITS (sub-projects)
// GET /:projectId/units — list units; assigned employees may read
// their own project's units too (the employee daily-update form needs it).
// ============================================================
router.get('/:projectId/units', verifyToken, async (req, res) => {
    try {
        const isAdminish = ['admin', 'hr', 'manager', 'team_lead'].includes(req.user.role);
        if (!isAdminish) {
            const chk = await q(
                `SELECT 1 FROM project_employees WHERE project_id = $1 AND employee_id = $2 LIMIT 1`,
                [req.params.projectId, req.user.id]
            );
            if (chk.rows.length === 0) {
                return res.status(403).json({ success: false, message: 'You are not assigned to this project' });
            }
        }
        const result = await q(
            `SELECT u.id, u.project_id, u.name, u.code, u.description, u.status, u.created_at,
                    (SELECT COUNT(*) FROM project_employees pe WHERE pe.unit_id = u.id) as employees_count
             FROM project_units u
             WHERE u.project_id = $1
             ORDER BY u.name`,
            [req.params.projectId]
        );
        res.json({ success: true, units: result.rows });
    } catch (error) {
        console.error('Error fetching project units:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

/**
 * GET /api/projects/:projectId/units/:unitId/employees
 * Roster of the employees assigned to one unit.
 */
router.get('/:projectId/units/:unitId/employees', verifyToken, isAdmin, async (req, res) => {
    try {
        const result = await q(
            `SELECT e.id, e.employee_id, e.first_name, e.last_name, e.role, e.status
             FROM project_employees pe
             JOIN employees e ON pe.employee_id = e.id
             WHERE pe.unit_id = $1 AND pe.project_id = $2 AND e.role != 'admin'
             ORDER BY e.first_name, e.last_name`,
            [req.params.unitId, req.params.projectId]
        );
        res.json({ success: true, employees: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

/**
 * POST /api/projects/:projectId/units
 * Create a unit (sub-project) under a project.
 */
router.post('/:projectId/units', verifyToken, isAdmin, async (req, res) => {
    try {
        const { name, code, description } = req.body;
        const unitName = name ? String(name).trim() : '';
        if (!unitName) {
            return res.status(400).json({ success: false, message: 'Unit name is required' });
        }
        const projectCheck = await q(`SELECT id FROM projects WHERE id = $1`, [req.params.projectId]);
        if (projectCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Project not found' });
        }
        const result = await q(
            `INSERT INTO project_units (project_id, name, code, description)
             VALUES ($1, $2, $3, $4)
             RETURNING id, project_id, name, code, description, status, created_at`,
            [req.params.projectId, unitName, code ? String(code).trim() : null, description || null]
        );
        logAudit({
            actorId: req.user.id, action: 'project.unit.create', entityType: 'project_unit',
            entityId: result.rows[0].id,
            details: { projectId: Number(req.params.projectId), name: result.rows[0].name }, ip: req.ip
        });
        res.json({ success: true, unit: result.rows[0], message: 'Unit created' });
    } catch (error) {
        console.error('Error creating project unit:', error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: (error && error.message) || r.message });
    }
});

/**
 * PUT /api/projects/:projectId/units/:unitId
 * Rename / update a unit.
 */
router.put('/:projectId/units/:unitId', verifyToken, isAdmin, async (req, res) => {
    try {
        const { name, code, description, status } = req.body;
        const row = await q(
            `UPDATE project_units
             SET name = COALESCE($1, name),
                 code = COALESCE($2, code),
                 description = COALESCE($3, description),
                 status = COALESCE($4, status),
                 updated_at = NOW()
             WHERE id = $5 AND project_id = $6
             RETURNING id, project_id, name, code, description, status`,
            [name ? String(name).trim() : null, code || null, description || null, status || null,
             req.params.unitId, req.params.projectId]
        );
        if (row.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Unit not found' });
        }
        logAudit({
            actorId: req.user.id, action: 'project.unit.update', entityType: 'project_unit',
            entityId: row.rows[0].id,
            details: { projectId: Number(req.params.projectId), name: row.rows[0].name }, ip: req.ip
        });
        res.json({ success: true, unit: row.rows[0], message: 'Unit updated' });
    } catch (error) {
        console.error('Error updating project unit:', error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: (error && error.message) || r.message });
    }
});

/**
 * DELETE /api/projects/:projectId/units/:unitId
 * Delete a unit. Assignment rows and daily updates keep their history: the
 * update rows' unit reference is set to NULL (FK ON DELETE SET NULL), and
 * assignment rows are merged to no-unit when possible (or dropped when a
 * no-unit row already exists) so the partial unique index stays satisfied.
 */
router.delete('/:projectId/units/:unitId', verifyToken, isAdmin, async (req, res) => {
    try {
        // Clear assignment references before deleting the unit. Relying on the
        // FK's ON DELETE SET NULL alone would collide with the partial unique
        // index uq_project_employees_no_unit when the employee already has a
        // no-unit assignment on this project (SET NULL would create a second
        // NULL row). So: null the reference when no other no-unit row exists,
        // otherwise remove the assignment row entirely.
        await q(
            `UPDATE project_employees pe
             SET unit_id = NULL
             WHERE pe.project_id = $1 AND pe.unit_id = $2
               AND NOT EXISTS (
                   SELECT 1 FROM project_employees pe2
                   WHERE pe2.project_id = pe.project_id
                     AND pe2.employee_id = pe.employee_id
                     AND pe2.unit_id IS NULL
                     AND pe2.id <> pe.id
               )`,
            [req.params.projectId, req.params.unitId]
        );
        await q(
            `DELETE FROM project_employees pe
             WHERE pe.project_id = $1 AND pe.unit_id = $2
               AND EXISTS (
                   SELECT 1 FROM project_employees pe2
                   WHERE pe2.project_id = pe.project_id
                     AND pe2.employee_id = pe.employee_id
                     AND pe2.unit_id IS NULL
                     AND pe2.id <> pe.id
               )`,
            [req.params.projectId, req.params.unitId]
        );
        const row = await q(
            `DELETE FROM project_units WHERE id = $1 AND project_id = $2 RETURNING id, name`,
            [req.params.unitId, req.params.projectId]
        );
        if (row.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Unit not found' });
        }
        logAudit({
            actorId: req.user.id, action: 'project.unit.delete', entityType: 'project_unit',
            entityId: row.rows[0].id,
            details: { projectId: Number(req.params.projectId), name: row.rows[0].name }, ip: req.ip
        });
        res.json({ success: true, message: 'Unit deleted' });
    } catch (error) {
        console.error('Error deleting project unit:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;