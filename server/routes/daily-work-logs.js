const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { runWithSchemaRepair, pgErrorResponse: basePgError } = require('../utils/schemaRepair');
const { logAudit } = require('../utils/audit');
const { dateOnly, istDateString } = require('../utils/date');
const { myTreeIds } = require('./project-leads');

const q = (sql, params) => runWithSchemaRepair(() => query(sql, params));

// Feature-specific friendly messages on top of the shared mapper (which covers
// 22001/22008/23514/23502 too, instead of the old narrow local copy).
function pgErrorResponse(error) {
    if (!error) return { status: 500, message: 'Server error' };
    if (error.code === '23505') {
        return { status: 400, message: 'A daily work log with the same title already exists for this date.' };
    }
    if (error.code === '23503') {
        return { status: 400, message: 'Invalid reference (project/unit/assignment).' };
    }
    return basePgError(error);
}

// A daily log may link only to the caller's OWN open assignment. Without this,
// any employee could attach a log to someone else's task and read its title and
// assigner back through GET /api/daily-work-logs (FK oracle + cross-scope leak).
async function validateAssignmentLink(aid, userId) {
    if (aid === null) return null;
    if (Number.isNaN(aid)) return { status: 400, message: 'Invalid assignment id' };
    const r = await q(`SELECT status FROM work_assignments WHERE id = $1 AND assigned_to = $2`, [aid, userId]);
    if (r.rows.length === 0) return { status: 404, message: 'Linked assignment not found' };
    // A closed assignment the caller already owns stays linkable (so editing an
    // old log never force-unlinks it); only foreign/unknown ids are rejected.
    return null;
}

// Unit must belong to the selected project (mirrors work-assignments validation).
async function validateLogProjectUnit(pid, uid) {
    if (pid !== null && Number.isNaN(pid)) return { status: 400, message: 'Invalid project id' };
    if (uid !== null && Number.isNaN(uid)) return { status: 400, message: 'Invalid unit id' };
    if (uid !== null && pid === null) return { status: 400, message: 'A unit requires a project' };
    if (pid !== null && uid !== null) {
        const u = await q(`SELECT id FROM project_units WHERE id = $1 AND project_id = $2`, [uid, pid]);
        if (u.rows.length === 0) return { status: 400, message: 'Unit does not belong to the selected project' };
    }
    return null;
}

// Shared SELECT so the employee ("mine") and manager ("team") views return the
// exact same shape - the UI renders one card design for both. The optional
// assignment link lets a log show WHO the work was assigned by.
const LOG_SELECT = `
    SELECT dw.*,
           p.name as project_name, u.name as unit_name,
           lg.first_name as employee_first, lg.last_name as employee_last, lg.employee_id as employee_code,
           wa.title as assignment_title,
           wa.assigned_by as assignment_assigned_by,
           ab.first_name as assigned_by_first, ab.last_name as assigned_by_last
    FROM daily_work_logs dw
    LEFT JOIN projects p ON p.id = dw.project_id
    LEFT JOIN project_units u ON u.id = dw.unit_id
    LEFT JOIN employees lg ON lg.id = dw.employee_id
    LEFT JOIN work_assignments wa ON wa.id = dw.assignment_id
    LEFT JOIN employees ab ON ab.id = wa.assigned_by`;

function applyDateFilters(sql, params, idx, { work_date, start_date, end_date, limit }) {
    if (work_date) { sql += ` AND dw.work_date = $${idx++}`; params.push(work_date); }
    if (start_date) { sql += ` AND dw.work_date >= $${idx++}`; params.push(start_date); }
    if (end_date) { sql += ` AND dw.work_date <= $${idx++}`; params.push(end_date); }
    sql += ' ORDER BY dw.work_date DESC, dw.logged_at DESC';
    if (limit) { sql += ` LIMIT $${idx++}`; params.push(Math.min(parseInt(limit, 10) || 0, 500)); }
    return sql;
}

// @route   GET /api/daily-work-logs
// @desc    Get my daily work logs
// @access  Private
router.get('/', verifyToken, async (req, res) => {
    try {
        let sql = `${LOG_SELECT} WHERE dw.employee_id = $1`;
        const params = [req.user.id];
        sql = applyDateFilters(sql, params, 2, req.query);
        const r = await q(sql, params);
        r.rows.forEach(row => {
            if (row.work_date) row.work_date = dateOnly(row.work_date);
        });
        res.json({ success: true, logs: r.rows });
    } catch (error) {
        console.error('Get daily work logs error:', error);
        const e = pgErrorResponse(error);
        res.status(e.status).json({ success: false, message: e.message });
    }
});

// @route   GET /api/daily-work-logs/team
// @desc    Get team daily work logs (TL/Manager/Admin/HR)
// @access  Private (Manager+)
router.get('/team', verifyToken, async (req, res) => {
    try {
        const userRole = req.user.role;
        const userId = req.user.id;
        const { work_date, start_date, end_date, limit } = req.query;
        let sql = `${LOG_SELECT} WHERE 1=1`;
        const params = [];
        let idx = 1;
        if (userRole === 'admin' || userRole === 'hr') {
            // all
        } else if (userRole === 'manager' || userRole === 'team_lead') {
            const tree = await myTreeIds(userId);
            const ids = Array.from(tree);
            if (ids.length === 0) return res.json({ success: true, logs: [] });
            sql += ` AND dw.employee_id IN (${ids.map(() => `$${idx++}`).join(',')})`;
            params.push(...ids);
        } else {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }
        sql = applyDateFilters(sql, params, idx, { work_date, start_date, end_date, limit });
        const r = await q(sql, params);
        r.rows.forEach(row => {
            if (row.work_date) row.work_date = dateOnly(row.work_date);
        });
        res.json({ success: true, logs: r.rows });
    } catch (error) {
        console.error('Get team daily work logs error:', error);
        const e = pgErrorResponse(error);
        res.status(e.status).json({ success: false, message: e.message });
    }
});

