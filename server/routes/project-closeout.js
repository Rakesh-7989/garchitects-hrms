const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken, isAdmin } = require('../middleware/auth');
const { runWithSchemaRepair } = require('../utils/schemaRepair');
const { logAudit } = require('../utils/audit');

const q = (sql, params) => runWithSchemaRepair(() => query(sql, params));

// Standard handover checklist used by real firms. Loaded per project on demand
// (POST /:projectId/defaults) so nothing is inserted just by reading.
const DEFAULT_CLOSEOUT_ITEMS = [
    { name: 'All snags resolved', category: 'snags' },
    { name: 'As-built drawings submitted', category: 'document' },
    { name: 'Operation & maintenance manuals handed over', category: 'document' },
    { name: 'Warranty certificates collected', category: 'document' },
    { name: 'Final RA bill raised', category: 'obligation' },
    { name: 'Retention released', category: 'obligation' },
    { name: 'Client / PMC handover meeting held', category: 'handover' },
    { name: 'Keys & site access handed over', category: 'handover' },
    { name: 'Labour register finalised & closed', category: 'document' },
    { name: 'Material balances reconciled', category: 'obligation' }
];

/**
 * GET /api/project-closeout/:projectId
 * Checklist items + a readiness summary computed from the module's own data:
 * snag counts, DPR count, invoice/retention position and checklist % complete.
 */
router.get('/:projectId', verifyToken, isAdmin, async (req, res) => {
    try {
        const projectId = parseInt(req.params.projectId, 10);
        if (!Number.isFinite(projectId)) return res.status(400).json({ success: false, message: 'Invalid project id' });

        const itemsResult = await q(
            `SELECT ci.*, COALESCE(e.first_name || ' ' || e.last_name, '') AS completed_by_name
             FROM project_closeout_items ci
             LEFT JOIN employees e ON e.id = ci.completed_by
             WHERE ci.project_id = $1
             ORDER BY ci.category, ci.is_completed ASC, ci.id`,
            [projectId]
        );

        const [snagsResult, dprResult, invResult] = await Promise.all([
            q(`SELECT COUNT(*)::int AS total,
                      COUNT(*) FILTER (WHERE status IN ('open', 'in_progress'))::int AS open_count,
                      COUNT(*) FILTER (WHERE status = 'resolved')::int AS resolved_count
               FROM project_snags WHERE project_id = $1`, [projectId]),
            q(`SELECT COUNT(*)::int AS count FROM project_daily_reports WHERE project_id = $1`, [projectId]),
            q(`SELECT COUNT(*)::int AS total,
                      COALESCE(SUM(net_value), 0) AS net,
                      COALESCE(SUM(retention_amount), 0) AS retention,
                      COALESCE(SUM(payment_received), 0) AS received
               FROM project_invoices WHERE project_id = $1`, [projectId])
        ]);

        const items = itemsResult.rows;
        const total = items.length;
        const completed = items.filter(i => i.is_completed).length;
        const inv = invResult.rows[0] || { total: 0, net: 0, retention: 0, received: 0 };

        res.json({
            success: true,
            items,
            summary: {
                total,
                completed,
                percent: total ? Math.round((completed / total) * 100) : 0,
                snags: snagsResult.rows[0] || { total: 0, open_count: 0, resolved_count: 0 },
                dpr_count: (dprResult.rows[0] && dprResult.rows[0].count) || 0,
                invoices: {
                    total: inv.total || 0,
                    net: Number(inv.net) || 0,
                    retention: Number(inv.retention) || 0,
                    received: Number(inv.received) || 0
                }
            }
        });
    } catch (error) {
        console.error('Error loading project closeout:', error);
        res.status(500).json({ success: false, message: (error && error.message) || 'Server error' });
    }
});

/**
 * POST /api/project-closeout/:projectId/defaults
 * Seeds the standard closeout checklist only for items not already present.
 */
router.post('/:projectId/defaults', verifyToken, isAdmin, async (req, res) => {
    try {
        const projectId = parseInt(req.params.projectId, 10);
        if (!Number.isFinite(projectId)) return res.status(400).json({ success: false, message: 'Invalid project id' });

        let added = 0;
        for (const item of DEFAULT_CLOSEOUT_ITEMS) {
            const result = await q(
                `INSERT INTO project_closeout_items (project_id, item_name, category)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (project_id, item_name) DO NOTHING
                 RETURNING id`,
                [projectId, item.name, item.category]
            );
            if (result.rows.length > 0) added++;
        }
        logAudit({
            actorId: req.user.id,
            action: 'closeout.defaults',
            entityType: 'project_closeout_item',
            entityId: projectId,
            details: { projectId, added },
            ip: req.ip
        });
        const items = await q('SELECT * FROM project_closeout_items WHERE project_id = $1 ORDER BY category, id', [projectId]);
        res.json({ success: true, added, items: items.rows });
    } catch (error) {
        console.error('Error seeding closeout defaults:', error);
        res.status(500).json({ success: false, message: (error && error.message) || 'Server error' });
    }
});

