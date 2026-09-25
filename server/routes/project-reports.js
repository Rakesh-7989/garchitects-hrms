const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken, isAdmin } = require('../middleware/auth');
const { runWithSchemaRepair, hasColumn } = require('../utils/schemaRepair');
const { buildReportWorkbook, sendWorkbook } = require('../utils/excel');
const projectMath = require('../utils/projectMath');

const q = (sql, params) => runWithSchemaRepair(() => query(sql, params));

/**
 * GET /api/project-reports
 */
router.get('/', verifyToken, isAdmin, async (req, res) => {
    try {
        const { view, date, startDate, endDate, month, year, projectId, setId, employeeId } = req.query;

        if (!view || !['daily', 'weekly', 'monthly'].includes(view)) {
            return res.status(400).json({ success: false, message: 'View must be daily, weekly, or monthly' });
        }

        // NOTE: inner count queries use params [setId=$1, empId=$2, ...dateParams],
        // so date placeholders must start at $3 (NOT $1). Project/set/employee
        // filters are applied in JS loops below (inner query only has dwc table,
        // so pe/ps references would cause missing-FROM errors).
        let dateFilter = '';
        let dateParams = [];

        if (view === 'daily') {
            if (!date) return res.status(400).json({ success: false, message: 'Date is required for daily view' });
            dateFilter = ` AND dwc.work_date = $3::date`;
            dateParams.push(date);
        } else if (view === 'weekly') {
            if (!startDate || !endDate) return res.status(400).json({ success: false, message: 'startDate and endDate required' });
            dateFilter = ` AND dwc.work_date >= $3::date AND dwc.work_date <= $4::date`;
            dateParams.push(startDate, endDate);
        } else if (view === 'monthly') {
            if (!month || !year) return res.status(400).json({ success: false, message: 'month and year required' });
            const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
            const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
            const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
            dateFilter = ` AND dwc.work_date >= $3::date AND dwc.work_date <= $4::date`;
            dateParams.push(monthStart, monthEnd);
        }

        const filterProjectId = (projectId && projectId !== 'all') ? parseInt(projectId) : null;
        const filterSetId = (setId && setId !== 'all') ? parseInt(setId) : null;
        const filterEmployeeId = (employeeId && employeeId !== 'all') ? parseInt(employeeId) : null;

        // Simple query: get projects that have active sets and assigned employees
        // Use COALESCE for client/customer backward compat.
        // Soft-delete column is gated so legacy DBs without deleted_at still work.
        const hasSetDeletedAt = await hasColumn('project_sets', 'deleted_at');
        const setDeletedFilter = hasSetDeletedAt ? 'AND ps.deleted_at IS NULL' : '';

        const projectsResult = await q(`
            SELECT DISTINCT p.id, p.name, COALESCE(p.client, p.customer) as client, p.status
            FROM projects p
            INNER JOIN project_employees pe ON p.id = pe.project_id
            INNER JOIN project_sets ps ON ps.project_id = p.id AND ps.status = 'active' ${setDeletedFilter}
            WHERE p.status = 'active'
            ORDER BY p.name
        `, []);

        const reports = [];

        for (const project of projectsResult.rows) {
            if (filterProjectId && project.id !== filterProjectId) continue;
            const setsResult = await q(`
                SELECT ps.id, ps.name, ps.total_target, ps.working_days, ps.start_date, ps.end_date
                FROM project_sets ps
                WHERE ps.project_id = $1 AND ps.status = 'active' ${setDeletedFilter}
                ORDER BY ps.name
            `, [project.id]);

            const projectSets = [];

            for (const set of setsResult.rows) {
                if (filterSetId && set.id !== filterSetId) continue;
                const empResult = await q(`
                    SELECT e.id, e.first_name, e.last_name, e.employee_id as emp_id
                    FROM project_employees pe
                    INNER JOIN employees e ON pe.employee_id = e.id
                    WHERE pe.project_id = $1 AND e.role != 'admin'
                    ORDER BY e.first_name, e.last_name
                `, [project.id]);

                const employees = empResult.rows;
                const empCount = employees.length || 1;
                // Single source of truth for target splits (exact division - see
                // projectMath). Daily per-head target = per-head share / working days.
                const targetPerEmployee = projectMath.perEmployeeTarget(set.total_target, empCount);
                const dailyTargetPerEmployee = projectMath.dailyPerEmployeeTarget(set.total_target, empCount, set.working_days);

                const employeeData = [];

                for (const emp of employees) {
                    if (filterEmployeeId && emp.id !== filterEmployeeId) continue;
                    let actualCounts = {};
                    let totalActual = 0;

                    if (view === 'daily') {
                        const countResult = await q(`
                            SELECT COALESCE(SUM(dwc.daily_count), 0) as count
                            FROM daily_work_counts dwc
                            WHERE dwc.set_id = $1 AND dwc.employee_id = $2 ${dateFilter}
                        `, [set.id, emp.id, ...dateParams]);
                        actualCounts.today = parseInt(countResult.rows[0].count) || 0;
                        totalActual = actualCounts.today;
                    } else {
                        const countResult = await q(`
                            SELECT dwc.work_date, dwc.daily_count
                            FROM daily_work_counts dwc
                            WHERE dwc.set_id = $1 AND dwc.employee_id = $2 ${dateFilter}
                            ORDER BY dwc.work_date
                        `, [set.id, emp.id, ...dateParams]);
                        countResult.rows.forEach(r => {
                            const dayKey = new Date(r.work_date).toISOString().split('T')[0];
                            actualCounts[dayKey] = parseInt(r.daily_count) || 0;
                            totalActual += actualCounts[dayKey];
                        });
                    }

                    const achievement = targetPerEmployee > 0 ? (totalActual / targetPerEmployee * 100) : 0;

                    employeeData.push({
                        employee: emp,
                        actualCounts,
                        totalActual,
                        achievement: projectMath.achievementPercent(totalActual, targetPerEmployee),
                        status: achievement >= 100 ? 'ACHIEVED' : 'BELOW'
                    });
                }

                const setTotalActual = employeeData.reduce((sum, e) => sum + e.totalActual, 0);

                projectSets.push({
                    set: {
                        id: set.id, name: set.name,
                        totalTarget: set.total_target, workingDays: set.working_days,
                        targetPerEmployee, dailyTargetPerEmployee,
                        startDate: set.start_date, endDate: set.end_date
                    },
                    employees: employeeData,
                    setTotalActual,
                    setTotalTarget: set.total_target,
                    setOverallAchievement: projectMath.achievementPercent(setTotalActual, set.total_target)
                });
            }

            const projectTotalActual = projectSets.reduce((sum, s) => sum + s.setTotalActual, 0);
            const projectTotalTarget = projectSets.reduce((sum, s) => sum + s.setTotalTarget, 0);

            reports.push({
                project: { id: project.id, name: project.name, client: project.client, status: project.status },
                sets: projectSets,
                projectTotalActual,
                projectTotalTarget,
                projectOverallAchievement: projectMath.achievementPercent(projectTotalActual, projectTotalTarget)
            });
        }

        const grandTotalActual = reports.reduce((sum, p) => sum + p.projectTotalActual, 0);
        const grandTotalTarget = reports.reduce((sum, p) => sum + p.projectTotalTarget, 0);

        res.json({
            success: true, view,
            date: date || null, startDate: startDate || null, endDate: endDate || null,
            month: month || null, year: year || null,
            projects: reports,
            grandTotal: {
                totalActual: grandTotalActual,
                totalTarget: grandTotalTarget,
                overallAchievement: projectMath.achievementPercent(grandTotalActual, grandTotalTarget)
            }
        });
    } catch (error) {
        console.error('Error generating project report:', error);
        res.status(500).json({ success: false, message: (error && error.message) || 'Server error' });
    }
});

