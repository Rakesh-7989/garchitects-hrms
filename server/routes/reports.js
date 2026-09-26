const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken, isAdmin } = require('../middleware/auth');
const { istDateString, istTimeString, istMonth, istYear } = require('../utils/date');

router.get('/dashboard', verifyToken, isAdmin, async (req, res) => {
    try {
        const today = istDateString();
        const now = istTimeString();
        
        const [totalEmp, presentToday, absentToday, pendingLeaves, departments, lateToday, todayRows, pendingProfileUpdates] = await Promise.all([
            query("SELECT COUNT(*) as count FROM employees WHERE status = 'active' AND role != 'admin'"),
            query("SELECT COUNT(*) as count FROM attendance WHERE date = $1 AND status IN ('present', 'late', 'half-day') AND employee_id IN (SELECT id FROM employees WHERE role != 'admin')", [today]),
            query(
                `SELECT COUNT(*) as count FROM employees
                WHERE status = 'active' AND role != 'admin'
                AND NOT EXISTS (SELECT 1 FROM holidays WHERE date = $1)
                AND (
                    id IN (
                        SELECT employee_id FROM attendance
                        WHERE date = $1 AND status = 'absent'
                        AND (remarks IS NULL OR remarks NOT LIKE 'On leave%')
                    )
                    OR (
                        id NOT IN (SELECT employee_id FROM attendance WHERE date = $1)
                        AND $2 > COALESCE((SELECT setting_value FROM company_settings WHERE setting_key = 'office_end_time'), '18:30:00')
                    )
                )`,
                [today, now]
            ),
            query("SELECT COUNT(*) as count FROM leave_applications WHERE status = 'pending'"),
            query("SELECT COUNT(*) as count FROM departments"),
            query("SELECT COUNT(*) as count FROM attendance WHERE date = $1 AND status = 'late' AND employee_id IN (SELECT id FROM employees WHERE role != 'admin')", [today]),
            query(
                `SELECT a.id, a.employee_id, a.check_in, a.check_out, a.status, a.check_in_location,
                 e.first_name, e.last_name, e.employee_id as emp_id, d.name as department_name
                 FROM attendance a
                 JOIN employees e ON a.employee_id = e.id
                 LEFT JOIN departments d ON e.department_id = d.id
                 WHERE a.date = $1 AND e.role != 'admin'
                 ORDER BY a.check_in DESC, e.first_name`,
                [today]
            ),
            query("SELECT COUNT(*) as count FROM profile_update_requests WHERE status = 'pending'")
        ]);
        
        res.json({
            success: true,
            stats: {
                totalEmployees: parseInt(totalEmp.rows[0].count),
                presentToday: parseInt(presentToday.rows[0].count),
                absentToday: parseInt(absentToday.rows[0].count),
                pendingLeaves: parseInt(pendingLeaves.rows[0].count),
                totalDepartments: parseInt(departments.rows[0].count),
                lateToday: parseInt(lateToday.rows[0].count),
                pendingProfileUpdates: parseInt(pendingProfileUpdates.rows[0].count)
            },
            todayAttendance: todayRows.rows
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.get('/employees', verifyToken, isAdmin, async (req, res) => {
    try {
        const result = await query(
            `SELECT d.name as department, COUNT(e.id) as count 
            FROM employees e 
            JOIN departments d ON e.department_id = d.id 
            WHERE e.status = 'active' AND e.role != 'admin'
            GROUP BY d.name ORDER BY d.name`
        );
        res.json({ success: true, report: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.get('/attendance', verifyToken, isAdmin, async (req, res) => {
    try {
        const { month, year } = req.query;
        const m = String(month || istMonth()).padStart(2, '0');
        const y = String(year || istYear());
        const result = await query(
            `SELECT a.status, COUNT(*) as count 
            FROM attendance a 
            WHERE to_char(a.date, 'MM') = $1 AND to_char(a.date, 'YYYY') = $2 
            GROUP BY a.status`,
            [m, y]
        );
        res.json({ success: true, report: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/reports/work-assignments
// @desc    Work assignment report: status summary, per-employee, per-project,
//          plus the 10 most recent assignments.
// @access  Private (Admin)
router.get('/work-assignments', verifyToken, isAdmin, async (req, res) => {
    try {
        const openFilter = `wa.status IN ('assigned','in_progress')`;
        const [byStatus, byEmployee, byProject, recent] = await Promise.all([
            query(`SELECT wa.status, COUNT(*)::int as count FROM work_assignments wa GROUP BY wa.status`),
            query(
                `SELECT at2.employee_id, at2.first_name, at2.last_name,
                        SUM(CASE WHEN ${openFilter} THEN 1 ELSE 0 END)::int as open_count,
                        SUM(CASE WHEN wa.status = 'completed' THEN 1 ELSE 0 END)::int as completed_count,
                        COUNT(*)::int as total
                 FROM work_assignments wa
                 JOIN employees at2 ON at2.id = wa.assigned_to
                 GROUP BY at2.id, at2.employee_id, at2.first_name, at2.last_name
                 ORDER BY open_count DESC, at2.first_name`
            ),
            query(
                `SELECT COALESCE(p.name, 'No project') as project,
                        COUNT(*)::int as total,
                        SUM(CASE WHEN ${openFilter} THEN 1 ELSE 0 END)::int as open_count,
                        SUM(CASE WHEN wa.status = 'completed' THEN 1 ELSE 0 END)::int as completed_count
                 FROM work_assignments wa
                 LEFT JOIN projects p ON p.id = wa.project_id
                 GROUP BY p.id, p.name
                 ORDER BY total DESC`
            ),
            query(
                `SELECT wa.id, wa.title, wa.status, wa.due_date, wa.completed_at, wa.created_at,
                        at2.first_name as assignee_first, at2.last_name as assignee_last,
                        at2.employee_id as assignee_code,
                        ab.first_name as assigner_first, ab.last_name as assigner_last,
                        COALESCE(p.name, '') as project_name
                 FROM work_assignments wa
                 JOIN employees at2 ON at2.id = wa.assigned_to
                 JOIN employees ab ON ab.id = wa.assigned_by
                 LEFT JOIN projects p ON p.id = wa.project_id
                 ORDER BY wa.created_at DESC
                 LIMIT 10`
            )
        ]);
        res.json({
            success: true,
            report: {
                byStatus: byStatus.rows,
                byEmployee: byEmployee.rows,
                byProject: byProject.rows,
                recent: recent.rows
            }
        });
    } catch (error) {
        console.error('Work assignments report error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;
