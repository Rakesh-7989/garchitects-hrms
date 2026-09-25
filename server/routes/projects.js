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
        res.json({ success: true, projects: result.rows });
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
             (SELECT COUNT(*) FROM project_employees pe WHERE pe.project_id = p.id) as employees_count
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
              e.role, e.status, e.department_id, d.name as department_name
             FROM project_employees pe
             JOIN employees e ON pe.employee_id = e.id
             LEFT JOIN departments d ON e.department_id = d.id
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
        const { employeeIds } = req.body;
        if (!employeeIds || !Array.isArray(employeeIds) || employeeIds.length === 0) {
            return res.status(400).json({ success: false, message: 'Employee IDs are required' });
        }
    
        // Check if project exists
        const projectCheck = await q(
            `SELECT id FROM projects WHERE id = $1`,
            [req.params.projectId]
        );
        if (projectCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Project not found' });
        }
    
        // Assign employees (idempotent - uses ON CONFLICT pattern)
        const results = [];
        for (const empId of employeeIds) {
            const result = await q(
                `INSERT INTO project_employees (project_id, employee_id) 
                 VALUES ($1, $2) 
                 ON CONFLICT (project_id, employee_id) DO NOTHING 
                 RETURNING id, project_id, employee_id`,
                [req.params.projectId, empId]
            );
            results.push(result.rows[0]);
        }
    
        // Get the full updated employee list
        const employeeResult = await q(
            `SELECT e.id, e.employee_id, e.first_name, e.last_name, e.email, e.phone, 
              e.role, e.status, e.department_id, d.name as department_name
             FROM project_employees pe
             JOIN employees e ON pe.employee_id = e.id
             LEFT JOIN departments d ON e.department_id = d.id
             WHERE pe.project_id = $1 AND e.role != 'admin'
             ORDER BY e.first_name, e.last_name`,
            [req.params.projectId]
        );
    
        logAudit({
            actorId: req.user.id, action: 'project.assign', entityType: 'project',
            entityId: req.params.projectId,
            details: { employeeIds: Array.isArray(employeeIds) ? employeeIds.map(Number) : employeeIds },
            ip: req.ip
        });

        res.json({ 
            success: true, 
            assigned: results.filter(r => r.id),
            totalAssigned: employeeResult.rows.length,
            employees: employeeResult.rows
        });
    } catch (error) {
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

module.exports = router;