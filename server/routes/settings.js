const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken, isAdmin } = require('../middleware/auth');

router.get('/company', verifyToken, async (req, res) => {
    try {
        const result = await query('SELECT * FROM companies LIMIT 1');
        // Self-heal: ensure the work-week policy rows exist so admin UI always
        // has explicit values (defaults: week off Sunday, 6 working days, 1
        // monthly paid leave). Idempotent - never touches existing rows.
        await query(
            `INSERT INTO company_settings (setting_key, setting_value, description) VALUES
            ('weekoff_day', '0', 'Weekly off day (0=Sunday .. 6=Saturday); the ONLY weekly off day'),
            ('weekly_working_days', '6', 'Expected working days per week'),
            ('monthly_leave_quota', '1', 'Paid leave days an employee earns per month')
            ON CONFLICT (setting_key) DO NOTHING`
        ).catch(() => {});
        const settings = await query('SELECT * FROM company_settings');
        const settingsMap = {};
        settings.rows.forEach(s => { settingsMap[s.setting_key] = s.setting_value; });
        res.json({ success: true, company: result.rows[0] || null, settings: settingsMap });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.put('/company', verifyToken, isAdmin, async (req, res) => {
    try {
        const { name, email, phone, address, website, logo } = req.body;
        let result = await query(
            `UPDATE companies SET name = COALESCE($1, name), email = COALESCE($2, email), 
            phone = COALESCE($3, phone), address = COALESCE($4, address), website = COALESCE($5, website),
            logo = CASE WHEN $6::text = '' THEN NULL ELSE COALESCE($6, logo) END,
            updated_at = NOW() WHERE id = (SELECT id FROM companies LIMIT 1) RETURNING *`,
            [name, email, phone, address, website, logo]
        );
        if (result.rows.length === 0) {
            result = await query(
                `INSERT INTO companies (name, email, phone, address, website, logo, created_at, updated_at)
                VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), NOW(), NOW()) RETURNING *`,
                [name || null, email || null, phone || null, address || null, website || null, logo || null]
            );
        }
        res.json({ success: true, company: result.rows[0] });
    } catch (error) {
        console.error('Update company error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.put('/timing', verifyToken, isAdmin, async (req, res) => {
    try {
        const { start_time, end_time, grace_period, timezone, weekoff_day, weekly_working_days, monthly_leave_quota } = req.body;
        const updates = [
            { key: 'office_start_time', value: start_time },
            { key: 'office_end_time', value: end_time },
            { key: 'late_grace_period', value: grace_period },
            { key: 'timezone', value: timezone },
            { key: 'weekoff_day', value: weekoff_day },
            { key: 'weekly_working_days', value: weekly_working_days },
            { key: 'monthly_leave_quota', value: monthly_leave_quota }
        ];
        for (const u of updates) {
            if (u.value !== undefined && u.value !== null && String(u.value).trim() !== '') {
                await query(
                    `INSERT INTO company_settings (setting_key, setting_value, updated_at) 
                    VALUES ($1, $2, NOW()) 
                    ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2, updated_at = NOW()`,
                    [u.key, String(u.value).trim()]
                );
            }
        }
        res.json({ success: true, message: 'Settings updated' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;
