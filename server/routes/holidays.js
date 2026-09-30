const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken, isAdmin } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

// Validate a holiday payload before the DB sees it.
// - name required (trimmed, non-empty)
// - date required, YYYY-MM-DD, and a real calendar date (round-trip check rejects e.g. Feb 30)
// - same name+date must not already exist (matches UNIQUE(name, date)); excludeId skips the
//   row being edited so PUT does not false-positive on itself.
// Returns { ok: true, name } or { ok: false, message }.
async function validateHoliday({ name, date }, excludeId = null) {
    const cleanName = (name === undefined ? '' : String(name)).trim();
    if (!cleanName) return { ok: false, message: 'Holiday name is required' };
    if (date === undefined || date === null || String(date).trim() === '') {
        return { ok: false, message: 'Date is required' };
    }
    const dateStr = String(date).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return { ok: false, message: 'Date must be in YYYY-MM-DD format' };
    }
    const parsed = new Date(dateStr + 'T00:00:00Z');
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().substring(0, 10) !== dateStr) {
        return { ok: false, message: 'Date is not a valid calendar date' };
    }

    let sql = `SELECT id FROM holidays WHERE is_active = 1 AND name = $1 AND date = $2`;
    const params = [cleanName, dateStr];
    if (excludeId != null) {
        params.push(excludeId);
        sql += ` AND id <> $${params.length}`;
    }
    const dup = await query(sql + ' LIMIT 1', params);
    if (dup.rows.length > 0) {
        return { ok: false, message: `A holiday named "${cleanName}" already exists on ${dateStr}` };
    }
    return { ok: true, name: cleanName };
}

// @route   GET /api/holidays
// @desc    List active holidays, optionally filtered by year
// @access  Private (any authenticated employee)
router.get('/', verifyToken, async (req, res) => {
    try {
        const { year } = req.query;
        let sqlQuery = 'SELECT * FROM holidays WHERE is_active = 1';
        const params = [];

        if (year) {
            sqlQuery += " AND to_char(date, 'YYYY') = $1";
            params.push(year);
        }

        sqlQuery += ' ORDER BY date';
        const result = await query(sqlQuery, params);
        res.json({ success: true, holidays: result.rows });
    } catch (error) {
        console.error('List holidays error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   POST /api/holidays
// @desc    Create a holiday
// @access  Private (Admin)
router.post('/', verifyToken, isAdmin, async (req, res) => {
    try {
        const check = await validateHoliday(req.body);
        if (!check.ok) return res.status(400).json({ success: false, message: check.message });

        const result = await query(
            'INSERT INTO holidays (name, date, description) VALUES ($1, $2, $3) RETURNING *',
            [check.name, req.body.date, req.body.description]
        );
        // The auto-absent cron may have already marked this date before the
        // holiday was declared - drop those stale rows so nobody shows absent
        // on a holiday. Only system-generated rows are removed.
        await query(
            `DELETE FROM attendance WHERE date = $1 AND status = 'absent' AND remarks LIKE 'Auto-marked%'`,
            [String(req.body.date).substring(0, 10)]
        );
        logAudit({
            actorId: req.user.id,
            action: 'holiday.create',
            entityType: 'holiday',
            entityId: result.rows[0].id,
            details: { name: check.name, date: String(req.body.date).substring(0, 10) },
            ip: req.ip
        });
        res.status(201).json({ success: true, holiday: result.rows[0] });
    } catch (error) {
        if (error && error.code === '23505') {
            return res.status(400).json({ success: false, message: 'A holiday with this name already exists on this date' });
        }
        if (error && error.code === '22007') {
            return res.status(400).json({ success: false, message: 'Date is not a valid calendar date' });
        }
        console.error('Create holiday error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   PUT /api/holidays/:id
// @desc    Update a holiday (partial updates supported via COALESCE)
// @access  Private (Admin)
router.put('/:id', verifyToken, isAdmin, async (req, res) => {
    try {
        const existing = await query('SELECT id, name, date FROM holidays WHERE id = $1', [req.params.id]);
        if (existing.rows.length === 0) return res.status(404).json({ success: false, message: 'Not found' });

        // Merge provided fields over the current row so the duplicate check
        // runs against the effective (post-update) values, not just the delta.
        const merged = {
            name: req.body.name !== undefined ? req.body.name : existing.rows[0].name,
            date: req.body.date !== undefined ? req.body.date : existing.rows[0].date
        };
        const check = await validateHoliday(merged, existing.rows[0].id);
        if (!check.ok) return res.status(400).json({ success: false, message: check.message });

        const result = await query(
            'UPDATE holidays SET name = COALESCE($1, name), date = COALESCE($2, date), description = COALESCE($3, description) WHERE id = $4 RETURNING *',
            [req.body.name, req.body.date, req.body.description, req.params.id]
        );
        // Same stale-absent cleanup as POST, keyed on the (possibly new) date.
        const holidayDate = String(result.rows[0].date).substring(0, 10);
        await query(
            `DELETE FROM attendance WHERE date = $1 AND status = 'absent' AND remarks LIKE 'Auto-marked%'`,
            [holidayDate]
        );
        logAudit({
            actorId: req.user.id,
            action: 'holiday.update',
            entityType: 'holiday',
            entityId: req.params.id,
            details: { name: check.name, date: holidayDate },
            ip: req.ip
        });
        res.json({ success: true, holiday: result.rows[0] });
    } catch (error) {
        if (error && error.code === '23505') {
            return res.status(400).json({ success: false, message: 'A holiday with this name already exists on this date' });
        }
        if (error && error.code === '22007') {
            return res.status(400).json({ success: false, message: 'Date is not a valid calendar date' });
        }
        console.error('Update holiday error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   DELETE /api/holidays/:id
// @desc    Delete a holiday
// @access  Private (Admin)
router.delete('/:id', verifyToken, isAdmin, async (req, res) => {
    try {
        const before = await query('SELECT id, name, date FROM holidays WHERE id = $1', [req.params.id]);
        if (before.rows.length === 0) return res.status(404).json({ success: false, message: 'Not found' });

        const result = await query('DELETE FROM holidays WHERE id = $1 RETURNING id', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Not found' });

        logAudit({
            actorId: req.user.id,
            action: 'holiday.delete',
            entityType: 'holiday',
            entityId: req.params.id,
            details: { name: before.rows[0].name, date: String(before.rows[0].date).substring(0, 10) },
            ip: req.ip
        });
        res.json({ success: true, message: 'Deleted successfully' });
    } catch (error) {
        console.error('Delete holiday error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;