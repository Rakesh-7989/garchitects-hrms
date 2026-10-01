// ============================================================
// TEAM HANDOVERS — TL leave / absence coverage (workflow release).
//
// An absent team_lead (self-declared, or manager/admin on their behalf) asks
// another team_lead/manager to COVER their team + led projects for a window.
// The cover lead must ACCEPT (status pending → active). While active and today
// inside [start_date, end_date], the cover inherits READ + status-update
// authoring on the absent lead's projects (see coversProjectArea in
// project-leads.js); structural powers (/place, designate, transfer) are NOT
// inherited — those stay designation-scoped. Manager/admin are notified at
// every step and may cancel anytime. Active rows past end_date auto-end (lazy).
//
// Access model:
//   - team_lead: create for THEMSELVES; accept/decline invites where cover.
//   - manager/admin: create for any absent TL; oversee/monitor + cancel.
//   - HR: read-only (monitor view).
// ============================================================
const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { runWithSchemaRepair, pgErrorResponse } = require('../utils/schemaRepair');
const { logAudit } = require('../utils/audit');
const { sendToUser, sendToUsers } = require('../services/push');
const { istDateString } = require('../utils/date');

const q = (sql, params) => runWithSchemaRepair(() => query(sql, params));

const LEAD_ROLES = ['team_lead', 'manager'];
const isOverlord = (role) => role === 'admin' || role === 'manager';

// Flips active handovers whose window has passed to 'ended' (lazy maintenance).
async function expirePastHandovers() {
    await q(
        `UPDATE team_handovers SET status = 'ended', ended_at = NOW()
         WHERE status = 'active' AND end_date < CURRENT_DATE`
    ).catch(() => {});
}

async function adminsAndManagersIds() {
    const r = await q(`SELECT id FROM employees WHERE role IN ('admin','manager') AND status = 'active'`);
    return r.rows.map(x => x.id);
}

const HANDOVER_SELECT = `
    SELECT th.id, th.absent_tl_id, th.cover_tl_id, th.start_date, th.end_date, th.reason,
           th.status, th.requested_by, th.decided_by, th.decided_at, th.created_at, th.ended_at,
           ab.first_name || ' ' || ab.last_name AS absent_name, ab.employee_id AS absent_code,
           cv.first_name || ' ' || cv.last_name AS cover_name, cv.employee_id AS cover_code,
           rq.first_name || ' ' || rq.last_name AS requested_by_name
    FROM team_handovers th
    JOIN employees ab ON ab.id = th.absent_tl_id
    JOIN employees cv ON cv.id = th.cover_tl_id
    LEFT JOIN employees rq ON rq.id = th.requested_by`;

