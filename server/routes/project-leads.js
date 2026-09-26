// ============================================================
// PROJECT LEADS (P9) — delegated project/unit ownership.
//
// Designations (D6): admin / manager / hr choose a lead (D7: active team_lead
// or manager) for a project. unit_id NULL = whole-project lead (all current +
// future units auto-follow, D9); unit_id set = that unit only. Several leads
// may share a project.
//
// Placement (D8): the LEAD route /place enforces "my team + my units" — a
// team_lead/manager may place only their reporting-tree employees into the
// project/units they lead. admin/hr bypass (they retain P8 power); the P8
// general route /api/projects/:projectId/employees stays D5-unrestricted.
// ============================================================
const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken, isManager } = require('../middleware/auth');
const { runWithSchemaRepair, pgErrorResponse } = require('../utils/schemaRepair');
const { logAudit } = require('../utils/audit');

// Self-healing query wrapper (creates missing tables on cold instances).
const q = (sql, params) => runWithSchemaRepair(() => query(sql, params));

// Designation power (D6): admin / manager / hr only (team_lead cannot designate).
const DESIGNATOR_ROLES = ['admin', 'hr', 'manager'];

function isDesignator(role) {
    return DESIGNATOR_ROLES.includes(role);
}

// Reporting-tree of `me` (recursive chain via reporting_manager_id, self excluded).
async function myTreeIds(meId) {
    const r = await q(
        `WITH RECURSIVE tree AS (
            SELECT id FROM employees WHERE reporting_manager_id = $1 AND status = 'active' AND id <> $1
            UNION
            SELECT e.id FROM employees e JOIN tree t ON e.reporting_manager_id = t.id
            WHERE e.status = 'active'
        ) SELECT id FROM tree`,
        [meId]
    );
    return new Set(r.rows.map(x => x.id));
}

async function leadCovers(projectId, unitId, meId) {
    // Whole-project row grants everything.
    const whole = await q(
        `SELECT 1 FROM project_leads WHERE project_id = $1 AND lead_id = $2 AND unit_id IS NULL LIMIT 1`,
        [projectId, meId]
    );
    if (whole.rows.length > 0) return true;
    if (unitId) {
        const unit = await q(
            `SELECT 1 FROM project_leads WHERE project_id = $1 AND unit_id = $2 AND lead_id = $3 LIMIT 1`,
            [projectId, unitId, meId]
        );
        if (unit.rows.length > 0) return true;
    }
    return false;
}

