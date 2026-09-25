const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken, isAdmin, isEmployee } = require('../middleware/auth');
const { runWithSchemaRepair, hasColumn } = require('../utils/schemaRepair');
const projectMath = require('../utils/projectMath');
const { logAudit } = require('../utils/audit');

// Self-healing query wrapper: heals missing projects-module tables per request.
const q = (sql, params) => runWithSchemaRepair(() => query(sql, params));

/**
 * GET /api/daily-work-counts
 * Get all daily work counts with optional filtering
 */
router.get('/', verifyToken, isAdmin, async (req, res) => {
    try {
        const { projectId, setId, employeeId, date, view } = req.query;
        let condition = '';
        let params = [];
        let paramCount = 0;
    
        if (projectId) {
            paramCount++;
            condition += ` AND pc.project_id = $${paramCount}`;
            params.push(projectId);
        }
        if (setId) {
            paramCount++;
            condition += ` AND pc.set_id = $${paramCount}`;
            params.push(setId);
        }
        if (employeeId) {
            paramCount++;
            condition += ` AND pc.employee_id = $${paramCount}`;
            params.push(employeeId);
        }
        if (date) {
            paramCount++;
            condition += ` AND pc.work_date = $${paramCount}`;
            params.push(date);
        }
    
        condition = condition.substring(5); // Remove leading " AND "
    
        const result = await q(
            `SELECT pc.id, pc.project_id, pc.set_id, pc.employee_id, pc.work_date, pc.daily_count,
             p.name as project_name, s.name as set_name,
             e.first_name, e.last_name, e.employee_id as emp_id
             FROM daily_work_counts pc
             JOIN projects p ON pc.project_id = p.id
             JOIN project_sets s ON pc.set_id = s.id
             JOIN employees e ON pc.employee_id = e.id
             WHERE ${condition}
             ORDER BY pc.work_date DESC, e.first_name, e.last_name`,
            params
        );
        res.json({ success: true, counts: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: (error && error.message) || 'Server error' });
    }
});

/**
 * GET /api/daily-work-counts/employee/:employeeId
 * Get daily work counts for a specific employee. Employees may only read their
 * OWN counts; admin/manager/team_lead/hr may read any employee's (used by
 * manager dashboards). Closes the cross-employee read hole.
 */
router.get('/employee/:employeeId', verifyToken, async (req, res) => {
    try {
        const targetId = req.params.employeeId;
        const isSelf = String(targetId) === String(req.user.id);
        const canViewOthers = ['admin', 'manager', 'team_lead', 'hr'].includes(req.user.role);
        if (!isSelf && !canViewOthers) {
            return res.status(403).json({ success: false, message: 'Access denied. You can only view your own work counts.' });
        }
        const result = await q(
            `SELECT pc.id, pc.project_id, pc.set_id, pc.work_date, pc.daily_count,
             p.name as project_name, s.name as set_name, s.total_target, s.working_days,
             (SELECT COUNT(DISTINCT pe2.employee_id) FROM project_employees pe2 WHERE pe2.project_id = pc.project_id) as emp_count
             FROM daily_work_counts pc
             JOIN projects p ON pc.project_id = p.id
             JOIN project_sets s ON pc.set_id = s.id
             WHERE pc.employee_id = $1
             ORDER BY pc.work_date DESC`,
            [targetId]
        );
        res.json({ success: true, counts: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: (error && error.message) || 'Server error' });
    }
});

/**
 * POST /api/daily-work-counts
 * Submit or update daily work count
 * - Creates new record if none exists for employee+project+set+date
 * - Updates existing record if one already exists (no duplicates)
 * Validation (set active / soft-deletion / date-in-range / count sanity) now
 * runs BEFORE the create-vs-update branch, so an existing record can no longer
 * be edited in a way that bypasses the checks the create branch enforces.
 */