/**
 * GET /api/project-reports/projects
 */
router.get('/projects', verifyToken, isAdmin, async (req, res) => {
    try {
        const result = await q(
            `SELECT id, name, COALESCE(client, customer) as client, status FROM projects WHERE status = 'active' ORDER BY name`
        );
        res.json({ success: true, projects: result.rows });
    } catch (error) {
        console.error('Error fetching projects:', error);
        res.status(500).json({ success: false, message: (error && error.message) || 'Server error' });
    }
});

/**
 * GET /api/project-reports/sets/:projectId
 */
router.get('/sets/:projectId', verifyToken, isAdmin, async (req, res) => {
    try {
        const result = await q(
            `SELECT id, name, total_target, working_days, start_date, end_date, status
             FROM project_sets WHERE project_id = $1 AND status = 'active' ORDER BY name`,
            [req.params.projectId]
        );
        res.json({ success: true, sets: result.rows });
    } catch (error) {
        console.error('Error fetching sets:', error);
        res.status(500).json({ success: false, message: (error && error.message) || 'Server error' });
    }
});

/**
 * GET /api/project-reports/employees/:projectId
 */
router.get('/employees/:projectId', verifyToken, isAdmin, async (req, res) => {
    try {
        const result = await q(
            `SELECT e.id, e.employee_id, e.first_name, e.last_name
             FROM project_employees pe
             INNER JOIN employees e ON pe.employee_id = e.id
             WHERE pe.project_id = $1 AND e.role != 'admin'
             ORDER BY e.first_name, e.last_name`,
            [req.params.projectId]
        );
        res.json({ success: true, employees: result.rows });
    } catch (error) {
        console.error('Error fetching employees:', error);
        res.status(500).json({ success: false, message: (error && error.message) || 'Server error' });
    }
});

