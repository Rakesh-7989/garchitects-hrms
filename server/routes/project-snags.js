const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken, isAdmin } = require('../middleware/auth');
const { runWithSchemaRepair } = require('../utils/schemaRepair');
const { logAudit } = require('../utils/audit');

const q = (sql, params) => runWithSchemaRepair(() => query(sql, params));

const SNAG_STATUSES = ['open', 'in_progress', 'resolved', 'closed'];
const SNAG_SEVERITIES = ['low', 'medium', 'high', 'critical'];
const SNAG_CATEGORIES = ['safety', 'quality', 'design', 'material', 'workmanship', 'other'];

/**
 * GET /api/project-snags/:projectId
 * Snag list for one project with assignee/creator names. Also returns openCount
 * (open + in_progress) used by cards and the closeout readiness summary.
 */
router.get('/:projectId', verifyToken, isAdmin, async (req, res) => {
    try {
        const result = await q(`
            SELECT s.*,
                   COALESCE(a.first_name || ' ' || a.last_name, '') AS assignee_name,
                   COALESCE(c.first_name || ' ' || c.last_name, '') AS creator_name
            FROM project_snags s
            LEFT JOIN employees a ON a.id = s.assigned_to
            LEFT JOIN employees c ON c.id = s.created_by
            WHERE s.project_id = $1
            ORDER BY s.status = 'open' DESC, s.status = 'in_progress' DESC,
                     s.status = 'resolved' DESC, s.due_date NULLS LAST, s.id DESC`,
            [req.params.projectId]);
        const snags = result.rows;
        const openCount = snags.filter(s => s.status === 'open' || s.status === 'in_progress').length;
        res.json({ success: true, snags, openCount });
    } catch (error) {
        console.error('Error listing project snags:', error);
        res.status(500).json({ success: false, message: (error && error.message) || 'Server error' });
    }
});

/**
 * POST /api/project-snags/:projectId
 * Create a snag. Always starts as `open`; severity/category/due/assignee optional.
 */
router.post('/:projectId', verifyToken, isAdmin, async (req, res) => {
    try {
        const projectId = parseInt(req.params.projectId, 10);
        if (!Number.isFinite(projectId)) return res.status(400).json({ success: false, message: 'Invalid project id' });
        const { title, description, category, severity, assigned_to, due_date, note } = req.body || {};
        const cleanTitle = (title || '').trim();
        if (!cleanTitle) return res.status(400).json({ success: false, message: 'Snag title is required' });

        const cat = SNAG_CATEGORIES.includes(category) ? category : 'quality';
        const sev = SNAG_SEVERITIES.includes(severity) ? severity : 'medium';

        const result = await q(
            `INSERT INTO project_snags (project_id, title, description, category, severity, status, assigned_to, due_date, created_by)
             VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, $8)
             RETURNING *`,
            [projectId, cleanTitle, (description || '').trim() || null, cat, sev, assigned_to || null, due_date || null, req.user.id]
        );

        logAudit({
            actorId: req.user.id,
            action: 'snag.create',
            entityType: 'project_snag',
            entityId: result.rows[0].id,
            details: { projectId, title: cleanTitle, severity: sev, note: (note || '').trim() || null },
            ip: req.ip
        });
        res.status(201).json({ success: true, snag: result.rows[0] });
    } catch (error) {
        console.error('Error creating project snag:', error);
        res.status(500).json({ success: false, message: (error && error.message) || 'Server error' });
    }
});

/**
 * PUT /api/project-snags/:projectId/:id
 * Update fields and/or move through the snag lifecycle. Resolving sets
 * resolved_at/by, closing sets closed_at/by; reopening to open/in_progress
 * clears both. `note` is only an audit detail, never written to a column.
 */
router.put('/:projectId/:id', verifyToken, isAdmin, async (req, res) => {
    try {
        const { title, description, category, severity, assigned_to, due_date, status, note } = req.body || {};
        const found = await q('SELECT * FROM project_snags WHERE id = $1 AND project_id = $2', [req.params.id, req.params.projectId]);
        if (found.rows.length === 0) return res.status(404).json({ success: false, message: 'Snag not found' });
        const snag = found.rows[0];

        const cat = SNAG_CATEGORIES.includes(category) ? category : snag.category;
        const sev = SNAG_SEVERITIES.includes(severity) ? severity : snag.severity;
        const nextStatus = SNAG_STATUSES.includes(status) ? status : snag.status;
        const cleanTitle = (title || '').trim();

        let resolvedAt = snag.resolved_at, resolvedBy = snag.resolved_by;
        let closedAt = snag.closed_at, closedBy = snag.closed_by;
        if (nextStatus === 'resolved' && snag.status !== 'resolved' && snag.status !== 'closed') {
            resolvedAt = new Date(); resolvedBy = req.user.id;
        } else if (nextStatus === 'closed' && snag.status !== 'closed') {
            closedAt = new Date(); closedBy = req.user.id;
            // Resolving and closing in one step still records the resolve moment.
            if (!resolvedAt) { resolvedAt = resolvedAt || closedAt; resolvedBy = resolvedBy || req.user.id; }
        }
        if (nextStatus === 'open' || nextStatus === 'in_progress') {
            resolvedAt = null; resolvedBy = null; closedAt = null; closedBy = null;
        }

        const result = await q(
            `UPDATE project_snags SET
                title = $1, description = $2, category = $3, severity = $4,
                assigned_to = $5, due_date = $6, status = $7,
                resolved_at = $8, resolved_by = $9, closed_at = $10, closed_by = $11,
                updated_at = NOW()
             WHERE id = $12 AND project_id = $13
             RETURNING *`,
            [
                cleanTitle || snag.title, (description || '').trim() || null, cat, sev,
                assigned_to != null ? assigned_to : snag.assigned_to,
                due_date != null ? due_date : snag.due_date,
                nextStatus, resolvedAt, resolvedBy, closedAt, closedBy,
                req.params.id, req.params.projectId
            ]
        );

        logAudit({
            actorId: req.user.id,
            action: snag.status !== nextStatus ? 'snag.status' : 'snag.update',
            entityType: 'project_snag',
            entityId: Number(req.params.id),
            details: { projectId: Number(req.params.projectId), title: result.rows[0].title, previous: snag.status, status: nextStatus, note: (note || '').trim() || null },
            ip: req.ip
        });
        res.json({ success: true, snag: result.rows[0] });
    } catch (error) {
        console.error('Error updating project snag:', error);
        res.status(500).json({ success: false, message: (error && error.message) || 'Server error' });
    }
});

/**
 * DELETE /api/project-snags/:projectId/:id
 */
router.delete('/:projectId/:id', verifyToken, isAdmin, async (req, res) => {
    try {
        const found = await q('SELECT * FROM project_snags WHERE id = $1 AND project_id = $2', [req.params.id, req.params.projectId]);
        if (found.rows.length === 0) return res.status(404).json({ success: false, message: 'Snag not found' });
        await q('DELETE FROM project_snags WHERE id = $1 AND project_id = $2', [req.params.id, req.params.projectId]);
        logAudit({
            actorId: req.user.id,
            action: 'snag.delete',
            entityType: 'project_snag',
            entityId: Number(req.params.id),
            details: { projectId: Number(req.params.projectId), title: found.rows[0].title },
            ip: req.ip
        });
        res.json({ success: true, message: 'Snag deleted' });
    } catch (error) {
        console.error('Error deleting project snag:', error);
        res.status(500).json({ success: false, message: (error && error.message) || 'Server error' });
    }
});

module.exports = router;