router.post('/', verifyToken, async (req, res) => {
    try {
        const { projectId, setId, workDate, dailyCount } = req.body;
        if (!projectId || !setId || !workDate || dailyCount === undefined) {
            return res.status(400).json({ success: false, message: 'Project ID, Set ID, work date, and count are required' });
        }
        const count = Number(dailyCount);
        if (!Number.isFinite(count) || count < 0) {
            return res.status(400).json({ success: false, message: 'Daily count must be a non-negative number' });
        }
        const myId = req.user.id;

        // Set must exist, belong to this project, be 'active', and not soft-deleted.
        const setCheck = await q(
            `SELECT ps.id, ps.start_date, ps.end_date FROM project_sets ps
             WHERE ps.project_id = $1 AND ps.id = $2 AND ps.status = 'active'`,
            [projectId, setId]
        );
        if (setCheck.rows.length === 0) {
            return res.status(403).json({ success: false, message: 'Set does not belong to this project or is not active' });
        }
        const hasDeletedAt = await hasColumn('project_sets', 'deleted_at');
        if (hasDeletedAt) {
            const delCheck = await q(`SELECT deleted_at FROM project_sets WHERE id = $1`, [setId]);
            if (delCheck.rows.length > 0 && delCheck.rows[0].deleted_at) {
                return res.status(403).json({ success: false, message: 'This set has been deleted and can no longer accept work counts' });
            }
        }

        // Date must fall inside the set period.
        const setStart = new Date(String(setCheck.rows[0].start_date).slice(0, 10) + 'T00:00:00');
        const setEnd = new Date(String(setCheck.rows[0].end_date).slice(0, 10) + 'T00:00:00');
        const subDate = new Date(workDate + 'T00:00:00');
        if (isNaN(subDate.getTime()) || subDate < setStart || subDate > setEnd) {
            return res.status(400).json({
                success: false,
                message: `Work date ${workDate} is outside the set period (${String(setCheck.rows[0].start_date).slice(0, 10)} - ${String(setCheck.rows[0].end_date).slice(0, 10)})`
            });
        }

        // Check if record already exists for this employee+project+set+date
        const existing = await q(
            `SELECT id, daily_count FROM daily_work_counts 
             WHERE project_id = $1 AND set_id = $2 AND employee_id = $3 AND work_date = $4`,
            [projectId, setId, myId, workDate]
        );

        if (existing.rows.length > 0) {
            // Update existing record. Ownership is inherent - the WHERE above
            // already scoped to this employee's id.
            const result = await q(
                `UPDATE daily_work_counts SET daily_count = $1, updated_at = NOW() 
                 WHERE id = $2 
                 RETURNING id, project_id, set_id, employee_id, work_date, daily_count`,
                [count, existing.rows[0].id]
            );
            logAudit({
                actorId: req.user.id, action: 'project.daily_count.update', entityType: 'daily_work_count',
                entityId: existing.rows[0].id, details: { projectId, setId, workDate, from: existing.rows[0].daily_count, to: count },
                ip: req.ip
            });
            res.json({
                success: true,
                updated: true,
                dailyCount: result.rows[0].daily_count,
                message: 'Daily work count updated successfully'
            });
        } else {
            // Create new record: employee must still be assigned to the project.
            const empCheck = await q(
                `SELECT id FROM project_employees WHERE project_id = $1 AND employee_id = $2`,
                [projectId, myId]
            );
            if (empCheck.rows.length === 0) {
                return res.status(403).json({
                    success: false,
                    message: 'Employee is not assigned to this project'
                });
            }

            const result = await q(
                `INSERT INTO daily_work_counts (project_id, set_id, employee_id, work_date, daily_count) 
                 VALUES ($1, $2, $3, $4, $5) 
                 RETURNING id, project_id, set_id, employee_id, work_date, daily_count`,
                [projectId, setId, myId, workDate, count]
            );
            logAudit({
                actorId: req.user.id, action: 'project.daily_count.create', entityType: 'daily_work_count',
                entityId: result.rows[0].id, details: { projectId, setId, workDate, count }, ip: req.ip
            });
            res.json({
                success: true,
                created: true,
                dailyCount: result.rows[0].daily_count,
                message: 'Daily work count submitted successfully'
            });
        }
    } catch (error) {
        console.error('Error submitting daily work count:', error);
        res.status(500).json({ success: false, message: (error && error.message) || 'Server error' });
    }
});

/**
 * PUT /api/daily-work-counts/:id
 * Update daily work count by ID
 */
router.put('/:id', verifyToken, isEmployee, async (req, res) => {
    try {
        const { dailyCount } = req.body;
        if (dailyCount === undefined) {
            return res.status(400).json({ success: false, message: 'Daily count is required' });
        }
        const count = Number(dailyCount);
        if (!Number.isFinite(count) || count < 0) {
            return res.status(400).json({ success: false, message: 'Daily count must be a non-negative number' });
        }
    
        // Check ownership - employee can only update their own records
        const check = await q(
            `SELECT id, daily_count, employee_id FROM daily_work_counts WHERE id = $1`,
            [req.params.id]
        );
        if (check.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Daily work count not found' });
        }
    
        // Verify the employee owns this record
        if (String(check.rows[0].employee_id) !== String(req.user.id)) {
            return res.status(403).json({ 
                success: false, 
                message: 'Unauthorized: You can only update your own daily work counts' 
            });
        }
    
        const result = await q(
            `UPDATE daily_work_counts SET daily_count = $1, updated_at = NOW() 
             WHERE id = $2 
             RETURNING id, project_id, set_id, employee_id, work_date, daily_count`,
            [count, req.params.id]
        );
        logAudit({
            actorId: req.user.id, action: 'project.daily_count.update', entityType: 'daily_work_count',
            entityId: req.params.id, details: { from: check.rows[0].daily_count, to: count }, ip: req.ip
        });
        res.json({ 
            success: true, 
            dailyCount: result.rows[0].daily_count,
            message: 'Daily work count updated successfully' 
        });
    } catch (error) {
        res.status(500).json({ success: false, message: (error && error.message) || 'Server error' });
    }
});