// @route   POST /api/daily-work-logs
// @desc    Create a self-reported daily work log (works with NO assigned task)
// @access  Private
router.post('/', verifyToken, async (req, res) => {
    try {
        const { work_date, title, description, projectId, unitId, assignmentId } = req.body;
        if (!title || String(title).trim().length === 0) {
            return res.status(400).json({ success: false, message: 'Title is required' });
        }
        if (String(title).trim().length > 255) {
            return res.status(400).json({ success: false, message: 'Title must be 255 characters or fewer' });
        }
        const wd = work_date ? dateOnly(work_date) : istDateString();
        if (!wd) return res.status(400).json({ success: false, message: 'Invalid work date (YYYY-MM-DD)' });
        const pid = projectId ? parseInt(projectId, 10) : null;
        const uid = unitId ? parseInt(unitId, 10) : null;
        const aid = assignmentId ? parseInt(assignmentId, 10) : null;
        const linkErr = await validateAssignmentLink(aid, req.user.id);
        if (linkErr) return res.status(linkErr.status).json({ success: false, message: linkErr.message });
        const puErr = await validateLogProjectUnit(pid, uid);
        if (puErr) return res.status(puErr.status).json({ success: false, message: puErr.message });
        const ins = await q(
            `INSERT INTO daily_work_logs (employee_id, work_date, title, description, project_id, unit_id, assignment_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [req.user.id, wd, String(title).trim(), description || null, pid, uid, aid]
        );
        logAudit({ actorId: req.user.id, action: 'daily_work_log.create', entityType: 'daily_work_log', entityId: ins.rows[0].id, details: { title: String(title).trim(), work_date: wd }, ip: req.ip });
        res.status(201).json({ success: true, message: 'Daily work logged' });
    } catch (error) {
        const e = pgErrorResponse(error);
        res.status(e.status).json({ success: false, message: e.message });
    }
});

// @route   PUT /api/daily-work-logs/:id
// @desc    Update my own daily work log
// @access  Private (owner only)
router.put('/:id', verifyToken, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ success: false, message: 'Invalid log id' });
        const existing = await q('SELECT id FROM daily_work_logs WHERE id = $1 AND employee_id = $2', [id, req.user.id]);
        if (existing.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Work log not found' });
        }
        const { title, description, projectId, unitId, assignmentId, work_date } = req.body;
        if (!title || String(title).trim().length === 0) {
            return res.status(400).json({ success: false, message: 'Title is required' });
        }
        if (String(title).trim().length > 255) {
            return res.status(400).json({ success: false, message: 'Title must be 255 characters or fewer' });
        }
        const wd = work_date ? dateOnly(work_date) : null;
        if (work_date && !wd) return res.status(400).json({ success: false, message: 'Invalid work date (YYYY-MM-DD)' });
        const pid = projectId ? parseInt(projectId, 10) : null;
        const uid = unitId ? parseInt(unitId, 10) : null;
        const aid = assignmentId ? parseInt(assignmentId, 10) : null;
        const linkErr = await validateAssignmentLink(aid, req.user.id);
        if (linkErr) return res.status(linkErr.status).json({ success: false, message: linkErr.message });
        const puErr = await validateLogProjectUnit(pid, uid);
        if (puErr) return res.status(puErr.status).json({ success: false, message: puErr.message });
        await q(
            `UPDATE daily_work_logs
             SET title = $1, description = $2, project_id = $3, unit_id = $4, assignment_id = $5,
                 work_date = COALESCE($6, work_date), updated_at = NOW()
             WHERE id = $7 AND employee_id = $8`,
            [
                String(title).trim(), description || null,
                pid, uid, aid, wd,
                id, req.user.id
            ]
        );
        logAudit({ actorId: req.user.id, action: 'daily_work_log.update', entityType: 'daily_work_log', entityId: id, details: { title: String(title).trim() }, ip: req.ip });
        res.json({ success: true, message: 'Daily work log updated' });
    } catch (error) {
        const e = pgErrorResponse(error);
        res.status(e.status).json({ success: false, message: e.message });
    }
});

// @route   DELETE /api/daily-work-logs/:id
// @desc    Delete my own daily work log
// @access  Private (owner only)
router.delete('/:id', verifyToken, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ success: false, message: 'Invalid log id' });
        const del = await q('DELETE FROM daily_work_logs WHERE id = $1 AND employee_id = $2', [id, req.user.id]);
        if (del.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Work log not found' });
        }
        logAudit({ actorId: req.user.id, action: 'daily_work_log.delete', entityType: 'daily_work_log', entityId: id, details: {}, ip: req.ip });
        res.json({ success: true, message: 'Daily work log deleted' });
    } catch (error) {
        const e = pgErrorResponse(error);
        res.status(e.status).json({ success: false, message: e.message });
    }
});

module.exports = router;