// ============================================================
// GET /api/project-leads/my-team — the caller's placement pool.
// team_lead/manager → their reporting tree (mirrors /place enforcement);
// admin/hr → all active non-admin employees (elevated, D8).
// ============================================================
router.get('/my-team', verifyToken, async (req, res) => {
    try {
        const role = req.user.role;
        let rows;
        if (role === 'admin' || role === 'hr') {
            rows = (await q(
                `SELECT e.id, e.employee_id, e.first_name, e.last_name, d.name AS department_name, g.name AS designation_name
                 FROM employees e
                 LEFT JOIN departments d ON d.id = e.department_id
                 LEFT JOIN designations g ON g.id = e.designation_id
                 WHERE e.status = 'active' AND e.role != 'admin' AND e.id <> $1
                 ORDER BY e.first_name, e.last_name`,
                [req.user.id]
            )).rows;
        } else {
            rows = (await q(
                `WITH RECURSIVE tree AS (
                    SELECT e.id FROM employees e WHERE e.reporting_manager_id = $1 AND e.status = 'active' AND e.id <> $1
                    UNION
                    SELECT e.id FROM employees e JOIN tree t ON e.reporting_manager_id = t.id WHERE e.status = 'active'
                )
                SELECT e.id, e.employee_id, e.first_name, e.last_name, d.name AS department_name, g.name AS designation_name
                FROM tree t
                JOIN employees e ON e.id = t.id
                LEFT JOIN departments d ON d.id = e.department_id
                LEFT JOIN designations g ON g.id = e.designation_id
                ORDER BY e.first_name, e.last_name`,
                [req.user.id]
            )).rows;
        }
        res.json({ success: true, team: rows });
    } catch (error) {
        console.error('Error listing placement team:', error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

// ============================================================
// GET /api/project-leads/leads-options — eligible lead candidates.
// ============================================================
router.get('/leads-options', verifyToken, async (req, res) => {
    if (!isDesignator(req.user.role)) {
        return res.status(403).json({ success: false, message: 'Only admin/manager/hr can view lead candidates' });
    }
    try {
        const r = await q(
            `SELECT e.id, e.employee_id, e.first_name, e.last_name, e.role
             FROM employees e
             WHERE e.status = 'active' AND e.role IN ('team_lead','manager') AND e.id <> $1
             ORDER BY e.first_name, e.last_name`,
            [req.user.id]
        );
        res.json({ success: true, leads: r.rows });
    } catch (error) {
        console.error('Error listing lead options:', error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

// ============================================================
// GET /api/project-leads — all designations (overview).
// ============================================================
router.get('/', verifyToken, async (req, res) => {
    if (!isDesignator(req.user.role)) {
        return res.status(403).json({ success: false, message: 'Only admin/manager/hr can view project leads' });
    }
    try {
        const r = await q(
            `SELECT pl.id, pl.project_id, p.name AS project_name, p.status AS project_status,
                    pl.lead_id, e.employee_id, e.first_name, e.last_name, e.role AS lead_role,
                    pl.unit_id, u.name AS unit_name, pl.assigned_at,
                    ab.employee_id AS assigned_by_code, ab.first_name AS assigned_by_first, ab.last_name AS assigned_by_last
             FROM project_leads pl
             JOIN projects p ON p.id = pl.project_id
             JOIN employees e ON e.id = pl.lead_id
             LEFT JOIN project_units u ON u.id = pl.unit_id
             LEFT JOIN employees ab ON ab.id = pl.assigned_by
             ORDER BY p.name, pl.id`
        );
        res.json({ success: true, leadLinks: r.rows });
    } catch (error) {
        console.error('Error listing project leads:', error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

// ============================================================
// GET /api/project-leads/mine — the caller's led projects + units + counts.
// ============================================================
router.get('/mine', verifyToken, async (req, res) => {
    try {
        // My designation rows (project-level and/or unit-level).
        const rows = await q(
            `SELECT pl.project_id, pl.unit_id
             FROM project_leads pl
             WHERE pl.lead_id = $1
             ORDER BY pl.id`,
            [req.user.id]
        );
        const projectIds = [...new Set(rows.rows.map(r => r.project_id))];
        const led = [];
        for (const pid of projectIds) {
            const wholeProject = rows.rows.some(r => r.project_id === pid && r.unit_id === null);
            const projRes = await q(
                `SELECT p.id, p.name, p.status FROM projects p WHERE p.id = $1`,
                [pid]
            );
            if (projRes.rows.length === 0) continue;
            const p = projRes.rows[0];

            let unitRows;
            if (wholeProject) {
                // Owns the whole project → every unit + project-level placement.
                const u = await q(
                    `SELECT u.id, u.name, u.status FROM project_units u WHERE u.project_id = $1 AND u.status = 'active' ORDER BY u.name`,
                    [pid]
                );
                unitRows = u.rows;
            } else {
                // Unit-scoped: only the designated units.
                const unitIds = rows.rows.filter(r => r.project_id === pid && r.unit_id !== null).map(r => r.unit_id);
                const u = await q(
                    `SELECT u.id, u.name, u.status FROM project_units u WHERE u.project_id = $1 AND u.id = ANY($2::int[]) AND u.status = 'active' ORDER BY u.name`,
                    [pid, unitIds]
                );
                unitRows = u.rows;
            }

            // Member counts: per unit + project-level (no-unit).
            const counts = await q(
                `SELECT unit_id, COUNT(*) AS n FROM project_employees pe WHERE pe.project_id = $1 GROUP BY pe.unit_id`,
                [pid]
            );
            const countMap = {};
            for (const c of counts.rows) countMap[c.unit_id === null ? 'null' : c.unit_id] = parseInt(c.n, 10);

            led.push({
                projectId: p.id,
                projectName: p.name,
                projectStatus: p.status,
                wholeProject,
                projectLevelCount: countMap['null'] || 0,
                units: unitRows.map(u => ({
                    id: u.id,
                    name: u.name,
                    status: u.status,
                    memberCount: countMap[u.id] || 0
                }))
            });
        }
        res.json({ success: true, led });
    } catch (error) {
        console.error('Error listing my led projects:', error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

// ============================================================
// POST /api/project-leads — designate a lead.
// body: { projectId, leadId, unitIds?: number[] }  — empty/omitted = whole project.
// ============================================================
router.post('/', verifyToken, async (req, res) => {
    if (!isDesignator(req.user.role)) {
        return res.status(403).json({ success: false, message: 'Only admin/manager/hr can assign project leads' });
    }
    try {
        const projectId = parseInt(req.body.projectId, 10);
        const leadId = parseInt(req.body.leadId, 10);
        if (isNaN(projectId) || isNaN(leadId)) {
            return res.status(400).json({ success: false, message: 'projectId and leadId are required' });
        }

        const proj = await q(`SELECT id, name FROM projects WHERE id = $1`, [projectId]);
        if (proj.rows.length === 0) return res.status(404).json({ success: false, message: 'Project not found' });

        const lead = await q(
            `SELECT id, employee_id, first_name, last_name, role, status FROM employees WHERE id = $1`,
            [leadId]
        );
        if (lead.rows.length === 0) return res.status(404).json({ success: false, message: 'Lead employee not found' });
        const L = lead.rows[0];
        if (L.status !== 'active') return res.status(400).json({ success: false, message: 'Lead must be an active employee' });
        if (!['team_lead', 'manager'].includes(L.role)) {
            return res.status(400).json({ success: false, message: 'Project lead must be a team_lead or manager' });
        }

        const rawUnits = Array.isArray(req.body.unitIds) ? req.body.unitIds : [];
        const unitIds = [...new Set(rawUnits.map(u => parseInt(u, 10)).filter(u => !isNaN(u)))];

        let created = [];
        if (unitIds.length === 0) {
            // Whole-project lead.
            const dup = await q(
                `SELECT 1 FROM project_leads WHERE project_id = $1 AND lead_id = $2 AND unit_id IS NULL`,
                [projectId, leadId]
            );
            if (dup.rows.length > 0) {
                return res.status(409).json({ success: false, message: 'This lead already owns the whole project' });
            }
            const ins = await q(
                `INSERT INTO project_leads (project_id, lead_id, unit_id, assigned_by)
                 VALUES ($1, $2, NULL, $3) RETURNING id, project_id, lead_id, unit_id`,
                [projectId, leadId, req.user.id]
            );
            created = ins.rows;
        } else {
            // Units must belong to the project.
            const units = await q(
                `SELECT id FROM project_units WHERE project_id = $1 AND id = ANY($2::int[])`,
                [projectId, unitIds]
            );
            const found = new Set(units.rows.map(r => r.id));
            const bad = unitIds.find(u => !found.has(u));
            if (bad !== undefined) {
                return res.status(400).json({ success: false, message: `Unit ${bad} does not belong to this project` });
            }
            for (const uid of unitIds) {
                const dup = await q(
                    `SELECT 1 FROM project_leads WHERE project_id = $1 AND unit_id = $2 AND lead_id = $3`,
                    [projectId, uid, leadId]
                );
                if (dup.rows.length > 0) continue; // already leads this unit
                const ins = await q(
                    `INSERT INTO project_leads (project_id, lead_id, unit_id, assigned_by)
                     VALUES ($1, $2, $3, $4) RETURNING id, project_id, lead_id, unit_id`,
                    [projectId, leadId, uid, req.user.id]
                );
                created.push(...ins.rows);
            }
            if (created.length === 0) {
                return res.status(409).json({ success: false, message: 'This lead already leads every selected unit' });
            }
        }

        logAudit({
            actorId: req.user.id, action: 'project.lead_designate', entityType: 'project',
            entityId: projectId,
            details: { leadId, leadEmployeeId: L.employee_id, unitIds: unitIds.length ? unitIds : null, scope: unitIds.length ? 'units' : 'project' },
            ip: req.ip
        });

        res.status(201).json({
            success: true,
            message: L.first_name + ' ' + (L.last_name || '') + ' is now ' + (unitIds.length ? 'a unit lead' : 'the project lead') + ' of ' + proj.rows[0].name,
            created
        });
    } catch (error) {
        console.error('Error designating project lead:', error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

// ============================================================
// DELETE /api/project-leads/:id — remove a designation link.
// ============================================================
router.delete('/:id', verifyToken, async (req, res) => {
    if (!isDesignator(req.user.role)) {
        return res.status(403).json({ success: false, message: 'Only admin/manager/hr can remove project leads' });
    }
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ success: false, message: 'Invalid lead-link id' });
        const r = await q(
            `DELETE FROM project_leads WHERE id = $1 RETURNING id, project_id, lead_id, unit_id`,
            [id]
        );
        if (r.rows.length === 0) return res.status(404).json({ success: false, message: 'Lead link not found' });
        logAudit({
            actorId: req.user.id, action: 'project.lead_unassign', entityType: 'project',
            entityId: r.rows[0].project_id,
            details: { leadId: r.rows[0].lead_id, unitId: r.rows[0].unit_id }, ip: req.ip
        });
        res.json({ success: true, message: 'Lead removed' });
    } catch (error) {
        console.error('Error removing project lead:', error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

// ============================================================
// POST /api/project-leads/place — lead places their team into their units.
// body: { projectId, unitId?: number|null, employeeIds: number[] }
// D8 scope: non-admin/hr actors must lead the target (project-level or unit)
// AND every placed employee must be in their reporting tree.
// ============================================================
router.post('/place', verifyToken, isManager, async (req, res) => {
    try {
        const projectId = parseInt(req.body.projectId, 10);
        const rawUnit = req.body.unitId;
        const unitId = (rawUnit === null || rawUnit === undefined || rawUnit === '') ? null : parseInt(rawUnit, 10);
        const employeeIds = Array.isArray(req.body.employeeIds) ? req.body.employeeIds.map(x => parseInt(x, 10)).filter(x => !isNaN(x)) : [];

        if (isNaN(projectId)) return res.status(400).json({ success: false, message: 'projectId required' });
        if (employeeIds.length === 0) return res.status(400).json({ success: false, message: 'Select at least one employee' });
        if (unitId !== null && isNaN(unitId)) return res.status(400).json({ success: false, message: 'Invalid unit' });

        const proj = await q(`SELECT id FROM projects WHERE id = $1`, [projectId]);
        if (proj.rows.length === 0) return res.status(404).json({ success: false, message: 'Project not found' });

        if (unitId !== null) {
            const u = await q(`SELECT 1 FROM project_units WHERE id = $1 AND project_id = $2`, [unitId, projectId]);
            if (u.rows.length === 0) return res.status(400).json({ success: false, message: 'Unit does not belong to this project' });
        }

        const role = req.user.role;
        const isElevated = ['admin', 'hr'].includes(role);

        if (!isElevated) {
            // Non admin/hr: must be a lead covering the target (manager too, D8).
            const covers = await leadCovers(projectId, unitId, req.user.id);
            if (!covers) {
                return res.status(403).json({ success: false, message: 'You are not the lead of this project/unit' });
            }
            // Team check: every placed employee must be in my reporting tree.
            const tree = await myTreeIds(req.user.id);
            const emp = await q(
                `SELECT id, status FROM employees WHERE id = ANY($1::int[]) AND role != 'admin'`,
                [employeeIds]
            );
            const found = new Set(emp.rows.map(r => r.id));
            for (const id of employeeIds) {
                const row = emp.rows.find(r => r.id === id);
                if (!row || row.status !== 'active') {
                    return res.status(400).json({ success: false, message: `Employee ${id} is not active` });
                }
                if (!tree.has(id)) {
                    return res.status(403).json({ success: false, message: 'You can only place your own team members' });
                }
                if (!found.has(id)) continue;
            }
        } else {
            // admin/hr: any active non-admin employee.
            const emp = await q(
                `SELECT id, status FROM employees WHERE id = ANY($1::int[]) AND role != 'admin'`,
                [employeeIds]
            );
            for (const id of employeeIds) {
                const row = emp.rows.find(r => r.id === id);
                if (!row || row.status !== 'active') {
                    return res.status(400).json({ success: false, message: `Employee ${id} is not active` });
                }
            }
        }

        // Idempotent inserts honoring the partial uniques.
        const assigned = [];
        for (const empId of employeeIds) {
            const existing = unitId === null
                ? await q(`SELECT id FROM project_employees WHERE project_id = $1 AND employee_id = $2 AND unit_id IS NULL`, [projectId, empId])
                : await q(`SELECT id FROM project_employees WHERE project_id = $1 AND employee_id = $2 AND unit_id = $3`, [projectId, empId, unitId]);
            if (existing.rows.length > 0) continue; // already placed here
            const ins = await q(
                `INSERT INTO project_employees (project_id, employee_id, unit_id)
                 VALUES ($1, $2, $3) RETURNING id, project_id, employee_id, unit_id`,
                [projectId, empId, unitId]
            );
            assigned.push(...ins.rows);
        }

        logAudit({
            actorId: req.user.id, action: 'project.lead_place', entityType: 'project',
            entityId: projectId,
            details: { unitId, employeeIds: employeeIds.map(Number) }, ip: req.ip
        });

        res.status(201).json({ success: true, assigned, message: `Placed ${assigned.length} of ${employeeIds.length} member(s)` });
    } catch (error) {
        console.error('Error placing lead team:', error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

module.exports = router;