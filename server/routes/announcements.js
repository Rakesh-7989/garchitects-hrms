const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken, isAdmin, audienceForRole } = require('../middleware/auth');
const { sendToAudience } = require('../services/push');
const { runWithSchemaRepair } = require('../utils/schemaRepair');
const { logAudit } = require('../utils/audit');

router.get('/', verifyToken, async (req, res) => {
    try {
        const result = await runWithSchemaRepair(() =>
            query(
                `SELECT a.*, e.first_name || ' ' || e.last_name as posted_by_name,
                CASE WHEN ar.id IS NOT NULL THEN 1 ELSE 0 END as is_read
                FROM announcements a
                LEFT JOIN employees e ON a.posted_by = e.id
                LEFT JOIN announcement_reads ar ON ar.announcement_id = a.id AND ar.employee_id = $1
                WHERE a.is_active = 1 AND (a.expires_at IS NULL OR a.expires_at > NOW())
                  AND a.target_audience = ANY($2::text[])
                ORDER BY a.created_at DESC`,
                [req.user.id, audienceForRole(req.user.role)]
            )
        );
        res.json({ success: true, announcements: result.rows });
    } catch (error) {
        console.error('Announcements fetch error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.get('/unread-count', verifyToken, async (req, res) => {
    try {
        const result = await runWithSchemaRepair(() =>
            query(
                `SELECT COUNT(*) as count FROM announcements a
                WHERE a.is_active = 1 AND (a.expires_at IS NULL OR a.expires_at > NOW())
                AND a.target_audience = ANY($2::text[])
                AND a.id NOT IN (
                    SELECT announcement_id FROM announcement_reads WHERE employee_id = $1
                )`,
                [req.user.id, audienceForRole(req.user.role)]
            )
        );
        res.json({ success: true, count: parseInt(result.rows[0].count) });
    } catch (error) {
        console.error('Unread count error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.post('/read-all', verifyToken, async (req, res) => {
    try {
        await runWithSchemaRepair(() =>
            query(
                `INSERT INTO announcement_reads (employee_id, announcement_id)
                SELECT $1, a.id FROM announcements a
                WHERE a.is_active = 1
                AND a.target_audience = ANY($2::text[])
                AND a.id NOT IN (
                    SELECT announcement_id FROM announcement_reads WHERE employee_id = $1
                )`,
                [req.user.id, audienceForRole(req.user.role)]
            )
        );
        res.json({ success: true });
    } catch (error) {
        console.error('Read-all error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.post('/:id/read', verifyToken, async (req, res) => {
    try {
        const visible = await runWithSchemaRepair(() =>
            query(
                `SELECT id FROM announcements
                WHERE id = $1 AND is_active = 1 AND target_audience = ANY($2::text[])`,
                [req.params.id, audienceForRole(req.user.role)]
            )
        );
        if (visible.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Announcement not found' });
        }
        const existing = await query(
            'SELECT id FROM announcement_reads WHERE employee_id = $1 AND announcement_id = $2',
            [req.user.id, req.params.id]
        );
        if (existing.rows.length === 0) {
            await query(
                'INSERT INTO announcement_reads (employee_id, announcement_id) VALUES ($1, $2)',
                [req.user.id, req.params.id]
            );
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Read announcement error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.post('/', verifyToken, isAdmin, async (req, res) => {
    try {
        const { title, content, priority, target_audience, expires_at } = req.body;
        if (!title || !content) return res.status(400).json({ success: false, message: 'Title and content required' });
        let expiresAt = null;
        if (expires_at) {
            const d = new Date(expires_at);
            if (isNaN(d.getTime())) return res.status(400).json({ success: false, message: 'Invalid expiry date' });
            // Store as UTC; frontend sends local datetime which JS parses as local
            expiresAt = d;
        }
        const result = await runWithSchemaRepair(() =>
            query(
                `INSERT INTO announcements (title, content, priority, posted_by, target_audience, expires_at) 
                VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                [title, content, priority || 'normal', req.user.id, target_audience || 'all', expiresAt]
            )
        );

        // Send push notifications in background (fire-and-forget) so the
        // response is returned immediately instead of blocking on every device.
        sendToAudience(target_audience || 'all', {
            title: priority === 'urgent' ? 'Urgent Announcement' : 'New Announcement',
            body: title,
            url: '/employee/announcements'
        }).then(sent => {
            if (sent.sent > 0) console.log(`[Push] Announcement "${title}" sent to ${sent.sent} device(s)`);
        }).catch(e => console.error('Push notify error:', e.message));

        logAudit({ actorId: req.user.id, action: 'announcement.create', entityType: 'announcement', entityId: result.rows[0].id, details: { title, priority: priority || 'normal' }, ip: req.ip });
        res.status(201).json({ success: true, announcement: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.put('/:id', verifyToken, isAdmin, async (req, res) => {
    try {
        const { title, content, priority, target_audience, expires_at } = req.body;
        if (expires_at !== undefined) {
            let expiresAt = null;
            if (expires_at !== null && expires_at !== '') {
                const d = new Date(expires_at);
                if (isNaN(d.getTime())) return res.status(400).json({ success: false, message: 'Invalid expiry date' });
                expiresAt = d;
            }
            const result = await runWithSchemaRepair(() =>
                query(
                    `UPDATE announcements SET title = COALESCE($1, title), content = COALESCE($2, content), 
                    priority = COALESCE($3, priority), target_audience = COALESCE($4, target_audience),
                    expires_at = $5
                    WHERE id = $6 RETURNING *`,
                    [title, content, priority, target_audience, expiresAt, req.params.id]
                )
            );
            if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Not found' });
            logAudit({ actorId: req.user.id, action: 'announcement.update', entityType: 'announcement', entityId: result.rows[0].id, details: { fields: ['title','content','priority','target_audience','expires_at'].filter((k) => req.body[k] !== undefined) }, ip: req.ip });
            return res.json({ success: true, announcement: result.rows[0] });
        }
        const result = await runWithSchemaRepair(() =>
            query(
                `UPDATE announcements SET title = COALESCE($1, title), content = COALESCE($2, content), 
                priority = COALESCE($3, priority), target_audience = COALESCE($4, target_audience) 
                WHERE id = $5 RETURNING *`,
                [title, content, priority, target_audience, req.params.id]
            )
        );
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Not found' });
        logAudit({ actorId: req.user.id, action: 'announcement.update', entityType: 'announcement', entityId: result.rows[0].id, details: { fields: ['title','content','priority','target_audience'].filter((k) => req.body[k] !== undefined) }, ip: req.ip });
        res.json({ success: true, announcement: result.rows[0] });
    } catch (error) {
        console.error('Announcement update error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.delete('/:id', verifyToken, isAdmin, async (req, res) => {
    try {
        const result = await runWithSchemaRepair(() =>
            query(
                'UPDATE announcements SET is_active = 0 WHERE id = $1 RETURNING id',
                [req.params.id]
            )
        );
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Not found' });
        logAudit({ actorId: req.user.id, action: 'announcement.delete', entityType: 'announcement', entityId: result.rows[0].id, details: { soft: true }, ip: req.ip });
        res.json({ success: true, message: 'Deleted successfully' });
    } catch (error) {
        console.error('Delete announcement error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;