/**
 * GET /api/project-reports/all-employees
 * All employees across all active projects (for "All Projects" filter)
 */
router.get('/all-employees', verifyToken, isAdmin, async (req, res) => {
    try {
        const result = await q(
            `SELECT DISTINCT e.id, e.employee_id, e.first_name, e.last_name,
                    STRING_AGG(DISTINCT p.name, ', ') as project_names
             FROM project_employees pe
             INNER JOIN employees e ON pe.employee_id = e.id
             INNER JOIN projects p ON p.id = pe.project_id
             WHERE p.status = 'active' AND e.role != 'admin'
             GROUP BY e.id, e.employee_id, e.first_name, e.last_name
             ORDER BY e.first_name, e.last_name`
        );
        res.json({ success: true, employees: result.rows });
    } catch (error) {
        console.error('Error fetching all employees:', error);
        res.status(500).json({ success: false, message: (error && error.message) || 'Server error' });
    }
});

/**
 * GET /api/project-reports/all-sets
 * All active sets across all active projects (for "All Projects" filter)
 */
router.get('/all-sets', verifyToken, isAdmin, async (req, res) => {
    try {
        const hasSetDeletedAt = await hasColumn('project_sets', 'deleted_at');
        const setDeletedFilter = hasSetDeletedAt ? 'AND ps.deleted_at IS NULL' : '';
        const result = await q(
            `SELECT ps.id, ps.name, ps.project_id, p.name as project_name
             FROM project_sets ps
             INNER JOIN projects p ON p.id = ps.project_id
             WHERE ps.status = 'active' ${setDeletedFilter} AND p.status = 'active'
             ORDER BY p.name, ps.name`
        );
        res.json({ success: true, sets: result.rows });
    } catch (error) {
        console.error('Error fetching all sets:', error);
        res.status(500).json({ success: false, message: (error && error.message) || 'Server error' });
    }
});

/**
 * GET /api/project-reports/export
 */
