const express = require('express');
const router = express.Router();
const { query, getClient } = require('../config/database');
const { verifyToken, isAdmin } = require('../middleware/auth');
const { runWithSchemaRepair, pgErrorResponse } = require('../utils/schemaRepair');
const { logAudit } = require('../utils/audit');

// Self-healing query wrapper: heals missing projects-module tables per request.
const q = (sql, params) => runWithSchemaRepair(() => query(sql, params));

// One activity line item of a DPR. Returns a cleaned object, or null if the
// line is unusable (no work item). Invalid lines are skipped - never fatal.
function cleanActivity(act) {
    if (!act || typeof act !== 'object') return null;
    const has = (k) => act[k] !== undefined && act[k] !== null && String(act[k]) !== '';
    const workItem = has('work_item') ? String(act.work_item).trim() : '';
    if (!workItem) return null;
    const qty = has('qty_done') ? Number(act.qty_done) : null;
    if (qty !== null && (!Number.isFinite(qty) || qty < 0)) return null;
    return {
        work_item: workItem,
        description: has('description') ? String(act.description).trim() : null,
        qty_done: qty,
        unit: has('unit') ? String(act.unit).trim() : null,
        remarks: has('remarks') ? String(act.remarks).trim() : null
    };
}

function validateDprBody(body) {
    const report_date = body.report_date ? String(body.report_date).slice(0, 10) : null;
    if (!report_date || !/^\d{4}-\d{2}-\d{2}$/.test(report_date)) {
        return { ok: false, status: 400, message: 'A valid report date (YYYY-MM-DD) is required' };
    }
    const has = (k) => body[k] !== undefined && body[k] !== null && String(body[k]) !== '';
    const values = {
        report_date,
        weather: has('weather') ? String(body.weather).trim() : null,
        work_summary: has('work_summary') ? String(body.work_summary).trim() : null,
        activities: Array.isArray(body.activities) ? body.activities.map(cleanActivity).filter(Boolean) : []
    };
    if (!values.work_summary && !values.activities.length) {
        return { ok: false, status: 400, message: 'Add either a work summary or at least one activity line' };
    }
    return { ok: true, values };
}

async function getDpr(projectId, dprId) {
    const result = await q(
        `SELECT dpr.*, COALESCE(e.first_name || ' ' || e.last_name, '') as created_by_name
         FROM project_daily_reports dpr
         LEFT JOIN employees e ON e.id = dpr.created_by
         WHERE dpr.project_id = $1 AND dpr.id = $2`,
        [projectId, dprId]
    );
    if (!result.rows.length) return null;
    const dpr = result.rows[0];
    const acts = await q(`SELECT * FROM dpr_activities WHERE dpr_id = $1 ORDER BY id`, [dpr.id]);
    dpr.activities = acts.rows;
    return dpr;
}

function mapQty(row) {
    if (!row) return row;
    if (Array.isArray(row)) return row.map(mapQty);
    return { ...row, qty_done: row.qty_done != null ? Math.round(Number(row.qty_done) * 100) / 100 : null };
}

/**
 * GET /api/project-dpr/:projectId
 * List daily progress reports (newest first) with their activity lines.
 */
