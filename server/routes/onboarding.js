const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken, isAdminOrHr } = require('../middleware/auth');
const { runWithSchemaRepair } = require('../utils/schemaRepair');
const { logAudit } = require('../utils/audit');
const { sendToUser, sendToUsers } = require('../services/push');
const { startOnboarding, startOffboarding, ensureTemplatesSeeded } = require('../services/onboarding');
const { buildReportWorkbook, sendWorkbook } = require('../utils/excel');

// Normalize a journey type query/body value. Anything that isn't 'offboarding'
// falls back to 'onboarding' so existing callers never break.
function validType(t) {
    return t === 'offboarding' ? 'offboarding' : 'onboarding';
}

// Every onboarding query runs through the self-healing wrapper so a live
// database that predates the onboarding tables creates them transparently
// (additive DDL only) on the first request instead of returning a 500.
const q = (sql, params) => runWithSchemaRepair(() => query(sql, params));

function computeProgress(total, done) {
    return {
        total,
        done,
        percent: total > 0 ? Math.round((done / total) * 100) : 0
    };
}

// Notify every active admin (best-effort) - used when an employee completes a task.
async function notifyAdmins(payload) {
    try {
        const r = await q("SELECT id FROM employees WHERE role = 'admin' AND status = 'active'");
        if (r.rows.length > 0) {
            await sendToUsers(r.rows.map(x => x.id), payload);
        }
    } catch (e) {
        console.error('Admin push notify error:', e.message);
    }
}