/**
 * DELETE /api/daily-work-counts/:id
 * Delete a daily work count record (admin only)
 */
router.delete('/:id', verifyToken, isAdmin, async (req, res) => {
    try {
        const result = await q(
            `DELETE FROM daily_work_counts WHERE id = $1 RETURNING id`,
            [req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Daily work count not found' });
        }
        logAudit({
            actorId: req.user.id, action: 'project.daily_count.delete', entityType: 'daily_work_count',
            entityId: req.params.id, ip: req.ip
        });
        res.json({ success: true, message: 'Daily work count record deleted' });
    } catch (error) {
        res.status(500).json({ success: false, message: (error && error.message) || 'Server error' });
    }
});

/**
 * GET /api/daily-work-counts/summary/:projectId/:setId
 * Get summary data for a project set (targets, achievements, etc.)
 */
router.get('/summary/:projectId/:setId', verifyToken, isAdmin, async (req, res) => {
    try {
        const projectId = req.params.projectId;
        const setId = req.params.setId;

        const hasSetDeletedAt = await hasColumn('project_sets', 'deleted_at');
        const deletedFilter = hasSetDeletedAt ? 'AND ps.deleted_at IS NULL' : '';

        // Get set details - verify the set actually belongs to :projectId so a
        // mismatched projectId/setId pair can never return another project's data.
        const setResult = await q(
            `SELECT ps.*, p.name as project_name, COALESCE(p.client, p.customer) as project_client,
             pe.count as project_employee_count
             FROM project_sets ps
             JOIN projects p ON ps.project_id = p.id
             LEFT JOIN (
                 SELECT project_id, COUNT(DISTINCT employee_id) as count
                 FROM project_employees
                 GROUP BY project_id
             ) pe ON ps.project_id = pe.project_id
             WHERE ps.id = $1 AND ps.project_id = $2 ${deletedFilter}`,
            [setId, projectId]
        );

        if (setResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Set not found' });
        }

        const setData = setResult.rows[0];
        const empCount = setData.project_employee_count || 1;
        const workingDays = setData.working_days || 1;
        const perHeadTarget = projectMath.perEmployeeTarget(setData.total_target, empCount);

        // Get actual work counts for this set
        const countsResult = await q(
            `SELECT pc.employee_id, e.first_name, e.last_name, e.employee_id as emp_id,
             COALESCE(SUM(pc.daily_count), 0) as total_completed,
             COUNT(pc.id) as submission_days
             FROM daily_work_counts pc
             JOIN employees e ON pc.employee_id = e.id
             WHERE pc.set_id = $1
             GROUP BY pc.employee_id, e.first_name, e.last_name, e.employee_id`,
            [setId]
        );

        // Get today's counts
        const today = new Date().toISOString().split('T')[0];
        const todayResult = await q(
            `SELECT pc.employee_id, e.first_name, e.last_name, e.employee_id as emp_id,
             pc.daily_count as today_count
             FROM daily_work_counts pc
             JOIN employees e ON pc.employee_id = e.id
             WHERE pc.set_id = $1 AND pc.work_date = $2`,
            [setId, today]
        );

        // Per-employee achievement uses the per-head share of the target, like
        // the report view; overall achievement divides by the whole set target
        // once (the old code summed total_target once per employee row,
        // inflating the denominator by team size).
        let totalActual = 0;
        let submissionCount = 0;

        const counts = countsResult.rows.map(r => {
            const completed = parseInt(r.total_completed, 10) || 0;
            totalActual += completed;
            submissionCount += parseInt(r.submission_days, 10) || 0;
            return {
                employeeId: r.employee_id,
                empId: r.emp_id,
                name: `${r.first_name} ${r.last_name}`,
                totalCompleted: completed,
                submissionDays: parseInt(r.submission_days, 10) || 0,
                achievement: projectMath.achievementPercent(completed, perHeadTarget)
            };
        });

        const overallAchievement = projectMath.achievementPercent(totalActual, setData.total_target);

        res.json({
            success: true,
            set: {
                id: setData.id,
                name: setData.name,
                projectName: setData.project_name,
                projectClient: setData.project_client,
                totalTarget: setData.total_target,
                workingDays,
                projectEmployeeCount: empCount,
                targetPerEmployee: perHeadTarget,
                dailyTargetPerEmployee: projectMath.dailyPerEmployeeTarget(setData.total_target, empCount, workingDays),
                dailyTeamTarget: workingDays > 0 ? setData.total_target / workingDays : setData.total_target,
                completionRate: overallAchievement
            },
            employees: counts,
            today: todayResult.rows,
            grandTotalActual: totalActual,
            grandTotalTarget: setData.total_target,
            overallAchievement,
            submissionCount
        });
    } catch (error) {
        console.error('Error fetching summary:', error);
        res.status(500).json({ success: false, message: (error && error.message) || 'Server error' });
    }
});

module.exports = router;