/**
 * POST /api/project-closeout/:projectId/items
 * Add a single checklist item (skips silently if an item with this name exists).
 */
router.post('/:projectId/items', verifyToken, isAdmin, async (req, res) => {
    try {
        const projectId = parseInt(req.params.projectId, 10);
        const { item_name, category, notes } = req.body || {};
        const cleanName = (item_name || '').trim();
        if (!Number.isFinite(projectId)) return res.status(400).json({ success: false, message: 'Invalid project id' });
        if (!cleanName) return res.status(400).json({ success: false, message: 'Checklist item name is required' });

        const result = await q(
            `INSERT INTO project_closeout_items (project_id, item_name, category, notes)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (project_id, item_name) DO NOTHING
             RETURNING *`,
            [projectId, cleanName, (category || '').trim() || 'handover', (notes || '').trim() || null]
        );
        if (result.rows.length === 0) {
            return res.status(409).json({ success: false, message: 'An item with that name is already on the checklist' });
        }
        logAudit({
            actorId: req.user.id,
            action: 'closeout.add',
            entityType: 'project_closeout_item',
            entityId: result.rows[0].id,
            details: { projectId, item_name: cleanName, category: result.rows[0].category },
            ip: req.ip
        });
        res.status(201).json({ success: true, item: result.rows[0] });
    } catch (error) {
        console.error('Error adding closeout item:', error);
        res.status(500).json({ success: false, message: (error && error.message) || 'Server error' });
    }
});

/**
 * PUT /api/project-closeout/:projectId/items/:id
 * Edit name/category/notes and toggle completion. Completion stamps
 * completed_at/by; un-checking clears them.
 */
router.put('/:projectId/items/:id', verifyToken, isAdmin, async (req, res) => {
    try {
        const { item_name, category, notes, is_completed } = req.body || {};
        const found = await q('SELECT * FROM project_closeout_items WHERE id = $1 AND project_id = $2', [req.params.id, req.params.projectId]);
        if (found.rows.length === 0) return res.status(404).json({ success: false, message: 'Checklist item not found' });
        const item = found.rows[0];

        let completedAt = item.completed_at;
        let completedBy = item.completed_by;
        if (typeof is_completed === 'boolean') {
            if (is_completed && !item.is_completed) {
                completedAt = new Date(); completedBy = req.user.id;
            } else if (!is_completed) {
                completedAt = null; completedBy = null;
            }
        }

        const result = await q(
            `UPDATE project_closeout_items SET
                item_name = $1, category = $2, notes = $3,
                is_completed = $4, completed_at = $5, completed_by = $6,
                updated_at = NOW()
             WHERE id = $7 AND project_id = $8
             RETURNING *`,
            [
                (item_name || '').trim() || item.item_name,
                (category || '').trim() || item.category,
                notes != null ? (notes || '').trim() || null : item.notes,
                typeof is_completed === 'boolean' ? is_completed : item.is_completed,
                completedAt, completedBy,
                req.params.id, req.params.projectId
            ]
        );
        const done = !!result.rows[0].is_completed;
        logAudit({
            actorId: req.user.id,
            action: done ? 'closeout.complete' : (is_completed === false ? 'closeout.reopen' : 'closeout.update'),
            entityType: 'project_closeout_item',
            entityId: Number(req.params.id),
            details: { projectId: Number(req.params.projectId), item_name: result.rows[0].item_name, is_completed: done },
            ip: req.ip
        });
        res.json({ success: true, item: result.rows[0] });
    } catch (error) {
        console.error('Error updating closeout item:', error);
        res.status(500).json({ success: false, message: (error && error.message) || 'Server error' });
    }
});

/**
 * DELETE /api/project-closeout/:projectId/items/:id
 */
router.delete('/:projectId/items/:id', verifyToken, isAdmin, async (req, res) => {
    try {
        const found = await q('SELECT * FROM project_closeout_items WHERE id = $1 AND project_id = $2', [req.params.id, req.params.projectId]);
        if (found.rows.length === 0) return res.status(404).json({ success: false, message: 'Checklist item not found' });
        await q('DELETE FROM project_closeout_items WHERE id = $1 AND project_id = $2', [req.params.id, req.params.projectId]);
        logAudit({
            actorId: req.user.id,
            action: 'closeout.remove',
            entityType: 'project_closeout_item',
            entityId: Number(req.params.id),
            details: { projectId: Number(req.params.projectId), item_name: found.rows[0].item_name },
            ip: req.ip
        });
        res.json({ success: true, message: 'Checklist item removed' });
    } catch (error) {
        console.error('Error deleting closeout item:', error);
        res.status(500).json({ success: false, message: (error && error.message) || 'Server error' });
    }
});

module.exports = router;