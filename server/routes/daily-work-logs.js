const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { runWithSchemaRepair } = require('../utils/schemaRepair');
const { logAudit } = require('../utils/audit');
const { myTreeIds } = require('./project-leads');

const q = (sql, params) => runWithSchemaRepair(() => query(sql, params));

function pgErrorResponse(error) {
    if (!error) return { status: 500, message: 'Server error' };
    if (error.code === '23505') {
        return { status: 400, message: 'A daily work log with the same title already exists for this date.' };
    }
    if (error.code === '23503') {
        return { status: 400, message: 'Invalid reference (project/unit).' };
    }
    if (error.code === '22P02' || error.code === '22007') {
        return { status: 400, message: 'Invalid date format.' };
    }
    return { status: 500, message: 'Server error' };
}

// @route   GET /api/daily-work-logs
// @desc    Get my daily work logs
// @access  Private
router.get('/', verifyToken, async (req, res) => {
    try {
        const { work_date, start_date, end_date, limit } = req.query;
        let sql = `SELECT dw.*, p.name as project_name, u.name as unit_name
                   FROM daily_work_logs dw
                   LEFT JOIN projects p ON p.id = dw.project_id
                   LEFT JOIN project_units u ON u.id = dw.unit_id
                   WHERE dw.employee_id = $1`;
        const params = [req.user.id];
        let idx = 2;
        if (work_date) {
            sql += ` AND dw.work_date = $${idx++}`;
            params.push(work_date);
        }
        if (start_date) {
            sql += ` AND dw.work_date >= $${idx++}`;
            params.push(start_date);
        }
        if (end_date) {
            sql += ` AND dw.work_date <= $${idx++}`;
            params.push(end_date);
        }
        sql += ' ORDER BY dw.work_date DESC, dw.logged_at DESC';
        if (limit) {
            sql += ` LIMIT $${idx++}`;
            params.push(parseInt(limit));
        }
        const r = await q(sql, params);
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
        let sql = `SELECT dw.*, 
                          e.first_name, e.last_name, e.employee_id as emp_id,
                          p.name as project_name, u.name as unit_name
                   FROM daily_work_logs dw
                   JOIN employees e ON e.id = dw.employee_id
                   LEFT JOIN projects p ON p.id = dw.project_id
                   LEFT JOIN project_units u ON u.id = dw.unit_id
                   WHERE 1=1`;
        const params = [];
        let idx = 1;
        if (userRole === 'admin' || userRole === 'hr') {
            // all
        } else if (userRole === 'manager') {
            const tree = await myTreeIds(userId);
            sql += ` AND dw.employee_id IN (${Array.from(tree).map((_,i)=>`$${idx++}`).join(',')})`;
            params.push(...Array.from(tree));
        } else if (userRole === 'team_lead') {
            const tree = await myTreeIds(userId);
            sql += ` AND dw.employee_id IN (${Array.from(tree).map((_,i)=>`$${idx++}`).join(',')})`;
            params.push(...Array.from(tree));
        } else {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }
        if (work_date) {
            sql += ` AND dw.work_date = $${idx++}`;
            params.push(work_date);
        }
        if (start_date) {
            sql += ` AND dw.work_date >= $${idx++}`;
            params.push(start_date);
        }
        if (end_date) {
            sql += ` AND dw.work_date <= $${idx++}`;
            params.push(end_date);
        }
        sql += ' ORDER BY dw.work_date DESC, dw.logged_at DESC';
        if (limit) {
            sql += ` LIMIT $${idx++}`;
            params.push(parseInt(limit));
        }
        const r = await q(sql, params);
        res.json({ success: true, logs: r.rows });
    } catch (error) {
        console.error('Get team daily work logs error:', error);
        const e = pgErrorResponse(error);
        res.status(e.status).json({ success: false, message: e.message });
    }
});

// @route   POST /api/daily-work-logs
// @desc    Create daily work log
// @access  Private
router.post('/', verifyToken, async (req, res) => {
    try {
        const { work_date, title, description, projectId, unitId } = req.body;
        if (!title || String(title).trim().length === 0) {
            return res.status(400).json({ success: false, message: 'Title is required' });
        }
        const wd = work_date || new Date().toISOString().slice(0,10);
        const pid = projectId ? parseInt(projectId) : null;
        const uid = unitId ? parseInt(unitId) : null;
        const ins = await q(`INSERT INTO daily_work_logs (employee_id, work_date, title, description, project_id, unit_id)
                             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [req.user.id, wd, String(title).trim(), description || null, pid, uid]);
        logAudit({ actorId: req.user.id, action: 'daily_work_log.create', entityType: 'daily_work_log', entityId: ins.rows[0].id, details: {title: String(title).trim(), work_date: wd}, ip: req.ip });
        res.status(201).json({ success: true, message: 'Daily work logged' });
    } catch (error) {
        const e = pgErrorResponse(error);
        res.status(e.status).json({ success: false, message: e.message });
    }
});

module.exports = router;
