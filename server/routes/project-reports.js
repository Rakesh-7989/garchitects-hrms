const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken, isManager } = require('../middleware/auth');
const { runWithSchemaRepair } = require('../utils/schemaRepair');

const q = (sql, params) => runWithSchemaRepair(() => query(sql, params));

// Entity types the projects module writes to the audit trail (current model).
// Sets/daily work counts were removed in the 2026 reshape; only the plain
// architecture-studio model remains (project + documents + daily updates).
const PROJECT_ENTITY_TYPES = [
    'project', 'project_document', 'project_daily_update'
];

/**
 * GET /api/project-reports/overview
 * Consolidated projects dashboard (non-financial HRMS model): per-project
 * counters (assigned employees, daily updates over 7/30 days + total,
 * documents), a global summary, recent daily updates and recent documents.
 */
router.get('/overview', verifyToken, isManager, async (req, res) => {
    try {
        const projectsResult = await q(`
            SELECT p.id, p.name, COALESCE(p.client, p.customer) as client, p.description,
                   p.status, p.project_type, p.start_date, p.end_date,
                   (SELECT COUNT(*) FROM project_employees pe WHERE pe.project_id = p.id) as employees_count,
                   (SELECT COUNT(*) FROM project_documents d WHERE d.project_id = p.id) as documents_count,
                   (SELECT COUNT(*) FROM project_daily_updates u7 WHERE u7.project_id = p.id AND u7.update_date >= CURRENT_DATE - 7) as updates_7d,
                   (SELECT COUNT(*) FROM project_daily_updates u30 WHERE u30.project_id = p.id AND u30.update_date >= CURRENT_DATE - 30) as updates_30d,
                   (SELECT COUNT(*) FROM project_daily_updates ut WHERE ut.project_id = p.id) as updates_total,
                   (SELECT MAX(update_date) FROM project_daily_updates um WHERE um.project_id = p.id) as latest_update_date
            FROM projects p
            ORDER BY p.name`);
        const projects = projectsResult.rows.map(p => ({
            ...p,
            updates_7d: parseInt(p.updates_7d, 10) || 0,
            updates_30d: parseInt(p.updates_30d, 10) || 0,
            updates_total: parseInt(p.updates_total, 10) || 0,
            employees_count: parseInt(p.employees_count, 10) || 0,
            documents_count: parseInt(p.documents_count, 10) || 0
        }));

        const recentUpdates = await q(`
            SELECT pu.id, pu.project_id, pu.update_date, pu.task_cat, pu.description, pu.hours,
                   p.name as project_name,
                   e.first_name, e.last_name
            FROM project_daily_updates pu
            JOIN projects p ON p.id = pu.project_id
            JOIN employees e ON e.id = pu.employee_id
            ORDER BY pu.update_date DESC, pu.id DESC
            LIMIT 6`);

        const recentDocuments = await q(`
            SELECT pd.id, pd.title, pd.doc_type, pd.file_name, pd.created_at,
                   p.name as project_name,
                   e.first_name, e.last_name
            FROM project_documents pd
            JOIN projects p ON p.id = pd.project_id
            LEFT JOIN employees e ON e.id = pd.uploader_id
            ORDER BY pd.created_at DESC, pd.id DESC
            LIMIT 6`);

        const summary = {
            total_projects: projects.length,
            active_projects: projects.filter(p => p.status === 'active').length,
            updates_last_7_days: projects.reduce((s, p) => s + p.updates_7d, 0),
            updates_last_30_days: projects.reduce((s, p) => s + p.updates_30d, 0),
            employees_assigned: projects.reduce((s, p) => s + p.employees_count, 0),
            documents_count: projects.reduce((s, p) => s + p.documents_count, 0),
            projects_active_last_30d: projects.filter(p => p.updates_30d > 0).length
        };

        res.json({ success: true, projects, summary, recentUpdates: recentUpdates.rows, recentDocuments: recentDocuments.rows });
    } catch (error) {
        console.error('Error building project overview:', error);
        res.status(500).json({ success: false, message: (error && error.message) || 'Server error' });
    }
});

/**
 * GET /api/project-reports/activity?limit=25
 * Recent project-module activity from the audit trail - the module's own
 * notification/activity feed (no separate notifications table needed).
 */
router.get('/activity', verifyToken, isManager, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 25, 100);
        const result = await q(`
            SELECT al.id, al.action, al.entity_type, al.entity_id, al.details, al.created_at,
                   COALESCE(e.first_name || ' ' || e.last_name, 'System') as actor_name
            FROM audit_logs al
            LEFT JOIN employees e ON e.id = al.actor_id
            WHERE al.entity_type = ANY($1::text[])
            ORDER BY al.created_at DESC, al.id DESC
            LIMIT $2`, [PROJECT_ENTITY_TYPES, limit]);
        res.json({ success: true, items: result.rows });
    } catch (error) {
        console.error('Error loading project activity:', error);
        res.status(500).json({ success: false, message: (error && error.message) || 'Server error' });
    }
});

module.exports = router;