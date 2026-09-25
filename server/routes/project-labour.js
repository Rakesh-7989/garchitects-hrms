const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken, isAdmin } = require('../middleware/auth');
const { runWithSchemaRepair, pgErrorResponse } = require('../utils/schemaRepair');
const { logAudit } = require('../utils/audit');

const q = (sql, params) => runWithSchemaRepair(() => query(sql, params));

// Labour categories used on Indian construction sites. Kept in sync with the
// UI select; free text is also accepted for site-specific trades.
const LABOUR_CATEGORIES = ['mason', 'carpenter', 'steel_fixer', 'electrician', 'plumber', 'painter', 'helper', 'general'];

function validateDate(d) {
    return /^\d{4}-\d{2}-\d{2}$/.test(d);
}

// One register entry: { category, count, notes? }.
function cleanEntry(row) {
    if (!row || typeof row !== 'object') return null;
    const has = (k) => row[k] !== undefined && row[k] !== null && String(row[k]) !== '';
    const category = has('category') ? String(row.category).trim().toLowerCase() : '';
    if (!category) return null;
    const count = Number(row.count);
    if (!Number.isFinite(count) || count < 0 || count > 10000) return null;
    return {
        category,
        count: Math.floor(count),
        notes: has('notes') ? String(row.notes).trim() : null
    };
}

/**
 * GET /api/project-labour/:projectId
 * Labour register for a project, newest date first, with the total headcount
 * per date (matches the daily labour register kept on site).
 */
router.get('/:projectId', verifyToken, isAdmin, async (req, res) => {
    try {
        const result = await q(
            `SELECT lr.*, COALESCE(e.first_name || ' ' || e.last_name, '') as created_by_name
             FROM project_labour_register lr
             LEFT JOIN employees e ON e.id = lr.created_by
             WHERE lr.project_id = $1
             ORDER BY lr.report_date DESC, lr.category`,
            [req.params.projectId]
        );
        const rows = result.rows;
        // Group + total per date for a compact register view.
        const byDate = {};
        for (const r of rows) {
            const key = String(r.report_date).slice(0, 10);
            const entry = byDate[key] = byDate[key] || { report_date: key, entries: [], total: 0 };
            entry.entries.push({ id: r.id, category: r.category, count: r.count, notes: r.notes });
            entry.total += r.count;
        }
        const dates = Object.values(byDate).sort((a, b) => b.report_date.localeCompare(a.report_date));
        res.json({ success: true, dates, count: rows.length });
    } catch (error) {
        console.error(`Error listing labour for project ${req.params.projectId}:`, error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

/**
 * GET /api/project-labour/:projectId/date/:date
 * The register for one specific date (used to pre-fill edits).
 */
router.get('/:projectId/date/:date', verifyToken, isAdmin, async (req, res) => {
    try {
        const result = await q(
            `SELECT * FROM project_labour_register
             WHERE project_id = $1 AND report_date = $2
             ORDER BY category`,
            [req.params.projectId, req.params.date]
        );
        res.json({ success: true, entries: result.rows });
    } catch (error) {
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

/**
 * POST /api/project-labour/:projectId
 * Upsert a day's labour register. Body: { report_date, entries: [{category,
 * count, notes}] }. Each (project, date, category) row is created or updated
 * atomically via ON CONFLICT - the site supervisor's daily register is a
 * full-day snapshot, so re-saving the same date is idempotent.
 */
router.post('/:projectId', verifyToken, isAdmin, async (req, res) => {
    try {
        const report_date = req.body.report_date ? String(req.body.report_date).slice(0, 10) : null;
        if (!report_date || !validateDate(report_date)) {
            return res.status(400).json({ success: false, message: 'A valid report date (YYYY-MM-DD) is required' });
        }
        const entries = (Array.isArray(req.body.entries) ? req.body.entries : []).map(cleanEntry).filter(Boolean);
        if (!entries.length) {
            return res.status(400).json({ success: false, message: 'Add at least one labour category with a count' });
        }
        const proj = await q(`SELECT id, name FROM projects WHERE id = $1`, [req.params.projectId]);
        if (!proj.rows.length) return res.status(404).json({ success: false, message: 'Project not found' });

        for (const en of entries) {
            await q(
                `INSERT INTO project_labour_register (project_id, report_date, category, count, notes, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (project_id, report_date, category)
                 DO UPDATE SET count = EXCLUDED.count, notes = EXCLUDED.notes, updated_at = NOW()`,
                [req.params.projectId, report_date, en.category, en.count, en.notes, req.user.id]
            );
        }
        logAudit({
            actorId: req.user.id, action: 'labour.upsert', entityType: 'project_labour_register',
            entityId: null, details: { projectId: req.params.projectId, reportDate: report_date, entries: entries.length },
            ip: req.ip
        });
        const fresh = await q(
            `SELECT * FROM project_labour_register WHERE project_id = $1 AND report_date = $2 ORDER BY category`,
            [req.params.projectId, report_date]
        );
        res.json({ success: true, entries: fresh.rows, message: `Labour register saved for ${report_date}` });
    } catch (error) {
        console.error(`Error saving labour for project ${req.params.projectId}:`, error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

/**
 * DELETE /api/project-labour/:projectId/:id
 * Remove a single category row from the register.
 */
router.delete('/:projectId/:id', verifyToken, isAdmin, async (req, res) => {
    try {
        const result = await q(
            `DELETE FROM project_labour_register WHERE project_id = $1 AND id = $2 RETURNING id, report_date, category`,
            [req.params.projectId, req.params.id]
        );
        if (!result.rows.length) return res.status(404).json({ success: false, message: 'Entry not found' });
        logAudit({
            actorId: req.user.id, action: 'labour.delete', entityType: 'project_labour_register',
            entityId: result.rows[0].id, details: { projectId: req.params.projectId, reportDate: result.rows[0].report_date, category: result.rows[0].category },
            ip: req.ip
        });
        res.json({ success: true, message: 'Labour entry removed' });
    } catch (error) {
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

module.exports = router;