// @route   GET /api/onboarding/my
// @desc    The signed-in employee's own journey checklist + progress
// @access  Private (any authenticated employee)
router.get('/my', verifyToken, async (req, res) => {
    try {
        const type = validType(req.query.type);
        const procRes = await q(
            "SELECT * FROM employee_processes WHERE employee_id = $1 AND type = $2",
            [req.user.id, type]
        );
        if (procRes.rows.length === 0) {
            return res.json({ success: true, process: null, tasks: [], progress: computeProgress(0, 0) });
        }
        const proc = procRes.rows[0];
        const tasksRes = await q(
            `SELECT id, title, description, assignee_role, status, remarks, completed_at
            FROM process_tasks WHERE process_id = $1
            ORDER BY sequence ASC, id ASC`,
            [proc.id]
        );
        const done = tasksRes.rows.filter(t => t.status === 'done').length;
        res.json({
            success: true,
            process: proc,
            tasks: tasksRes.rows,
            progress: computeProgress(tasksRes.rows.length, done)
        });
    } catch (error) {
        console.error('My onboarding error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   POST /api/onboarding/tasks/:id/complete
// @desc    Mark a checklist task as done. Employees may only complete their
//          own employee-assigned tasks; admins can complete any task.
// @access  Private
router.post('/tasks/:id/complete', verifyToken, async (req, res) => {
    try {
        const taskRes = await q(
            `SELECT t.*, p.employee_id AS process_employee_id, p.type AS process_type
            FROM process_tasks t
            JOIN employee_processes p ON p.id = t.process_id
            WHERE t.id = $1`,
            [req.params.id]
        );
        if (taskRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Task not found' });
        }
        const task = taskRes.rows[0];
        if (task.status === 'done') {
            return res.status(400).json({ success: false, message: 'This task is already completed' });
        }

        if (req.user.role !== 'admin') {
            if (Number(task.process_employee_id) !== Number(req.user.id)) {
                return res.status(403).json({ success: false, message: 'Access denied' });
            }
            if (task.assignee_role !== 'employee') {
                return res.status(403).json({ success: false, message: 'This task must be completed by the HR / Admin team' });
            }
        }

        const remarks = typeof req.body.remarks === 'string' ? req.body.remarks.trim() : null;
        await q(
            `UPDATE process_tasks
            SET status = 'done', remarks = $1, completed_by = $2, completed_at = NOW()
            WHERE id = $3`,
            [remarks || null, req.user.id, req.params.id]
        );

        // Auto-complete the journey when the last pending task is done.
        const remaining = await q(
            `SELECT COUNT(*)::int AS count FROM process_tasks
            WHERE process_id = $1 AND status <> 'done'`,
            [task.process_id]
        );
        let completed = false;
        if (remaining.rows[0].count === 0) {
            await q(
                `UPDATE employee_processes SET status = 'completed', completed_at = NOW()
                WHERE id = $1 AND status <> 'completed'`,
                [task.process_id]
            );
            completed = true;
        }

        logAudit({
            actorId: req.user.id,
            action: task.process_type === 'offboarding' ? 'offboarding.task_complete' : 'onboarding.task_complete',
            entityType: 'process_task',
            entityId: task.id,
            details: { title: task.title, process_id: task.process_id },
            ip: req.ip
        });

        // Cross-notify: admin acting -> tell the employee; employee acting -> tell admins.
        const journeyLabel = task.process_type === 'offboarding' ? 'Offboarding' : 'Onboarding';
        if (req.user.role === 'admin') {
            if (Number(task.process_employee_id) !== Number(req.user.id)) {
                sendToUser(task.process_employee_id, {
                    title: journeyLabel + ' Task Completed',
                    body: `"${task.title}" was marked as done by HR.`,
                    url: '/employee/onboarding'
                }).catch(() => {});
            }
        } else {
            notifyAdmins({
                title: journeyLabel + ' Task Completed',
                body: `${req.user.name || 'An employee'} completed "${task.title}".`,
                url: '/admin/onboarding'
            }).catch(() => {});
        }

        res.json({ success: true, message: 'Task completed', process_completed: completed });
    } catch (error) {
        console.error('Complete onboarding task error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   POST /api/onboarding/tasks/:id/reopen
// @desc    Re-open a completed task (admin correction path)
// @access  Private (Admin)
router.post('/tasks/:id/reopen', verifyToken, isAdminOrHr, async (req, res) => {
    try {
        const result = await q(
            `UPDATE process_tasks
            SET status = 'pending', remarks = NULL, completed_by = NULL, completed_at = NULL
            WHERE id = $1 RETURNING id, title, process_id`,
            [req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Task not found' });
        }
        // A completed journey that gets a re-opened task goes back to in_progress.
        await q(
            `UPDATE employee_processes SET status = 'in_progress', completed_at = NULL
            WHERE id = $1 AND status = 'completed'`,
            [result.rows[0].process_id]
        );

        const typeRes = await q(
            'SELECT type FROM employee_processes WHERE id = $1',
            [result.rows[0].process_id]
        );
        const ptype = (typeRes.rows[0] && typeRes.rows[0].type) || 'onboarding';

        logAudit({
            actorId: req.user.id,
            action: ptype === 'offboarding' ? 'offboarding.task_reopen' : 'onboarding.task_reopen',
            entityType: 'process_task',
            entityId: result.rows[0].id,
            details: { title: result.rows[0].title },
            ip: req.ip
        });

        res.json({ success: true, message: 'Task re-opened' });
    } catch (error) {
        console.error('Reopen onboarding task error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/onboarding/processes
// @desc    All journey processes (onboarding or offboarding) with progress
// @access  Private (Admin)
router.get('/processes', verifyToken, isAdminOrHr, async (req, res) => {
    try {
        const type = validType(req.query.type);
        const result = await q(
            `SELECT p.id, p.employee_id, p.type, p.status, p.started_at, p.completed_at,
                e.first_name, e.last_name, e.employee_id AS emp_code, e.joining_date,
                d.name AS department_name,
                COUNT(t.id)::int AS total_tasks,
                COUNT(t.id) FILTER (WHERE t.status = 'done')::int AS done_tasks
            FROM employee_processes p
            JOIN employees e ON e.id = p.employee_id
            LEFT JOIN departments d ON d.id = e.department_id
            LEFT JOIN process_tasks t ON t.process_id = p.id
            WHERE p.type = $1
            GROUP BY p.id, e.id, d.name
            ORDER BY p.status ASC, p.started_at DESC`,
            [type]
        );
        const processes = result.rows.map(p => ({
            ...p,
            progress: computeProgress(p.total_tasks, p.done_tasks)
        }));
        res.json({ success: true, processes });
    } catch (error) {
        console.error('List onboarding processes error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/onboarding/processes/:id/tasks
// @desc    Full checklist of one journey (includes reviewer info)
// @access  Private (Admin)
router.get('/processes/:id/tasks', verifyToken, isAdminOrHr, async (req, res) => {
    try {
        const procRes = await q(
            `SELECT p.*, e.first_name, e.last_name, e.employee_id AS emp_code
            FROM employee_processes p
            JOIN employees e ON e.id = p.employee_id
            WHERE p.id = $1`,
            [req.params.id]
        );
        if (procRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Process not found' });
        }
        const tasksRes = await q(
            `SELECT t.*, c.first_name || ' ' || c.last_name AS completed_by_name
            FROM process_tasks t
            LEFT JOIN employees c ON c.id = t.completed_by
            WHERE t.process_id = $1
            ORDER BY t.sequence ASC, t.id ASC`,
            [req.params.id]
        );
        const done = tasksRes.rows.filter(t => t.status === 'done').length;
        res.json({
            success: true,
            process: procRes.rows[0],
            tasks: tasksRes.rows,
            progress: computeProgress(tasksRes.rows.length, done)
        });
    } catch (error) {
        console.error('Onboarding process tasks error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   POST /api/onboarding/processes/:id/tasks
// @desc    Add a custom ad-hoc task to an existing journey
// @access  Private (Admin)
router.post('/processes/:id/tasks', verifyToken, isAdminOrHr, async (req, res) => {
    try {
        const { title, description, assignee_role } = req.body;
        if (!title || !String(title).trim()) {
            return res.status(400).json({ success: false, message: 'Task title is required' });
        }
        const role = assignee_role === 'admin' ? 'admin' : 'employee';

        const procRes = await q(
            'SELECT id FROM employee_processes WHERE id = $1',
            [req.params.id]
        );
        if (procRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Process not found' });
        }

        const seqRes = await q(
            'SELECT COALESCE(MAX(sequence), 0)::int + 1 AS next_seq FROM process_tasks WHERE process_id = $1',
            [req.params.id]
        );

        const inserted = await q(
            `INSERT INTO process_tasks (process_id, title, description, assignee_role, sequence)
            VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [req.params.id, String(title).trim(), description || null, role, seqRes.rows[0].next_seq]
        );

        // A completed journey receiving new work becomes active again.
        await q(
            `UPDATE employee_processes SET status = 'in_progress', completed_at = NULL
            WHERE id = $1 AND status = 'completed'`,
            [req.params.id]
        );

        const typeRes = await q(
            'SELECT type FROM employee_processes WHERE id = $1',
            [req.params.id]
        );
        const ptype = (typeRes.rows[0] && typeRes.rows[0].type) || 'onboarding';

        logAudit({
            actorId: req.user.id,
            action: ptype === 'offboarding' ? 'offboarding.task_add' : 'onboarding.task_add',
            entityType: 'process_task',
            entityId: inserted.rows[0].id,
            details: { title: String(title).trim(), assignee_role: role },
            ip: req.ip
        });

        res.json({ success: true, message: 'Task added', task_id: inserted.rows[0].id });
    } catch (error) {
        console.error('Add onboarding task error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   POST /api/onboarding/start/:employeeId
// @desc    Manually start a journey (onboarding default, offboarding via
//          body.type) for employees created before the automatic flow
// @access  Private (Admin)
router.post('/start/:employeeId', verifyToken, isAdminOrHr, async (req, res) => {
    try {
        const type = validType(req.body && req.body.type);
        const empRes = await q(
            'SELECT id, first_name, last_name, employee_id FROM employees WHERE id = $1',
            [req.params.employeeId]
        );
        if (empRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Employee not found' });
        }
        const emp = empRes.rows[0];

        const r = type === 'offboarding'
            ? await startOffboarding(emp.id, req.user.id)
            : await startOnboarding(emp.id, req.user.id);
        if (!r.ok) {
            // audit-security F2: never echo the raw driver message to the client.
            console.error(`Onboarding start failed for ${type} (employee ${emp.employee_id}):`, r.error);
            return res.status(500).json({ success: false, message: 'Could not start ' + type + '. Please try again or contact your administrator.' });
        }
        if (r.already) {
            return res.json({ success: true, message: 'This checklist is already started for this employee' });
        }

        logAudit({
            actorId: req.user.id,
            action: type === 'offboarding' ? 'offboarding.start' : 'onboarding.start',
            entityType: 'employee_process',
            entityId: r.processId,
            details: { employee_code: emp.employee_id },
            ip: req.ip
        });

        res.json({ success: true, message: `${type === 'offboarding' ? 'Offboarding' : 'Onboarding'} started for ${emp.first_name} ${emp.last_name}` });
    } catch (error) {
        console.error('Start process error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ---------- Checklist template management ----------

// @route   GET /api/onboarding/templates
// @desc    List checklist templates (onboarding or offboarding)
// @access  Private (Admin)
router.get('/templates', verifyToken, isAdminOrHr, async (req, res) => {
    try {
        const type = validType(req.query.type);
        // Seed the defaults on first view so a fresh deployment shows the
        // standard checklist instead of an empty table.
        await ensureTemplatesSeeded(type);
        const result = await q(
            `SELECT * FROM hr_task_templates WHERE type = $1 ORDER BY sequence ASC, id ASC`,
            [type]
        );
        res.json({ success: true, templates: result.rows });
    } catch (error) {
        console.error('List checklist templates error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   POST /api/onboarding/templates
// @desc    Create a checklist template
// @access  Private (Admin)
router.post('/templates', verifyToken, isAdminOrHr, async (req, res) => {
    try {
        const { title, description, assignee_role, sequence, type } = req.body;
        if (!title || !String(title).trim()) {
            return res.status(400).json({ success: false, message: 'Title is required' });
        }
        const role = assignee_role === 'admin' ? 'admin' : 'employee';
        const t = validType(type);
        const result = await q(
            `INSERT INTO hr_task_templates (title, description, assignee_role, sequence, type)
            VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [String(title).trim(), description || null, role, Number(sequence) || 0, t]
        );
        logAudit({
            actorId: req.user.id,
            action: t === 'offboarding' ? 'offboarding.template_create' : 'onboarding.template_create',
            entityType: 'hr_task_template',
            entityId: result.rows[0].id,
            details: { title: result.rows[0].title },
            ip: req.ip
        });
        res.json({ success: true, template: result.rows[0] });
    } catch (error) {
        if (error && error.code === '23505') {
            return res.status(400).json({ success: false, message: 'A template with this title already exists' });
        }
        console.error('Create checklist template error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   PUT /api/onboarding/templates/:id
// @desc    Update a checklist template
// @access  Private (Admin)
router.put('/templates/:id', verifyToken, isAdminOrHr, async (req, res) => {
    try {
        const { title, description, assignee_role, sequence, is_active } = req.body;
        if (!title || !String(title).trim()) {
            return res.status(400).json({ success: false, message: 'Title is required' });
        }
        const role = assignee_role === 'admin' ? 'admin' : 'employee';
        const active = (is_active === 0 || is_active === false || is_active === '0') ? 0 : 1;
        const result = await q(
            `UPDATE hr_task_templates
            SET title = $1, description = $2, assignee_role = $3, sequence = $4, is_active = $5
            WHERE id = $6 RETURNING *`,
            [String(title).trim(), description || null, role, Number(sequence) || 0, active, req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Template not found' });
        }
        const ttype = result.rows[0].type === 'offboarding' ? 'offboarding' : 'onboarding';
        logAudit({
            actorId: req.user.id,
            action: ttype === 'offboarding' ? 'offboarding.template_update' : 'onboarding.template_update',
            entityType: 'hr_task_template',
            entityId: result.rows[0].id,
            details: { title: result.rows[0].title, is_active: active },
            ip: req.ip
        });
        res.json({ success: true, template: result.rows[0] });
    } catch (error) {
        if (error && error.code === '23505') {
            return res.status(400).json({ success: false, message: 'A template with this title already exists' });
        }
        console.error('Update onboarding template error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   DELETE /api/onboarding/templates/:id
// @desc    Soft-disable a template (history preserved, no longer offered)
// @access  Private (Admin)
router.delete('/templates/:id', verifyToken, isAdminOrHr, async (req, res) => {
    try {
        const result = await q(
            'UPDATE hr_task_templates SET is_active = 0 WHERE id = $1 RETURNING id, title, type',
            [req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Template not found' });
        }
        const ttype = result.rows[0].type === 'offboarding' ? 'offboarding' : 'onboarding';
        logAudit({
            actorId: req.user.id,
            action: ttype === 'offboarding' ? 'offboarding.template_disable' : 'onboarding.template_disable',
            entityType: 'hr_task_template',
            entityId: result.rows[0].id,
            details: { title: result.rows[0].title },
            ip: req.ip
        });
        res.json({ success: true, message: 'Template disabled' });
    } catch (error) {
        console.error('Disable onboarding template error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/onboarding/export
// @desc    Branded Excel journey progress tracker (onboarding or offboarding)
// @access  Private (Admin)
router.get('/export', verifyToken, isAdminOrHr, async (req, res) => {
    try {
        const type = validType(req.query.type);
        const result = await query(
            `SELECT p.id, p.status AS process_status, p.type, p.started_at, p.completed_at,
                e.first_name, e.last_name, e.employee_id AS emp_code, e.joining_date,
                d.name AS department_name,
                COUNT(t.id)::int AS total_tasks,
                COUNT(t.id) FILTER (WHERE t.status = 'done')::int AS done_tasks,
                COALESCE(string_agg(t.title, ', ' ORDER BY t.sequence, t.id)
                    FILTER (WHERE t.status <> 'done'), 'All tasks completed') AS pending_tasks
            FROM employee_processes p
            JOIN employees e ON e.id = p.employee_id
            LEFT JOIN departments d ON d.id = e.department_id
            LEFT JOIN process_tasks t ON t.process_id = p.id
            WHERE p.type = $1
            GROUP BY p.id, e.id, d.name
            ORDER BY p.status ASC, p.started_at DESC`,
            [type]
        );

        const rows = result.rows.map(r => ({
            emp_code: r.emp_code,
            name: r.first_name + ' ' + r.last_name,
            department: r.department_name,
            joining_date: r.joining_date,
            status: r.process_status,
            done_tasks: r.done_tasks,
            total_tasks: r.total_tasks,
            progress_percent: r.total_tasks > 0 ? Math.round((r.done_tasks / r.total_tasks) * 1000) / 10 : 0,
            pending_tasks: r.pending_tasks,
            started_at: r.started_at,
            completed_at: r.completed_at
        }));

        const columns = [
            { header: 'Emp ID', key: 'emp_code', width: 12 },
            { header: 'Employee Name', key: 'name', width: 22 },
            { header: 'Department', key: 'department' },
            { header: 'Joining Date', key: 'joining_date', type: 'date', width: 13 },
            { header: 'Status', key: 'status', type: 'status' },
            { header: 'Tasks Done', key: 'done_tasks', type: 'number', width: 11 },
            { header: 'Total Tasks', key: 'total_tasks', type: 'number', width: 11 },
            { header: 'Progress %', key: 'progress_percent', type: 'percent', width: 12 },
            { header: 'Pending Tasks', key: 'pending_tasks', width: 48 },
            { header: 'Started On', key: 'started_at', type: 'datetime', width: 17 },
            { header: 'Completed On', key: 'completed_at', type: 'datetime', width: 17 }
        ];

        const label = type === 'offboarding' ? 'Offboarding' : 'Onboarding';
        const wb = await buildReportWorkbook({
            reportName: label + ' Tracker',
            subtitleExtra: 'All employees — ' + label.toLowerCase(),
            columns,
            rows,
            footerNote: req.user.name || 'Admin'
        });

        logAudit({
            actorId: req.user.id,
            action: 'data.export',
            entityType: 'report',
            entityId: null,
            details: { report: label.toLowerCase() + '_tracker', records: rows.length },
            ip: req.ip
        });

        const d = new Date();
        const fn = label + '_Tracker_' + d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0') + '.xlsx';
        await sendWorkbook(res, wb, fn);
    } catch (error) {
        const ctype = validType(req.query && req.query.type);
        console.error((ctype === 'offboarding' ? 'Offboarding' : 'Onboarding') + ' export error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;
