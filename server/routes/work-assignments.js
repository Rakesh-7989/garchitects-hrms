const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken, isManager } = require('../middleware/auth');
const { runWithSchemaRepair, pgErrorResponse } = require('../utils/schemaRepair');
const { logAudit } = require('../utils/audit');
const { notify, managerIdsOf } = require('../services/notify');
const { dateOnly } = require('../utils/date');
const { leadCovers, myTreeIds } = require('./project-leads');

// Self-healing query wrapper (mirrors sibling project routes).
const q = (sql, params) => runWithSchemaRepair(() => query(sql, params));

const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const STATUSES = ['assigned', 'in_progress', 'completed', 'cancelled'];
// Legal status moves for the ASSIGNEE (assigner/admin may use the same table).
const LEGAL_MOVES = {
    assigned: ['in_progress', 'completed', 'cancelled'],
    in_progress: ['completed', 'cancelled'],
    completed: [],
    cancelled: []
};

// Shared SELECT: joins project / unit / assigner / assignee names.
const SELECT = `
    SELECT wa.id, wa.project_id, wa.unit_id, wa.assigned_by, wa.assigned_to,
           wa.title, wa.description, wa.priority, wa.start_date, wa.due_date, wa.status,
           wa.completed_at, wa.assigned_at, wa.created_at, wa.updated_at,
           p.name as project_name,
           u.name as unit_name,
           ab.first_name as assigned_by_first, ab.last_name as assigned_by_last,
           ab.employee_id as assigned_by_code,
           at2.first_name as assigned_to_first, at2.last_name as assigned_to_last,
           at2.employee_id as assigned_to_code
    FROM work_assignments wa
    LEFT JOIN projects p ON p.id = wa.project_id
    LEFT JOIN project_units u ON u.id = wa.unit_id
    JOIN employees ab ON ab.id = wa.assigned_by
    JOIN employees at2 ON at2.id = wa.assigned_to`;

function canMove(from, to) {
    if (!STATUSES.includes(to)) return false;
    if (from === to) return true; // no-op allowed
    return (LEGAL_MOVES[from] || []).includes(to);
}

// Parse + validate a project/unit pair (shared by POST and PUT).
// Returns { ok:true, proj, unit } or { ok:false, status, message }.
function parseProjectUnit(projectId, unitId) {
    const proj = (projectId === undefined || projectId === null || projectId === '')
        ? null : parseInt(projectId, 10);
    let unit = (unitId === undefined || unitId === null || unitId === '')
        ? null : parseInt(unitId, 10);
    if (proj !== null && isNaN(proj)) return { ok: false, status: 400, message: 'Invalid project id' };
    if (unit !== null && isNaN(unit)) return { ok: false, status: 400, message: 'Invalid unit id' };
    if (unit !== null && proj === null) return { ok: false, status: 400, message: 'unitId requires projectId' };
    return { ok: true, proj, unit };
}

// Validate that the unit actually belongs to the project (async).
async function validateProjectUnit(proj, unit) {
    if (proj === null) return null;
    const pr = await q(`SELECT id FROM projects WHERE id = $1`, [proj]);
    if (pr.rows.length === 0) return { status: 404, message: 'Project not found' };
    if (unit !== null) {
        const u = await q(`SELECT id FROM project_units WHERE id = $1 AND project_id = $2`, [unit, proj]);
        if (u.rows.length === 0) return { status: 400, message: 'Unit does not belong to the selected project' };
    }
    return null;
}

/**
 * GET /api/work-assignments
 * Role-scoped listing (D3: no reporting-tree enforcement):
 * - admin / hr: every assignment (optional ?status= ?assignedTo= ?projectId=)
 * - manager / team_lead: the assignments THEY created
 */