router.get('/export', verifyToken, isAdmin, async (req, res) => {
    try {
        const { view, date, startDate, endDate, month, year, projectId, setId, employeeId } = req.query;
        if (!view || !['daily', 'weekly', 'monthly'].includes(view)) {
            return res.status(400).json({ success: false, message: 'View must be daily, weekly, or monthly' });
        }

        // Same as main endpoint: inner queries use [setId=$1, empId=$2, ...dates]
        // so date placeholders start at $3. Project/set/employee filters applied in JS.
        let dateFilter = '';
        let dateParams = [];

        if (view === 'daily') {
            if (!date) return res.status(400).json({ success: false, message: 'Date required' });
            dateFilter = ` AND dwc.work_date = $3::date`;
            dateParams.push(date);
        } else if (view === 'weekly') {
            if (!startDate || !endDate) return res.status(400).json({ success: false, message: 'Dates required' });
            dateFilter = ` AND dwc.work_date >= $3::date AND dwc.work_date <= $4::date`;
            dateParams.push(startDate, endDate);
        } else if (view === 'monthly') {
            if (!month || !year) return res.status(400).json({ success: false, message: 'Month/year required' });
            const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
            const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
            const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
            dateFilter = ` AND dwc.work_date >= $3::date AND dwc.work_date <= $4::date`;
            dateParams.push(monthStart, monthEnd);
        }

        const filterProjectId = (projectId && projectId !== 'all') ? parseInt(projectId) : null;
        const filterSetId = (setId && setId !== 'all') ? parseInt(setId) : null;
        const filterEmployeeId = (employeeId && employeeId !== 'all') ? parseInt(employeeId) : null;

        const columns = [];
        if (view === 'daily') {
            columns.push(
                { header: 'PROJECT', key: 'project', width: 20 },
                { header: 'SET', key: 'set', width: 15 },
                { header: 'EMPLOYEE', key: 'employee', width: 20 },
                { header: 'TARGET', key: 'target', width: 10, type: 'number', total: true },
                { header: 'DAILY TARGET', key: 'dailyTarget', width: 12, type: 'number' },
                { header: `${date} ACTUAL`, key: 'actual', width: 12, type: 'number', total: true },
                { header: 'ACHIEVEMENT %', key: 'achievement', width: 14, type: 'percent' },
                { header: 'STATUS', key: 'status', width: 12, type: 'status' }
            );
        } else if (view === 'weekly') {
            columns.push(
                { header: 'PROJECT', key: 'project', width: 20 },
                { header: 'SET', key: 'set', width: 15 },
                { header: 'EMPLOYEE', key: 'employee', width: 20 },
                { header: 'TARGET', key: 'target', width: 10, type: 'number', total: true },
                { header: 'DAILY TARGET', key: 'dailyTarget', width: 12, type: 'number' }
            );
            if (startDate && endDate) {
                const dayNames = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
                for (let d = new Date(startDate); d <= new Date(endDate); d.setDate(d.getDate() + 1)) {
                    columns.push({ header: `${dayNames[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}`, key: `day_${d.toISOString().split('T')[0]}`, width: 10, type: 'number', total: true });
                }
            }
            columns.push(
                { header: 'TOTAL', key: 'totalActual', width: 12, type: 'number', total: true },
                { header: 'ACHIEVEMENT %', key: 'achievement', width: 14, type: 'percent' },
                { header: 'STATUS', key: 'status', width: 12, type: 'status' }
            );
        } else if (view === 'monthly') {
            columns.push(
                { header: 'PROJECT', key: 'project', width: 20 },
                { header: 'SET', key: 'set', width: 15 },
                { header: 'EMPLOYEE', key: 'employee', width: 20 },
                { header: 'TARGET', key: 'target', width: 10, type: 'number', total: true },
                { header: 'DAILY TARGET', key: 'dailyTarget', width: 12, type: 'number' }
            );
            const dayNames = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
            const lastDay = new Date(year, month, 0).getDate();
            for (let d = 1; d <= lastDay; d++) {
                const dateObj = new Date(year, month - 1, d);
                columns.push({ header: `${String(d).padStart(2, '0')} ${dayNames[dateObj.getDay()]}`, key: `day_${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`, width: 8, type: 'number', total: true });
            }
            columns.push(
                { header: 'TOTAL', key: 'totalActual', width: 12, type: 'number', total: true },
                { header: 'ACHIEVEMENT %', key: 'achievement', width: 14, type: 'percent' },
                { header: 'STATUS', key: 'status', width: 12, type: 'status' }
            );
        }

        const rows = [];
        const projectsResult = await q(`SELECT DISTINCT p.id, p.name, COALESCE(p.client, p.customer) as client
            FROM projects p
            INNER JOIN project_employees pe ON p.id = pe.project_id
            INNER JOIN project_sets ps ON ps.project_id = p.id AND ps.status = 'active'
            WHERE p.status = 'active' ORDER BY p.name`);

        const hasSetDeletedAt = await hasColumn('project_sets', 'deleted_at');
        const setDeletedFilter = hasSetDeletedAt ? 'AND ps.deleted_at IS NULL' : '';

        for (const project of projectsResult.rows) {
            if (filterProjectId && project.id !== filterProjectId) continue;
            const setsResult = await q(`SELECT ps.id, ps.name, ps.total_target, ps.working_days
                FROM project_sets ps WHERE ps.project_id = $1 AND ps.status = 'active' ${setDeletedFilter} ORDER BY ps.name`, [project.id]);
            for (const set of setsResult.rows) {
                if (filterSetId && set.id !== filterSetId) continue;
                const empResult = await q(`SELECT e.id, e.first_name, e.last_name FROM project_employees pe INNER JOIN employees e ON pe.employee_id = e.id WHERE pe.project_id = $1 AND e.role != 'admin' ORDER BY e.first_name`, [project.id]);
                const empCount = empResult.rows.length || 1;
                const targetPerEmployee = projectMath.perEmployeeTarget(set.total_target, empCount);
                const dailyTarget = projectMath.dailyPerEmployeeTarget(set.total_target, empCount, set.working_days);

                for (const emp of empResult.rows) {
                    if (filterEmployeeId && emp.id !== filterEmployeeId) continue;
                    const row = { project: project.name, set: set.name, employee: `${emp.first_name} ${emp.last_name || ''}`, target: targetPerEmployee, dailyTarget };
                    let totalActual = 0;

                    if (view === 'daily') {
                        const cr = await q(`SELECT COALESCE(SUM(dwc.daily_count), 0) as count FROM daily_work_counts dwc WHERE dwc.set_id = $1 AND dwc.employee_id = $2 ${dateFilter}`, [set.id, emp.id, ...dateParams]);
                        row.actual = parseInt(cr.rows[0].count) || 0;
                        totalActual = row.actual;
                    } else {
                        const cr = await q(`SELECT dwc.work_date, dwc.daily_count FROM daily_work_counts dwc WHERE dwc.set_id = $1 AND dwc.employee_id = $2 ${dateFilter} ORDER BY dwc.work_date`, [set.id, emp.id, ...dateParams]);
                        cr.rows.forEach(r => {
                            const dayKey = `day_${new Date(r.work_date).toISOString().split('T')[0]}`;
                            row[dayKey] = parseInt(r.daily_count) || 0;
                            totalActual += row[dayKey];
                        });
                        row.totalActual = totalActual;
                    }
                    row.achievement = projectMath.achievementPercent(totalActual, targetPerEmployee);
                    row.status = row.achievement >= 100 ? 'ACHIEVED' : 'BELOW';
                    rows.push(row);
                }
            }
        }

        const reportName = `${view.charAt(0).toUpperCase() + view.slice(1)} Project Report`;
        let subtitle = '';
        if (view === 'daily' && date) subtitle = `Date: ${date}`;
        else if (view === 'weekly' && startDate && endDate) subtitle = `${startDate} to ${endDate}`;
        else if (view === 'monthly' && month && year) subtitle = `${['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][parseInt(month)]} ${year}`;

        const workbook = await buildReportWorkbook({ reportName, subtitleExtra: subtitle, columns, rows, footerNote: `View: ${view}` });
        const filename = `project-report-${view}-${Date.now()}.xlsx`;
        await sendWorkbook(res, workbook, filename);
    } catch (error) {
        console.error('Error exporting project report:', error);
        res.status(500).json({ success: false, message: (error && error.message) || 'Server error' });
    }
});

module.exports = router;