// ---------------- GET /my — where I'm absent or acting cover
router.get('/my', verifyToken, async (req, res) => {
    if (![...LEAD_ROLES, 'admin'].includes(req.user.role)) {
        return res.status(403).json({ success: false, message: 'Only team leads, managers and admins use handovers' });
    }
    try {
        await expirePastHandovers();
        const r = await q(
            HANDOVER_SELECT + ` WHERE th.absent_tl_id = $1 OR th.cover_tl_id = $1 ORDER BY th.created_at DESC LIMIT 200`,
            [req.user.id]
        );
        res.json({ success: true, handovers: r.rows });
    } catch (error) {
        console.error('team-handovers/my error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ---------------- GET / — all handovers (manager/admin monitor, HR read-only)
router.get('/', verifyToken, async (req, res) => {
    if (!['admin', 'manager', 'hr'].includes(req.user.role)) {
        return res.status(403).json({ success: false, message: 'Only managers, admins and HR monitor handovers' });
    }
    try {
        await expirePastHandovers();
        const r = await q(HANDOVER_SELECT + ` ORDER BY th.created_at DESC LIMIT 300`, []);
        res.json({ success: true, handovers: r.rows });
    } catch (error) {
        console.error('team-handovers list error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ---------------- GET /covers-options — eligible cover leads (picker)
router.get('/covers-options', verifyToken, async (req, res) => {
    if (![...LEAD_ROLES, 'admin'].includes(req.user.role)) {
        return res.status(403).json({ success: false, message: 'Only team leads, managers and admins use handovers' });
    }
    try {
        const r = await q(
            `SELECT e.id, e.employee_id, e.first_name || ' ' || e.last_name AS full_name,
                    g.name AS designation_name
             FROM employees e
             LEFT JOIN designations g ON g.id = e.designation_id
             WHERE e.status = 'active' AND e.role IN ('team_lead','manager') AND e.id <> $1
             ORDER BY e.first_name, e.last_name`,
            [req.user.id]
        );
        res.json({ success: true, covers: r.rows });
    } catch (error) {
        console.error('team-handovers/covers-options error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ---------------- GET /leads-options — active TLs/managers (manager/admin pick
// the ABSENT lead to hand over on their behalf).
router.get('/leads-options', verifyToken, async (req, res) => {
    if (!['admin', 'manager'].includes(req.user.role)) {
        return res.status(403).json({ success: false, message: 'Only managers and admins create handovers on behalf of others' });
    }
    try {
        const r = await q(
            `SELECT e.id, e.employee_id, e.first_name || ' ' || e.last_name AS full_name,
                    g.name AS designation_name
             FROM employees e
             LEFT JOIN designations g ON g.id = e.designation_id
             WHERE e.status = 'active' AND e.role IN ('team_lead','manager')
             ORDER BY e.first_name, e.last_name`,
            []
        );
        res.json({ success: true, leads: r.rows });
    } catch (error) {
        console.error('team-handovers/leads-options error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ---------------- POST / — create a handover request
router.post('/', verifyToken, async (req, res) => {
    if (![...LEAD_ROLES, 'admin'].includes(req.user.role)) {
        return res.status(403).json({ success: false, message: 'Only team leads, managers and admins can create handovers' });
    }
    try {
        let absentTlId = parseInt(req.body.absent_tl_id, 10);
        const coverTlId = parseInt(req.body.cover_tl_id, 10);
        const startDate = String(req.body.start_date || '').trim();
        const endDate = String(req.body.end_date || '').trim();
        const reason = String(req.body.reason || '').trim().slice(0, 1000);

        if (isNaN(coverTlId)) return res.status(400).json({ success: false, message: 'Cover lead is required' });
        if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
            return res.status(400).json({ success: false, message: 'Valid start_date and end_date are required (YYYY-MM-DD)' });
        }
        if (startDate > endDate) return res.status(400).json({ success: false, message: 'start_date must be on or before end_date' });
        // "Today" must be the office day. toISOString() is UTC, so between 00:00 and
        // 05:29 IST it reports yesterday and rejects a handover starting today.
        if (endDate < istDateString()) return res.status(400).json({ success: false, message: 'end_date is in the past' });

        // A team_lead declares cover for THEMSELVES only; manager/admin may pick any absent lead.
        if (req.user.role === 'team_lead') absentTlId = req.user.id;
        if (isNaN(absentTlId)) return res.status(400).json({ success: false, message: 'absent_tl_id is required when a manager/admin creates on behalf of someone' });
        if (absentTlId === coverTlId) return res.status(400).json({ success: false, message: 'Cover lead cannot be the absent lead themselves' });

        const absent = await q(`SELECT id, role, status FROM employees WHERE id = $1`, [absentTlId]);
        if (absent.rows.length === 0) return res.status(404).json({ success: false, message: 'Absent lead not found' });
        if (!LEAD_ROLES.includes(absent.rows[0].role)) return res.status(400).json({ success: false, message: 'Absent person must be a team_lead or manager' });

        const cover = await q(`SELECT id, role, status FROM employees WHERE id = $1`, [coverTlId]);
        if (cover.rows.length === 0) return res.status(404).json({ success: false, message: 'Cover lead not found' });
        if (cover.rows[0].status !== 'active' || !LEAD_ROLES.includes(cover.rows[0].role)) {
            return res.status(400).json({ success: false, message: 'Cover lead must be an active team_lead or manager' });
        }

        // No overlapping pending/active cover of the same absent+cover pair.
        const overlap = await q(
            `SELECT 1 FROM team_handovers
             WHERE absent_tl_id = $1 AND cover_tl_id = $2 AND status IN ('pending','active')
               AND end_date >= $3 AND start_date <= $4 LIMIT 1`,
            [absentTlId, coverTlId, startDate, endDate]
        );
        if (overlap.rows.length > 0) return res.status(400).json({ success: false, message: 'These two already have a pending/active handover in that window' });

        const ins = await q(
            `INSERT INTO team_handovers (absent_tl_id, cover_tl_id, start_date, end_date, reason, requested_by)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [absentTlId, coverTlId, startDate, endDate, reason || null, req.user.id]
        );

        logAudit({ actorId: req.user.id, action: 'handover.request', entityType: 'team_handover', entityId: ins.rows[0].id,
            details: { absentTl: absentTlId, coverTl: coverTlId, startDate, endDate, reason } });

        const ids = [...new Set([coverTlId, ...(await adminsAndManagersIds())])];
        sendToUsers(ids, {
            title: 'Team handover request',
            body: `Cover ${req.user.name}${absentTlId === req.user.id ? ' (self)' : ''} for ${startDate} → ${endDate}. ${coverTlId === req.user.id ? 'Accept or decline.' : 'Please note for oversight.'}`,
            url: '/manager/my-team?tab=handover'
        }).catch(() => {});

        res.status(201).json({ success: true, handoverId: ins.rows[0].id });
    } catch (error) {
        console.error('team-handovers create error:', error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

// ---------------- POST /:id/accept | /decline — the cover lead decides
async function coverDecide(req, res, accept) {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ success: false, message: 'Invalid handover id' });
    try {
        const h = await q(`SELECT * FROM team_handovers WHERE id = $1`, [id]);
        if (h.rows.length === 0) return res.status(404).json({ success: false, message: 'Handover not found' });
        const H = h.rows[0];
        if (H.status !== 'pending') return res.status(400).json({ success: false, message: 'Only pending handovers can be ' + (accept ? 'accepted' : 'declined') });
        if (req.user.id !== H.cover_tl_id) {
            return res.status(403).json({ success: false, message: 'Only the cover lead can accept or decline this handover' });
        }

        const next = accept ? 'active' : 'declined';
        await q(`UPDATE team_handovers SET status = $1, decided_by = $2, decided_at = NOW() WHERE id = $3`, [next, req.user.id, id]);
        logAudit({ actorId: req.user.id, action: accept ? 'handover.accept' : 'handover.decline', entityType: 'team_handover', entityId: id,
            details: { absentTl: H.absent_tl_id, coverTl: H.cover_tl_id } });

        const ids = [...new Set([H.absent_tl_id, ...(await adminsAndManagersIds())])];
        sendToUsers(ids, {
            title: accept ? 'Handover accepted' : 'Handover declined',
            body: `${req.user.name} has ${accept ? 'accepted covering for' : 'declined covering'} ${H.absent_tl_id} (${H.start_date} → ${H.end_date})`,
            url: '/manager/led-projects'
        }).catch(() => {});

        res.json({ success: true, message: accept ? 'Handover accepted — you now cover the team/projects for the window' : 'Handover declined' });
    } catch (error) {
        console.error('team-handovers decide error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
}

router.post('/:id/accept', verifyToken, (req, res) => coverDecide(req, res, true));
router.post('/:id/decline', verifyToken, (req, res) => coverDecide(req, res, false));

// ---------------- POST /:id/cancel — absent/cover lead or manager/admin
router.post('/:id/cancel', verifyToken, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ success: false, message: 'Invalid handover id' });
    if (![...LEAD_ROLES, 'admin'].includes(req.user.role)) {
        return res.status(403).json({ success: false, message: 'Only team leads, managers and admins can cancel handovers' });
    }
    try {
        const h = await q(`SELECT * FROM team_handovers WHERE id = $1`, [id]);
        if (h.rows.length === 0) return res.status(404).json({ success: false, message: 'Handover not found' });
        const H = h.rows[0];
        if (!['pending', 'active'].includes(H.status)) return res.status(400).json({ success: false, message: 'Only pending or active handovers can be cancelled' });
        const isInvolved = req.user.id === H.absent_tl_id || req.user.id === H.cover_tl_id;
        if (!isOverlord(req.user.role) && !isInvolved) {
            return res.status(403).json({ success: false, message: 'Only the involved leads, a manager or an admin can cancel this handover' });
        }
        await q(`UPDATE team_handovers SET status = 'cancelled', ended_at = NOW(), decided_by = $1, decided_at = NOW() WHERE id = $2`, [req.user.id, id]);
        logAudit({ actorId: req.user.id, action: 'handover.cancel', entityType: 'team_handover', entityId: id,
            details: { absentTl: H.absent_tl_id, coverTl: H.cover_tl_id } });
        res.json({ success: true, message: 'Handover cancelled' });
    } catch (error) {
        console.error('team-handovers cancel error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;