router.get('/my', verifyToken, async (req, res) => {
    try {
        const result = await q(`${SELECT} WHERE wa.assigned_to = $1 ORDER BY wa.created_at DESC`, [req.user.id]);
        res.json({ success: true, assignments: result.rows });
    } catch (error) {
        console.error('Error fetching my work assignments:', error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

router.get('/', verifyToken, isManager, async (req, res) => {
    try {
        const overlord = req.user.role === 'admin' || req.user.role === 'hr';
        const { status, assignedTo, projectId } = req.query;
        const conditions = [];
        const params = [];
        let p = 0;
        if (!overlord) {
            p++;
            conditions.push(`wa.assigned_by = $${p}`);
            params.push(req.user.id);
        }
        if (status) { p++; conditions.push(`wa.status = $${p}`); params.push(status); }
        if (assignedTo) { p++; conditions.push(`wa.assigned_to = $${p}`); params.push(assignedTo); }
        if (projectId) { p++; conditions.push(`wa.project_id = $${p}`); params.push(projectId); }
        const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
        const result = await q(`${SELECT} ${where} ORDER BY wa.created_at DESC`, params);
        res.json({ success: true, assignments: result.rows });
    } catch (error) {
        console.error('Error listing work assignments:', error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

/**
 * GET /api/work-assignments/projects
 * Lightweight project list for the assignment picker (project dropdown).
 * Scoped to isManager (same guard as POST /) so team_lead/manager/hr/admin
 * can assign to any project without needing the admin-only /api/projects.
 */
router.get('/projects', verifyToken, isManager, async (req, res) => {
    try {
        // P9/D11 parallel: a team_lead may pick only the projects they lead
        // (project-level row → project; unit rows → the project too, units are
        // scoped separately via GET /projects/:id/units).
        if (req.user.role === 'team_lead') {
            const result = await q(
                `SELECT DISTINCT p.id, p.name, p.status
                 FROM project_leads pl JOIN projects p ON p.id = pl.project_id
                 WHERE pl.lead_id = $1
                 ORDER BY p.name`,
                [req.user.id]
            );
            return res.json({ success: true, projects: result.rows });
        }
        const result = await q(
            `SELECT id, name, status FROM projects
             ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'on_hold' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END, name`
        );
        res.json({ success: true, projects: result.rows });
    } catch (error) {
        console.error('Error listing projects for assignment picker:', error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

/**
 * POST /api/work-assignments
 * Create an assignment. Any team_lead/manager/hr/admin may assign to ANY active
 * employee (D3 — no reporting-tree restriction).
 * body: { assignedTo, projectId?, unitId?, title, description?, priority?, dueDate?, status? }
 */
router.post('/', verifyToken, isManager, async (req, res) => {
    try {
        const { assignedTo, projectId, unitId, title, description, priority, dueDate, status } = req.body;

        if (!title || String(title).trim().length === 0) {
            return res.status(400).json({ success: false, message: 'Task title is required' });
        }
        const to = parseInt(assignedTo, 10);
        if (isNaN(to)) return res.status(400).json({ success: false, message: 'assignedTo employee is required' });

        const pu = parseProjectUnit(projectId, unitId);
        if (!pu.ok) return res.status(pu.status).json({ success: false, message: pu.message });
        const proj = pu.proj, unit = pu.unit;

        const prio = priority || 'normal';
        if (!PRIORITIES.includes(prio)) return res.status(400).json({ success: false, message: 'Invalid priority (low/normal/high/urgent)' });

        // Start Date and Expected End Date (Due Date) are MANDATORY for accountability
        let start = null;
        if (!startDate || String(startDate).trim() === '') {
            return res.status(400).json({ success: false, message: 'Start date is required' });
        }
        start = String(startDate).slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) {
            return res.status(400).json({ success: false, message: 'Invalid start date (YYYY-MM-DD)' });
        }

        let due = null;
        if (!dueDate || String(dueDate).trim() === '') {
            return res.status(400).json({ success: false, message: 'Expected end date (Due date) is required' });
        }
        due = String(dueDate).slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) {
            return res.status(400).json({ success: false, message: 'Invalid due date (YYYY-MM-DD)' });
        }
        if (due < start) {
            return res.status(400).json({ success: false, message: 'Expected end date cannot be before start date' });
        }
        const st = status || 'assigned';
        if (!STATUSES.includes(st)) return res.status(400).json({ success: false, message: 'Invalid status' });

        // Assignee must exist and be active.
        const emp = await q(`SELECT id, status, employee_id FROM employees WHERE id = $1`, [to]);
        if (emp.rows.length === 0) return res.status(404).json({ success: false, message: 'Assigned employee not found' });
        if (emp.rows[0].status !== 'active') return res.status(400).json({ success: false, message: 'Assignments can only be created for active employees' });

        const puErr = await validateProjectUnit(proj, unit);
        if (puErr) return res.status(puErr.status).json({ success: false, message: puErr.message });

        // P9/D11 parallel: a team_lead may only assign work to their reporting
        // tree, and only onto projects/units they lead. A project-less task has
        // no project boundary, so the tree rule alone applies. Managers/admin/hr
        // keep the D3 general power.
        if (req.user.role === 'team_lead') {
            const tree = await myTreeIds(req.user.id);
            if (!tree.has(to)) {
                return res.status(403).json({ success: false, message: 'You can only assign work to your own team members' });
            }
            if (proj !== null) {
                const covers = await leadCovers(proj, unit, req.user.id);
                if (!covers) {
                    return res.status(403).json({ success: false, message: 'You can only assign work on projects/units you lead' });
                }
            }
        }

        // Duplicate-open warning: same assignee + project + title already open.
        const dup = await q(
            `SELECT id FROM work_assignments
             WHERE assigned_to = $1 AND status IN ('assigned','in_progress')
               AND LOWER(title) = LOWER($2)
               AND project_id IS NOT DISTINCT FROM $3`,
            [to, String(title).trim(), proj]
        );
        if (dup.rows.length > 0) {
            return res.status(409).json({
                success: false,
                message: 'An open assignment with the same title already exists for this employee on this project'
            });
        }

        const ins = await q(
            `INSERT INTO work_assignments
                (project_id, unit_id, assigned_by, assigned_to, title, description, priority, start_date, due_date, status, completed_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING id`,
            [proj, unit, req.user.id, to, String(title).trim(), description || null, prio, start, due, st,
             st === 'completed' ? new Date() : null]
        );

        logAudit({
            actorId: req.user.id, action: 'work.assign', entityType: 'work_assignment',
            entityId: ins.rows[0].id,
            details: { assignedTo: to, projectId: proj, unitId: unit, title: String(title).trim(), priority: prio, status: st },
            ip: req.ip
        });

        const full = await q(`${SELECT} WHERE wa.id = $1`, [ins.rows[0].id]);

        // Tell the assignee. Previously the row was written, audited and returned
        // with no signal to the person who now owns the work - the only way to
        // learn about it was to open My Work and look.
        const row = full.rows[0] || {};
        const by = [row.assigned_by_first, row.assigned_by_last].filter(Boolean).join(' ') || 'Your lead';
        const whereBits = [row.project_name, row.unit_name].filter(Boolean).join(' · ');
        const dueBits = [];
        if (prio === 'urgent' || prio === 'high') dueBits.push(`${prio.toUpperCase()} priority`);
        if (due) dueBits.push(`due ${due}`);
        notify({
            employeeId: to,
            type: 'work_assigned',
            title: `New work assigned: ${String(title).trim()}`,
            body: `By ${by}` + (whereBits ? ' · ' + whereBits : '')
                + (dueBits.length ? ' · ' + dueBits.join(' · ') : '')
                + (description ? `\n${description}` : ''),
            url: '/employee/my-work',
            entityType: 'work_assignment',
            entityId: ins.rows[0].id,
            actorId: req.user.id
        }).catch(() => {});

        res.status(201).json({ success: true, message: 'Work assigned', assignment: full.rows[0] });
    } catch (error) {
        console.error('Error creating work assignment:', error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

/**
 * PUT /api/work-assignments/:id
 * - Assignee: may only change status (assigned → in_progress → completed/cancelled)
 * - Assigner or admin/hr: full edit (details + status)
 */
router.put('/:id', verifyToken, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ success: false, message: 'Invalid assignment id' });

        const cur = await q(`SELECT * FROM work_assignments WHERE id = $1`, [id]);
        if (cur.rows.length === 0) return res.status(404).json({ success: false, message: 'Assignment not found' });
        const row = cur.rows[0];

        const isAssignee = Number(row.assigned_to) === Number(req.user.id);
        const isAssigner = Number(row.assigned_by) === Number(req.user.id);
        const overlord = req.user.role === 'admin' || req.user.role === 'hr';
        if (!isAssignee && !isAssigner && !overlord) {
            return res.status(403).json({ success: false, message: 'Access denied. Only the assigner, the assignee, or admin can update this assignment.' });
        }

        const { status, title, description, priority, dueDate, projectId, unitId, assignedTo } = req.body;
        const changes = {};

        if (status !== undefined && status !== null) {
            if (!canMove(row.status, status)) {
                return res.status(400).json({ success: false, message: `Cannot move assignment from '${row.status}' to '${status}'` });
            }
            changes.status = status;
            changes.completed_at = status === 'completed' ? new Date() : null;
        }

        // Assignee may ONLY change status.
        if (isAssignee && !isAssigner && !overlord) {
            const extra = Object.keys(req.body).filter(k => k !== 'status');
            if (extra.length > 0) {
                return res.status(400).json({ success: false, message: 'Assignees may only update the status' });
            }
        } else {
            if (title !== undefined && title !== null) {
                if (String(title).trim().length === 0) return res.status(400).json({ success: false, message: 'Task title is required' });
                changes.title = String(title).trim();
            }
            if (description !== undefined && description !== null) changes.description = description;
            if (priority !== undefined && priority !== null) {
                if (!PRIORITIES.includes(priority)) return res.status(400).json({ success: false, message: 'Invalid priority (low/normal/high/urgent)' });
                changes.priority = priority;
            }
            if (startDate !== undefined && startDate !== null && String(startDate).trim() !== '') {
                const s = String(startDate).slice(0, 10);
                if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return res.status(400).json({ success: false, message: 'Invalid start date (YYYY-MM-DD)' });
                changes.start_date = s;
            } else if (startDate !== undefined) {
                return res.status(400).json({ success: false, message: 'Start date is required and cannot be cleared' });
            }

            if (dueDate !== undefined && dueDate !== null && String(dueDate).trim() !== '') {
                const due = String(dueDate).slice(0, 10);
                if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return res.status(400).json({ success: false, message: 'Invalid due date (YYYY-MM-DD)' });
                changes.due_date = due;
            } else if (dueDate !== undefined) {
                return res.status(400).json({ success: false, message: 'Expected end date (Due date) is required and cannot be cleared' });
            }

            // Validate timeline if both exist (after setting changes)
            const finalStart = changes.start_date || row.start_date;
            const finalDue = changes.due_date || row.due_date;
            if (finalStart && finalDue && finalDue < finalStart) {
                return res.status(400).json({ success: false, message: 'Expected end date cannot be before start date' });
            }
            if (projectId !== undefined || unitId !== undefined) {
                const pu = parseProjectUnit(projectId, unitId);
                if (!pu.ok) return res.status(pu.status).json({ success: false, message: pu.message });
                const puErr = await validateProjectUnit(pu.proj, pu.unit);
                if (puErr) return res.status(puErr.status).json({ success: false, message: puErr.message });
                // P9/D11 parallel: a team_lead assigner may not move the work
                // onto a project/unit they do not lead.
                if (req.user.role === 'team_lead' && pu.proj !== null) {
                    const covers = await leadCovers(pu.proj, pu.unit, req.user.id);
                    if (!covers) {
                        return res.status(403).json({ success: false, message: 'You can only assign work on projects/units you lead' });
                    }
                }
                changes.project_id = pu.proj;
                changes.unit_id = pu.unit;
            }
            if (assignedTo !== undefined && assignedTo !== null && assignedTo !== '') {
                const to = parseInt(assignedTo, 10);
                if (isNaN(to)) return res.status(400).json({ success: false, message: 'Invalid assignedTo employee' });
                const emp = await q(`SELECT id, status FROM employees WHERE id = $1`, [to]);
                if (emp.rows.length === 0) return res.status(404).json({ success: false, message: 'Assigned employee not found' });
                if (emp.rows[0].status !== 'active') return res.status(400).json({ success: false, message: 'Assignments can only target active employees' });
                // P9/D11 parallel: a team_lead assigner may only reassign within
                // their reporting tree.
                if (req.user.role === 'team_lead') {
                    const tree = await myTreeIds(req.user.id);
                    if (!tree.has(to)) {
                        return res.status(403).json({ success: false, message: 'You can only reassign within your own team' });
                    }
                }
                changes.assigned_to = to;
            }
        }

        if (Object.keys(changes).length === 0) {
            return res.status(400).json({ success: false, message: 'No changes to apply' });
        }

        const colMap = { status: 'status', title: 'title', description: 'description', priority: 'priority', start_date: 'start_date', due_date: 'due_date', project_id: 'project_id', unit_id: 'unit_id', assigned_to: 'assigned_to', completed_at: 'completed_at' };
        const sets = ['updated_at = NOW()'];
        const vals = [];
        let p = 1;
        for (const k of Object.keys(changes)) {
            sets.push(`${colMap[k]} = $${p}`);
            vals.push(changes[k]);
            p++;
        }
        vals.push(id);
        await q(`UPDATE work_assignments SET ${sets.join(', ')} WHERE id = $${p}`, vals);

        logAudit({
            actorId: req.user.id, action: 'work.assign_update', entityType: 'work_assignment',
            entityId: id, details: changes, ip: req.ip
        });

        const full = await q(`${SELECT} WHERE wa.id = $1`, [id]);
        const after = full.rows[0] || {};

        // Report progress back up. When the person doing the work closes it out,
        // whoever assigned it is the one who needs to know - previously the only
        // signal was the status flipping in a list someone had to remember to
        // re-open.
        const newStatus = changes.status;
        if (newStatus && newStatus !== row.status && (newStatus === 'completed' || newStatus === 'cancelled' || newStatus === 'in_progress')) {
            // Name who actually did it. An assigner/admin may also move the
            // status, so crediting the assignee for it would be a lie in the
            // manager's feed.
            const actorIsAssignee = Number(req.user.id) === Number(after.assigned_to);
            // req.user carries the JWT payload (id, employee_id, email, role, name) —
            // NOT first_name/last_name, so do not reach for those here.
            const actorName = actorIsAssignee
                ? ([after.assigned_to_first, after.assigned_to_last].filter(Boolean).join(' ') || 'The assignee')
                : (req.user.name || [after.assigned_by_first, after.assigned_by_last].filter(Boolean).join(' ')
                    || req.user.employee_id || 'Someone');
            const done = newStatus === 'completed';
            const cancelled = newStatus === 'cancelled';
            const verb = done ? 'completed' : cancelled ? 'cancelled' : 'started';
            // The assigner hears about it; when the assigner updated it
            // themselves there is nothing to tell them (notify() drops self-sends).
            notify({
                employeeId: after.assigned_by,
                type: done ? 'work_completed' : cancelled ? 'work_cancelled' : 'work_started',
                title: `${actorName} ${verb}: ${after.title}`,
                body: (after.project_name ? after.project_name + (after.unit_name ? ' · ' + after.unit_name : '') : '')
                    + (changes.due_date ? `\nDue ${dateOnly(changes.due_date)}` : ''),
                url: '/manager/team-work',
                entityType: 'work_assignment',
                entityId: id,
                actorId: req.user.id
            }).catch(() => {});
        }

        // Reassignment moves ownership - the new owner must be told, or the task
        // silently disappears from everyone's radar.
        if (changes.assigned_to && Number(changes.assigned_to) !== Number(row.assigned_to)) {
            const byName = [after.assigned_by_first, after.assigned_by_last].filter(Boolean).join(' ') || 'Your lead';
            notify({
                employeeId: changes.assigned_to,
                type: 'work_assigned',
                title: `Work reassigned to you: ${after.title}`,
                body: `By ${byName}` + (after.project_name ? ' · ' + after.project_name : '')
                    + (after.due_date ? `\nDue ${dateOnly(after.due_date)}` : ''),
                url: '/employee/my-work',
                entityType: 'work_assignment',
                entityId: id,
                actorId: req.user.id
            }).catch(() => {});
        }

        res.json({ success: true, message: 'Assignment updated', assignment: after });
    } catch (error) {
        console.error('Error updating work assignment:', error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

/**
 * DELETE /api/work-assignments/:id
 * Only the original assigner or an admin may delete/withdraw.
 */
router.delete('/:id', verifyToken, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ success: false, message: 'Invalid assignment id' });

        const cur = await q(`SELECT id, assigned_by FROM work_assignments WHERE id = $1`, [id]);
        if (cur.rows.length === 0) return res.status(404).json({ success: false, message: 'Assignment not found' });

        const allowed = Number(cur.rows[0].assigned_by) === Number(req.user.id) || req.user.role === 'admin';
        if (!allowed) {
            return res.status(403).json({ success: false, message: 'Only the assigner or admin can delete this assignment' });
        }

        await q(`DELETE FROM work_assignments WHERE id = $1`, [id]);
        logAudit({ actorId: req.user.id, action: 'work.delete', entityType: 'work_assignment', entityId: id, details: {}, ip: req.ip });
        res.json({ success: true, message: 'Assignment deleted' });
    } catch (error) {
        console.error('Error deleting work assignment:', error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

module.exports = router;