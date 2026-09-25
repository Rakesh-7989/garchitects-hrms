const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken, isAdmin } = require('../middleware/auth');
const { runWithSchemaRepair, pgErrorResponse } = require('../utils/schemaRepair');
const { logAudit } = require('../utils/audit');

const q = (sql, params) => runWithSchemaRepair(() => query(sql, params));

function parseMaterial(body) {
    const has = (k) => body[k] !== undefined && body[k] !== null && String(body[k]) !== '';
    const material = has('material') ? String(body.material).trim() : '';
    if (!material) return { ok: false, status: 400, message: 'Material name is required' };
    const quantity = has('quantity') ? Number(body.quantity) : null;
    if (quantity === null || !Number.isFinite(quantity) || quantity < 0) {
        return { ok: false, status: 400, message: 'Quantity must be 0 or more' };
    }
    const qtyUsed = has('qty_used') ? Number(body.qty_used) : 0;
    if (!Number.isFinite(qtyUsed) || qtyUsed < 0) {
        return { ok: false, status: 400, message: 'Quantity used must be 0 or more' };
    }
    if (qtyUsed > quantity) {
        return { ok: false, status: 400, message: 'Quantity used cannot exceed quantity received' };
    }
    return {
        ok: true,
        values: {
            material,
            unit: has('unit') ? String(body.unit).trim() : 'nos',
            quantity,
            qty_used: qtyUsed,
            received_on: has('received_on') ? String(body.received_on).slice(0, 10) : null,
            vendor: has('vendor') ? String(body.vendor).trim() : null,
            purpose: has('purpose') ? String(body.purpose).trim() : null,
            notes: has('notes') ? String(body.notes).trim() : null
        }
    };
}

function mapQty(row) {
    if (!row) return row;
    return {
        ...row,
        quantity: row.quantity != null ? Math.round(Number(row.quantity) * 100) / 100 : null,
        qty_used: row.qty_used != null ? Math.round(Number(row.qty_used) * 100) / 100 : null,
        balance: row.quantity != null && row.qty_used != null ? Math.round((Number(row.quantity) - Number(row.qty_used)) * 100) / 100 : null
    };
}

/**
 * GET /api/project-materials/:projectId
 * Materials register with running balance (received - used).
 */
router.get('/:projectId', verifyToken, isAdmin, async (req, res) => {
    try {
        const result = await q(
            `SELECT m.*, COALESCE(e.first_name || ' ' || e.last_name, '') as created_by_name
             FROM project_materials m
             LEFT JOIN employees e ON e.id = m.created_by
             WHERE m.project_id = $1
             ORDER BY m.received_on DESC NULLS LAST, m.id DESC`,
            [req.params.projectId]
        );
        const rows = result.rows.map(mapQty);
        let totalQty = 0, totalUsed = 0, entries = 0;
        for (const r of rows) { totalQty += r.quantity || 0; totalUsed += r.qty_used || 0; entries++; }
        res.json({
            success: true,
            materials: rows,
            summary: {
                entries,
                total_quantity: Math.round(totalQty * 100) / 100,
                total_used: Math.round(totalUsed * 100) / 100,
                total_balance: Math.round((totalQty - totalUsed) * 100) / 100
            }
        });
    } catch (error) {
        console.error(`Error listing materials for project ${req.params.projectId}:`, error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

/**
 * POST /api/project-materials/:projectId
 * Record a material receipt (or a usage-only line with qty_used).
 */
router.post('/:projectId', verifyToken, isAdmin, async (req, res) => {
    try {
        const parsed = parseMaterial(req.body);
        if (!parsed.ok) return res.status(parsed.status).json({ success: false, message: parsed.message });
        const v = parsed.values;
        const proj = await q(`SELECT id FROM projects WHERE id = $1`, [req.params.projectId]);
        if (!proj.rows.length) return res.status(404).json({ success: false, message: 'Project not found' });
        const result = await q(
            `INSERT INTO project_materials (project_id, material, unit, quantity, qty_used, received_on, vendor, purpose, notes, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING *`,
            [req.params.projectId, v.material, v.unit, v.quantity, v.qty_used, v.received_on, v.vendor, v.purpose, v.notes, req.user.id]
        );
        logAudit({
            actorId: req.user.id, action: 'material.create', entityType: 'project_material',
            entityId: result.rows[0].id, details: { projectId: req.params.projectId, material: v.material, quantity: v.quantity },
            ip: req.ip
        });
        res.json({ success: true, material: mapQty(result.rows[0]) });
    } catch (error) {
        console.error(`Error creating material for project ${req.params.projectId}:`, error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

/**
 * PUT /api/project-materials/:projectId/:id
 * Update a material line.
 */
router.put('/:projectId/:id', verifyToken, isAdmin, async (req, res) => {
    try {
        const parsed = parseMaterial(req.body);
        if (!parsed.ok) return res.status(parsed.status).json({ success: false, message: parsed.message });
        const v = parsed.values;
        const result = await q(
            `UPDATE project_materials SET
                material = $1, unit = $2, quantity = $3, qty_used = $4,
                received_on = $5, vendor = $6, purpose = $7, notes = $8, updated_at = NOW()
             WHERE project_id = $9 AND id = $10
             RETURNING *`,
            [v.material, v.unit, v.quantity, v.qty_used, v.received_on, v.vendor, v.purpose, v.notes, req.params.projectId, req.params.id]
        );
        if (!result.rows.length) return res.status(404).json({ success: false, message: 'Material entry not found' });
        logAudit({
            actorId: req.user.id, action: 'material.update', entityType: 'project_material',
            entityId: result.rows[0].id, details: { projectId: req.params.projectId, material: v.material },
            ip: req.ip
        });
        res.json({ success: true, material: mapQty(result.rows[0]) });
    } catch (error) {
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

/**
 * DELETE /api/project-materials/:projectId/:id
 * Remove a material line with an explicit confirmation (the audit trail keeps
 * the record of what was entered).
 */
router.delete('/:projectId/:id', verifyToken, isAdmin, async (req, res) => {
    try {
        const result = await q(
            `DELETE FROM project_materials WHERE project_id = $1 AND id = $2 RETURNING id, material`,
            [req.params.projectId, req.params.id]
        );
        if (!result.rows.length) return res.status(404).json({ success: false, message: 'Material entry not found' });
        logAudit({
            actorId: req.user.id, action: 'material.delete', entityType: 'project_material',
            entityId: result.rows[0].id, details: { projectId: req.params.projectId, material: result.rows[0].material },
            ip: req.ip
        });
        res.json({ success: true, message: 'Material entry removed' });
    } catch (error) {
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

module.exports = router;