router.get('/:projectId', verifyToken, isAdmin, async (req, res) => {
    try {
        const result = await q(
            `SELECT dpr.*, COALESCE(e.first_name || ' ' || e.last_name, '') as created_by_name
             FROM project_daily_reports dpr
             LEFT JOIN employees e ON e.id = dpr.created_by
             WHERE dpr.project_id = $1
             ORDER BY dpr.report_date DESC, dpr.id DESC`,
            [req.params.projectId]
        );
        const dprs = result.rows;
        if (dprs.length) {
            const ids = dprs.map(d => d.id);
            const acts = await q(
                `SELECT * FROM dpr_activities WHERE dpr_id = ANY($1::int[]) ORDER BY dpr_id, id`,
                [ids]
            );
            const byDpr = {};
            for (const a of acts.rows) {
                (byDpr[a.dpr_id] = byDpr[a.dpr_id] || []).push(a);
            }
            for (const d of dprs) d.activities = byDpr[d.id] || [];
        }
        res.json({ success: true, dprs: mapQty(dprs), count: dprs.length });
    } catch (error) {
        console.error(`Error listing DPRs for project ${req.params.projectId}:`, error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

/**
 * GET /api/project-dpr/:projectId/:dprId
 * Single DPR with activity lines.
 */
router.get('/:projectId/:dprId', verifyToken, isAdmin, async (req, res) => {
    try {
        const dpr = await getDpr(req.params.projectId, req.params.dprId);
        if (!dpr) return res.status(404).json({ success: false, message: 'DPR not found' });
        res.json({ success: true, dpr: mapQty(dpr) });
    } catch (error) {
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

/**
 * POST /api/project-dpr/:projectId
 * Create a DPR with activity lines (atomic: body + lines commit together).
 */
router.post('/:projectId', verifyToken, isAdmin, async (req, res) => {
    const client = await getClient();
    try {
        const parsed = validateDprBody(req.body);
        if (!parsed.ok) {
            client.release();
            return res.status(parsed.status).json({ success: false, message: parsed.message });
        }
        const v = parsed.values;
        const proj = await q(`SELECT id, name FROM projects WHERE id = $1`, [req.params.projectId]);
        if (proj.rows.length === 0) {
            client.release();
            return res.status(404).json({ success: false, message: 'Project not found' });
        }
        await client.query('BEGIN');
        const inserted = await client.query(
            `INSERT INTO project_daily_reports (project_id, report_date, weather, work_summary, created_by)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [req.params.projectId, v.report_date, v.weather, v.work_summary, req.user.id]
        );
        const dpr = inserted.rows[0];
        for (const a of v.activities) {
            await client.query(
                `INSERT INTO dpr_activities (dpr_id, work_item, description, qty_done, unit, remarks)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [dpr.id, a.work_item, a.description, a.qty_done, a.unit, a.remarks]
            );
        }
        await client.query('COMMIT');
        client.release();
        logAudit({
            actorId: req.user.id, action: 'dpr.create', entityType: 'project_daily_report',
            entityId: dpr.id, details: { projectId: req.params.projectId, reportDate: v.report_date, activities: v.activities.length },
            ip: req.ip
        });
        const full = await getDpr(req.params.projectId, dpr.id);
        res.json({ success: true, dpr: mapQty(full) });
    } catch (error) {
        try { if (client) await client.query('ROLLBACK'); } catch (_) {}
        if (client) client.release();
        console.error(`Error creating DPR for project ${req.params.projectId}:`, error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

/**
 * PUT /api/project-dpr/:projectId/:dprId
 * Edit a DPR: updates the body and REPLACES activity lines atomically.
 */
router.put('/:projectId/:dprId', verifyToken, isAdmin, async (req, res) => {
    const client = await getClient();
    try {
        const dprId = req.params.dprId;
        const existing = await q(`SELECT id FROM project_daily_reports WHERE project_id = $1 AND id = $2`, [req.params.projectId, dprId]);
        if (!existing.rows.length) {
            client.release();
            return res.status(404).json({ success: false, message: 'DPR not found' });
        }
        const parsed = validateDprBody(req.body);
        if (!parsed.ok) {
            client.release();
            return res.status(parsed.status).json({ success: false, message: parsed.message });
        }
        const v = parsed.values;
        await client.query('BEGIN');
        await client.query(
            `UPDATE project_daily_reports SET report_date = $1, weather = $2, work_summary = $3, updated_at = NOW()
             WHERE project_id = $4 AND id = $5`,
            [v.report_date, v.weather, v.work_summary, req.params.projectId, dprId]
        );
        await client.query(`DELETE FROM dpr_activities WHERE dpr_id = $1`, [dprId]);
        for (const a of v.activities) {
            await client.query(
                `INSERT INTO dpr_activities (dpr_id, work_item, description, qty_done, unit, remarks)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [dprId, a.work_item, a.description, a.qty_done, a.unit, a.remarks]
            );
        }
        await client.query('COMMIT');
        client.release();
        logAudit({
            actorId: req.user.id, action: 'dpr.update', entityType: 'project_daily_report',
            entityId: dprId, details: { projectId: req.params.projectId, reportDate: v.report_date },
            ip: req.ip
        });
        const full = await getDpr(req.params.projectId, dprId);
        res.json({ success: true, dpr: mapQty(full) });
    } catch (error) {
        try { if (client) await client.query('ROLLBACK'); } catch (_) {}
        if (client) client.release();
        console.error(`Error updating DPR ${req.params.dprId}:`, error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

/**
 * DELETE /api/project-dpr/:projectId/:dprId
 * Delete a DPR (activity lines cascade).
 */
router.delete('/:projectId/:dprId', verifyToken, isAdmin, async (req, res) => {
    try {
        const result = await q(
            `DELETE FROM project_daily_reports WHERE project_id = $1 AND id = $2 RETURNING id, report_date`,
            [req.params.projectId, req.params.dprId]
        );
        if (!result.rows.length) return res.status(404).json({ success: false, message: 'DPR not found' });
        logAudit({
            actorId: req.user.id, action: 'dpr.delete', entityType: 'project_daily_report',
            entityId: result.rows[0].id, details: { projectId: req.params.projectId, reportDate: result.rows[0].report_date },
            ip: req.ip
        });
        res.json({ success: true, message: 'DPR deleted' });
    } catch (error) {
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

module.exports = router;