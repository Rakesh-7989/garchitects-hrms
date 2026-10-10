const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { query } = require('../config/database');
const { verifyToken, isAdmin, isManager, isAdminOrHr } = require('../middleware/auth');
const { myTreeIds } = require('./project-leads');
const { istDateString, istTimeString, istMonth, istYear, dateOnly } = require('../utils/date');
const { buildReportWorkbook, sendWorkbook } = require('../utils/excel');
const { logAudit } = require('../utils/audit');
const { getWorkWeekConfig, isWeekOff } = require('../utils/workWeek');
const { runAutoCheckout } = require('../services/attendanceAutoCheckout');
const { runWithSchemaRepair, pgErrorResponse } = require('../utils/schemaRepair');

// Self-healing query wrapper (creates missing tables/columns on cold instances).
const q = (sql, params) => runWithSchemaRepair(() => query(sql, params));

// Staff roles allowed to EDIT an attendance day (rich editor). team_lead is
// deliberately excluded - it keeps its existing mark-present/absent power only.
const ATTENDANCE_EDIT_ROLES = ['admin', 'hr', 'manager'];
const ATTENDANCE_EDIT_STATUSES = ['present', 'late', 'half-day', 'absent', 'wfh'];

// Normalize a TIME input to 'HH:MM' (accepts 'HH:MM' / 'HH:MM:SS'), or null.
function normalizeTime(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    if (!s) return null;
    const m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (!m) return null;
    const hh = parseInt(m[1], 10), mm = parseInt(m[2], 10);
    if (hh > 23 || mm > 59) return null;
    return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

const isValidDateStr = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));

// Access check shared by /record + /edit: allowed staff role, and for a
// manager the target employee must be inside their own reporting tree.
async function assertAttendanceEditAccess(req, res, employeeId) {
    if (!ATTENDANCE_EDIT_ROLES.includes(req.user.role)) {
        res.status(403).json({ success: false, message: 'Access denied. Admin, HR or Manager role required.' });
        return false;
    }
    if (req.user.role === 'manager') {
        const { myTreeIds } = require('./project-leads');
        const tree = await myTreeIds(req.user.id);
        if (!tree.has(employeeId)) {
            res.status(403).json({ success: false, message: 'You can only manage attendance for your own reporting team.' });
            return false;
        }
    }
    return true;
}

// What kind of day is this for the employee: declared holiday, weekly off,
// approved leave, approved WFH, future, today. Shipped to the edit modal so a
// staff member sees the context before overriding anything.
async function attendanceDayContext(employeeId, date) {
    const ctx = { date, holiday: null, weekoff: false, leave: false, wfh: false, future: false, today: false };
    try {
        const today = istDateString();
        ctx.today = date === today;
        ctx.future = date > today;
        const wcfg = await getWorkWeekConfig().catch(() => ({ weekoffDay: 0 }));
        ctx.weekoff = isWeekOff(date, wcfg.weekoffDay);
        const [hRes, lRes, wRes] = await Promise.all([
            q('SELECT name FROM holidays WHERE is_active = 1 AND date = $1 LIMIT 1', [date]).catch(() => ({ rows: [] })),
            q("SELECT 1 FROM leave_applications WHERE employee_id = $1 AND status = 'approved' AND start_date <= $2 AND end_date >= $2 LIMIT 1", [employeeId, date]).catch(() => ({ rows: [] })),
            q("SELECT 1 FROM wfh_requests WHERE employee_id = $1 AND status = 'approved' AND start_date <= $2 AND end_date >= $2 LIMIT 1", [employeeId, date]).catch(() => ({ rows: [] }))
        ]);
        ctx.holiday = hRes.rows.length ? hRes.rows[0].name : null;
        ctx.leave = lRes.rows.length > 0;
        ctx.wfh = wRes.rows.length > 0;
    } catch (e) {
        // Best-effort context only; never fail a read because of it.
    }
    return ctx;
}

router.post('/check-in', verifyToken, async (req, res) => {
    try {
        if (req.user.role === 'admin') {
            return res.status(400).json({ success: false, message: 'Attendance is not tracked for admin accounts' });
        }
        const today = istDateString();
        const now = istTimeString();
        const location = req.body.location || '';

        // Selfie + location are mandatory: a check-in missing either is rejected
        // so every attendance record stays verifiable.
        if (!(req.body.photo || '').startsWith('data:image/') || !location.trim()) {
            return res.status(400).json({
                success: false,
                message: 'Selfie and location are mandatory to check in. Allow camera and location access, then try again.'
            });
        }

        const existing = await query(
            'SELECT id, check_in, check_out, status, check_in_location, break_start, break_end, break_log, date FROM attendance WHERE employee_id = $1 AND date = $2',
            [req.user.id, today]
        );
        
        if (existing.rows.length > 0 && existing.rows[0].check_in) {
            // Already checked in. Don't dead-end the UI: a client whose status
            // view missed today's row (the historical DATE-serialization bug, a
            // month/TZ boundary, a stale tab, ...) would otherwise show only a
            // "Check In" button and clicking it would 400 with no way to reach
            // Check-Out. Return the existing row so the dashboard can flip
            // straight to the checked-in state. `date` is a DATE column (JS Date
            // on the wire) - normalize it with dateOnly() like the read routes.
            const row = existing.rows[0];
            if (row.date !== undefined && row.date !== null) row.date = dateOnly(row.date);
            return res.status(409).json({
                success: false,
                alreadyCheckedIn: true,
                attendance: row,
                message: 'Already checked in today'
            });
        }

        if (existing.rows.length > 0 && existing.rows[0].check_out) {
            // Defense-in-depth: a closed day must never be re-opened. This can
            // only happen on a legacy impossible row (closed WITHOUT a
            // check-in, produced by old code that let check-out run on an
            // absent row) - check_out IS set while check_in IS NULL. Falling
            // through would write a check_in AFTER the check_out.
            return res.status(400).json({ success: false, message: 'Already checked out today' });
        }
        
        // Check if late based on company settings
        const settings = await query(
            `SELECT setting_key, setting_value FROM company_settings 
             WHERE setting_key IN ('office_start_time', 'late_grace_period')`
        );
        const settingsMap = {};
        settings.rows.forEach(s => { settingsMap[s.setting_key] = s.setting_value; });
        
        const officeStart = settingsMap['office_start_time'] || '09:30';
        const graceMins = parseInt(settingsMap['late_grace_period']) || 15;
        
        const startParts = officeStart.split(':').map(Number);
        const nowParts = now.split(':').map(Number);
        const nowMins = nowParts[0] * 60 + nowParts[1];
        const lateCutoff = startParts[0] * 60 + startParts[1] + graceMins;
        const halfDayCutoff = 12 * 60;
        
        let status;
        if (nowMins <= lateCutoff) {
            status = 'present';
        } else if (nowMins <= halfDayCutoff) {
            // Check if this would be the 3rd late this month (auto half-day rule)
            const monthStart = today.substring(0, 7) + '-01';
            const lateCount = await query(
                `SELECT COUNT(*) as count FROM attendance 
                WHERE employee_id = $1 AND date >= $2 AND date < $3 AND status = 'late'`,
                [req.user.id, monthStart, today]
            );
            const currentLateCount = parseInt(lateCount.rows[0].count);
            if (currentLateCount >= 2) {
                status = 'half-day';
            } else {
                status = 'late';
            }
        } else {
            status = 'half-day';
        }
        
        let result;
        if (existing.rows.length > 0) {
            // Override a pre-marked absent / on-leave row with a real check-in
            // so approved-leave days do not block an actual check-in.
            result = await query(
                `UPDATE attendance SET check_in = $1, status = $2, check_in_location = $3,
                remarks = NULL WHERE id = $4 RETURNING *`,
                [now, status, location, existing.rows[0].id]
            );
        } else {
            result = await query(
                `INSERT INTO attendance (employee_id, date, check_in, status, check_in_location) 
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (employee_id, date) DO UPDATE
                SET check_in = EXCLUDED.check_in, status = EXCLUDED.status,
                    check_in_location = EXCLUDED.check_in_location, remarks = NULL
                RETURNING *`,
                [req.user.id, today, now, status, location]
            );
        }

        const attendance = result.rows[0];
        // Same DATE-serialization landmine as the read routes: `date` is a DATE
        // column (JS Date on the wire). Normalize before responding so no
        // consumer of the success payload (dashboard refetch, future code)
        // can hit the "previous UTC day" shift. The dashboard today refetches
        // /attendance/my after a check-in, so this is defensive - but it closes
        // the last instance of the bug in this route family.
        if (attendance && attendance.date !== undefined && attendance.date !== null) {
            attendance.date = dateOnly(attendance.date);
        }
        let has_photo = false;

        if (req.body.photo) {
            const photoData = req.body.photo;
            const m = photoData.match(/^data:image\/(jpeg|png|webp);base64,(.+)$/i);
            if (m) {
                const buf = Buffer.from(m[2], 'base64');
                if (buf.length <= 2 * 1024 * 1024) {
                    const token = crypto.randomBytes(32).toString('hex');
                    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
                    await q(
                        `INSERT INTO attendance_photos (attendance_id, employee_id, photo, token, expires_at, type)
                        VALUES ($1, $2, $3, $4, $5, 'check_in')`,
                        [attendance.id, req.user.id, buf, token, expiresAt]
                    );
                    await q(
                        'UPDATE attendance SET photo_token = $1 WHERE id = $2',
                        [token, attendance.id]
                    );
                    attendance.photo_token = token;
                    has_photo = true;
                }
            }
        }

        res.json({ success: true, attendance, has_photo });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.post('/check-out', verifyToken, async (req, res) => {
    try {
        if (req.user.role === 'admin') {
            return res.status(400).json({ success: false, message: 'Attendance is not tracked for admin accounts' });
        }
        const today = istDateString();
        const now = istTimeString();
        const location = req.body.location || '';

        // Selfie + location are mandatory on check-out as well.
        if (!(req.body.photo || '').startsWith('data:image/') || !location.trim()) {
            return res.status(400).json({
                success: false,
                message: 'Selfie and location are mandatory to check out. Allow camera and location access, then try again.'
            });
        }

        const checkIn = await query(
            // check_in IS NOT NULL: a pre-marked absent / on-leave row for today
            // (manager mark-absent has no date guard) has no check-in yet, so it
            // must never be "closed" - that would create an impossible
            // check_out-without-check_in day.
            'SELECT check_in, status, break_start, break_end FROM attendance WHERE employee_id = $1 AND date = $2 AND check_out IS NULL AND check_in IS NOT NULL',
            [req.user.id, today]
        );
        
        if (checkIn.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'No check-in found for today' });
        }
        
        const checkInTime = checkIn.rows[0].check_in;

        // Short-day rule: a morning login that ends up working under 3 hours
        // counts as a half day. Only downgrades present/late - never touches
        // an already half-day/absent/on-leave row.
        const inParts = String(checkInTime || '').split(':').map(Number);
        const outParts = now.split(':').map(Number);
        const workedMins = (inParts.length >= 2 && !isNaN(inParts[0]))
            ? (outParts[0] * 60 + outParts[1]) - (inParts[0] * 60 + inParts[1])
            : 9999;
        const shortDay = workedMins < 180 &&
            ['present', 'late'].includes(checkIn.rows[0].status);

        // Dangling break: if a break is still running at check-out (the API
        // allows checking out mid-break, and the UI hides the button only),
        // finalize it into break_log up to the check-out time so no break is
        // ever left open-ended and Hours Worked stays honest. The append is
        // self-guarded (only fires while break_start is still set), so a break
        // ended concurrently is never double-recorded.
        const checkInRow = checkIn.rows[0];
        const breakEntry = (checkInRow.break_start && !checkInRow.break_end)
            ? JSON.stringify({ start: checkInRow.break_start, end: now })
            : null;
        const finalizeBreak = breakEntry ? `,
            break_log = CASE
                WHEN (break_log IS NULL OR break_log = '' OR break_log = '[]')
                     AND break_start IS NOT NULL AND break_end IS NULL THEN '[' || $5 || ']'
                WHEN break_start IS NOT NULL AND break_end IS NULL
                     THEN left(break_log, length(break_log) - 1) || ', ' || $5 || ']'
                ELSE break_log
            END,
            break_start = CASE WHEN break_start IS NOT NULL AND break_end IS NULL THEN NULL ELSE break_start END,
            break_end = NULL` : '';

        const result = await query(
            `UPDATE attendance SET check_out = $1, check_out_location = $2${shortDay ? ", status = 'half-day'" : ''}${finalizeBreak}
            WHERE employee_id = $3 AND date = $4 AND check_out IS NULL 
            RETURNING *`,
            breakEntry ? [now, location, req.user.id, today, breakEntry] : [now, location, req.user.id, today]
        );

        let has_photo = false;

        if (req.body.photo) {
            const photoData = req.body.photo;
            const m = photoData.match(/^data:image\/(jpeg|png|webp);base64,(.+)$/i);
            if (m) {
                const buf = Buffer.from(m[2], 'base64');
                if (buf.length <= 2 * 1024 * 1024) {
                    const token = crypto.randomBytes(32).toString('hex');
                    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
                    await q(
                        `INSERT INTO attendance_photos (attendance_id, employee_id, photo, token, expires_at, type)
                        VALUES ($1, $2, $3, $4, $5, 'check_out')`,
                        [result.rows[0].id, req.user.id, buf, token, expiresAt]
                    );
                    await q(
                        'UPDATE attendance SET photo_token_checkout = $1 WHERE id = $2',
                        [token, result.rows[0].id]
                    );
                    result.rows[0].photo_token_checkout = token;
                    has_photo = true;
                }
            }
        }

        res.json({ success: true, attendance: result.rows[0], has_photo });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.post('/break-start', verifyToken, async (req, res) => {
    try {
        const today = istDateString();
        const now = istTimeString();

        const record = await query(
            // Same guard as check-out: a no-check-in row (pre-marked
            // absent / on-leave) is not actionable for breaks.
            'SELECT * FROM attendance WHERE employee_id = $1 AND date = $2 AND check_in IS NOT NULL',
            [req.user.id, today]
        );

        if (record.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'No check-in found today' });
        }

        if (record.rows[0].check_out) {
            return res.status(400).json({ success: false, message: 'Already checked out today' });
        }

        if (record.rows[0].break_start && !record.rows[0].break_end) {
            return res.status(400).json({ success: false, message: 'Break already started' });
        }

        const result = await query(
            `UPDATE attendance SET break_start = $1, break_end = NULL
            WHERE employee_id = $2 AND date = $3 RETURNING *`,
            [now, req.user.id, today]
        );

        res.json({ success: true, attendance: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.post('/break-end', verifyToken, async (req, res) => {
    try {
        const today = istDateString();
        const now = istTimeString();

        const record = await query(
            // Same guard as check-out / break-start: only a real checked-in day
            // can end a break - a pre-marked absent row has no break to end.
            'SELECT break_start, break_log, break_end, check_out FROM attendance WHERE employee_id = $1 AND date = $2 AND check_in IS NOT NULL',
            [req.user.id, today]
        );

        if (record.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'No check-in found today' });
        }

        if (record.rows[0].check_out) {
            return res.status(400).json({ success: false, message: 'Already checked out today' });
        }

        if (!record.rows[0].break_start) {
            return res.status(400).json({ success: false, message: 'Break not started yet' });
        }

        if (record.rows[0].break_end) {
            return res.status(400).json({ success: false, message: 'Break already ended' });
        }

        // Atomic end: ONE guarded UPDATE appends the entry and clears the
        // open-break columns. The WHERE guard means two concurrent break-end
        // requests can never lose an entry to a read-modify-write race (the
        // old code read the log, pushed, and blindly overwrote it) or record
        // the same break twice - exactly one wins, the loser matches 0 rows.
        const entry = JSON.stringify({ start: record.rows[0].break_start, end: now });
        const result = await query(
            `UPDATE attendance
             SET break_log = CASE
                   WHEN break_log IS NULL OR break_log = '' OR break_log = '[]' THEN '[' || $1 || ']'
                   ELSE left(break_log, length(break_log) - 1) || ', ' || $1 || ']'
                 END,
                 break_start = NULL, break_end = NULL
             WHERE employee_id = $2 AND date = $3
               AND check_out IS NULL AND break_start IS NOT NULL AND break_end IS NULL
             RETURNING *`,
            [entry, req.user.id, today]
        );

        if (result.rows.length === 0) {
            // Lost the race to a concurrent break-end (or the day was closed
            // by another request, e.g. auto-checkout). Conflict; the client
            // refetches and reconciles to the server's current state.
            return res.status(400).json({ success: false, message: 'Break already ended' });
        }

        res.json({ success: true, attendance: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.post('/mark-present', verifyToken, isManager, async (req, res) => {
    try {
        const { employee_id, date } = req.body;
        if (!employee_id || !date) {
            return res.status(400).json({ success: false, message: 'Employee ID and date are required' });
        }

        // D11 (same rule as projects + work assignments): a team lead may only
        // act on employees inside their own reporting tree. Managers/HR/admins
        // keep full power.
        if (req.user.role === 'team_lead') {
            const tree = await myTreeIds(req.user.id);
            if (!tree.has(parseInt(employee_id, 10))) {
                return res.status(403).json({ success: false, message: 'You can only mark attendance for your own team' });
            }
        }

        const settings = await query(
            `SELECT setting_key, setting_value FROM company_settings WHERE setting_key IN ('office_start_time')`
        );
        const officeStart = settings.rows.length > 0 ? settings.rows[0].setting_value : '09:30';

        const existing = await query(
            'SELECT id FROM attendance WHERE employee_id = $1 AND date = $2',
            [employee_id, date]
        );

        if (existing.rows.length > 0) {
            const result = await query(
                `UPDATE attendance SET status = 'present', check_in = $1, check_out = NULL,
                break_start = NULL, break_end = NULL, break_log = NULL,
                remarks = NULL, check_in_location = NULL
                WHERE employee_id = $2 AND date = $3 RETURNING *`,
                [officeStart, employee_id, date]
            );
            logAudit({ actorId: req.user.id, action: 'attendance.mark_present', entityType: 'attendance', entityId: result.rows[0].id, details: { employee_id, date, scope: 'update' }, ip: req.ip });
            res.json({ success: true, attendance: result.rows[0], message: 'Marked as present' });
        } else {
            const result = await query(
                `INSERT INTO attendance (employee_id, date, check_in, status)
                VALUES ($1, $2, $3, 'present') RETURNING *`,
                [employee_id, date, officeStart]
            );
            logAudit({ actorId: req.user.id, action: 'attendance.mark_present', entityType: 'attendance', entityId: result.rows[0].id, details: { employee_id, date, scope: 'create' }, ip: req.ip });
            res.json({ success: true, attendance: result.rows[0], message: 'Marked as present' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.post('/mark-absent', verifyToken, isManager, async (req, res) => {
    try {
        const { employee_id, date, remarks, status } = req.body;
        if (!employee_id || !date) {
            return res.status(400).json({ success: false, message: 'Employee ID and date are required' });
        }

        // D11: a team lead may only mark attendance for employees in their own
        // reporting tree; managers/HR/admins keep full power.
        if (req.user.role === 'team_lead') {
            const tree = await myTreeIds(req.user.id);
            if (!tree.has(parseInt(employee_id, 10))) {
                return res.status(403).json({ success: false, message: 'You can only mark attendance for your own team' });
            }
        }

        const newStatus = status || 'absent';
        if (newStatus !== 'absent') {
            await query(
                'DELETE FROM attendance WHERE employee_id = $1 AND date = $2',
                [employee_id, date]
            );
            logAudit({ actorId: req.user.id, action: 'attendance.reset', entityType: 'attendance', entityId: null, details: { employee_id, date, scope: 'delete' }, ip: req.ip });
            return res.json({ success: true, message: 'Attendance reset' });
        }
        const existing = await query(
            'SELECT id FROM attendance WHERE employee_id = $1 AND date = $2',
            [employee_id, date]
        );
        if (existing.rows.length > 0) {
            const result = await query(
                `UPDATE attendance SET status = 'absent', check_in = NULL, check_out = NULL, 
                break_start = NULL, break_end = NULL, break_log = NULL,
                remarks = COALESCE($1, remarks)
                WHERE employee_id = $2 AND date = $3 RETURNING *`,
                [remarks, employee_id, date]
            );
            logAudit({ actorId: req.user.id, action: 'attendance.mark_absent', entityType: 'attendance', entityId: result.rows[0].id, details: { employee_id, date, scope: 'update' }, ip: req.ip });
            res.json({ success: true, attendance: result.rows[0], message: 'Marked as absent' });
        } else {
            const result = await query(
                `INSERT INTO attendance (employee_id, date, status, remarks) 
                VALUES ($1, $2, 'absent', $3) RETURNING *`,
                [employee_id, date, remarks]
            );
            logAudit({ actorId: req.user.id, action: 'attendance.mark_absent', entityType: 'attendance', entityId: result.rows[0].id, details: { employee_id, date, scope: 'create' }, ip: req.ip });
            res.json({ success: true, attendance: result.rows[0], message: 'Marked as absent' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/attendance/record
// @desc    One employee's attendance for a single day + that day's context
//          (holiday/weekoff/leave/WFH/future) for the staff edit modal.
// @access  Private (Admin/HR company-wide; Manager scoped to own tree)
router.get('/record', verifyToken, async (req, res) => {
    try {
        const employeeId = parseInt(req.query.employee_id, 10);
        const date = String(req.query.date || '').trim();
        if (!employeeId || !isValidDateStr(date)) {
            return res.status(400).json({ success: false, message: 'employee_id and date (YYYY-MM-DD) are required' });
        }
        if (!(await assertAttendanceEditAccess(req, res, employeeId))) return;

        const empRes = await q(
            `SELECT id, first_name, last_name, employee_id AS emp_code, role FROM employees WHERE id = $1`,
            [employeeId]
        );
        if (empRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Employee not found' });
        }
        const employee = empRes.rows[0];
        if (employee.role === 'admin') {
            return res.status(400).json({ success: false, message: 'Attendance is not tracked for admin accounts' });
        }

        const recRes = await q(
            `SELECT id, date, check_in, check_out, status, remarks,
                    check_in_location, check_out_location, auto_checkout, checkout_miss_reason
             FROM attendance WHERE employee_id = $1 AND date = $2`,
            [employeeId, date]
        );
        const record = recRes.rows[0] || null;
        if (record && record.date != null) record.date = dateOnly(record.date);

        const day = await attendanceDayContext(employeeId, date);
        res.json({ success: true, employee, record, day });
    } catch (error) {
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

// @route   POST /api/attendance/edit
// @desc    Staff editor: set an employee's single-day status and times.
//          Allowed statuses: present / late / half-day / absent / wfh.
//          absent & wfh clear times; present-like statuses need a check-in.
// @access  Private (Admin/HR company-wide; Manager scoped to own tree)
router.post('/edit', verifyToken, async (req, res) => {
    try {
        const employeeId = parseInt(req.body.employee_id, 10);
        const date = String(req.body.date || '').trim();
        const status = String(req.body.status || '').trim();
        const remarks = (req.body.remarks == null ? '' : String(req.body.remarks)).trim();

        if (!employeeId || !isValidDateStr(date)) {
            return res.status(400).json({ success: false, message: 'employee_id and date (YYYY-MM-DD) are required' });
        }
        if (!ATTENDANCE_EDIT_STATUSES.includes(status)) {
            return res.status(400).json({ success: false, message: 'Status must be one of: present, late, half-day, absent, wfh' });
        }
        if (remarks.length > 500) {
            return res.status(400).json({ success: false, message: 'Remarks are too long (max 500 characters).' });
        }
        if (date > istDateString()) {
            return res.status(400).json({ success: false, message: 'Cannot edit a future date' });
        }
        if (!(await assertAttendanceEditAccess(req, res, employeeId))) return;

        // Normalize the raw time inputs. An empty string clears the time.
        const rawIn = req.body.check_in == null ? '' : String(req.body.check_in).trim();
        const rawOut = req.body.check_out == null ? '' : String(req.body.check_out).trim();
        let checkIn = null, checkOut = null;
        if (rawIn) {
            checkIn = normalizeTime(rawIn);
            if (!checkIn) return res.status(400).json({ success: false, message: 'Check-in must be a valid time (HH:MM).' });
        }
        if (rawOut) {
            checkOut = normalizeTime(rawOut);
            if (!checkOut) return res.status(400).json({ success: false, message: 'Check-out must be a valid time (HH:MM).' });
        }

        const workingStatus = ['present', 'late', 'half-day'].includes(status);
        if (workingStatus && !checkIn) {
            return res.status(400).json({ success: false, message: 'A check-in time is required for present, late or half-day.' });
        }
        if (workingStatus && checkIn && checkOut && checkOut <= checkIn) {
            return res.status(400).json({ success: false, message: 'Check-out must be later than check-in.' });
        }

        const empRes = await q(
            `SELECT id, first_name, last_name, employee_id AS emp_code, role FROM employees WHERE id = $1`,
            [employeeId]
        );
        if (empRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Employee not found' });
        }
        if (empRes.rows[0].role === 'admin') {
            return res.status(400).json({ success: false, message: 'Attendance is not tracked for admin accounts' });
        }

        const beforeRes = await q(
            `SELECT id, status, check_in, check_out, remarks, auto_checkout
             FROM attendance WHERE employee_id = $1 AND date = $2`,
            [employeeId, date]
        );
        const before = beforeRes.rows[0] || null;

        // A manual, human-verified close clears the machine's auto-clock-out
        // marker (and the "why no checkout" prompt) so the day is no longer
        // treated as an unverified auto-close. Left intact when no checkout is
        // set, so merely changing a status never erases the employee's reason.
        const clearedAuto = Boolean(checkOut);

        let result;
        if (before) {
            if (workingStatus) {
                result = await q(
                    `UPDATE attendance SET
                        status = $1, check_in = $2, check_out = $3,
                        break_start = NULL, break_end = NULL, break_log = NULL,
                        remarks = $4,
                        auto_checkout = CASE WHEN $5 THEN FALSE ELSE auto_checkout END,
                        auto_checkout_at = CASE WHEN $5 THEN NULL ELSE auto_checkout_at END,
                        checkout_miss_reason = CASE WHEN $5 THEN NULL ELSE checkout_miss_reason END,
                        checkout_miss_reason_at = CASE WHEN $5 THEN NULL ELSE checkout_miss_reason_at END
                     WHERE id = $6 RETURNING *`,
                    [status, checkIn, checkOut, remarks || null, clearedAuto, before.id]
                );
            } else {
                // absent / wfh: no worked times, no break, no location.
                result = await q(
                    `UPDATE attendance SET
                        status = $1, check_in = NULL, check_out = NULL,
                        break_start = NULL, break_end = NULL, break_log = NULL,
                        check_in_location = NULL, check_out_location = NULL,
                        auto_checkout = FALSE, auto_checkout_at = NULL,
                        checkout_miss_reason = NULL, checkout_miss_reason_at = NULL,
                        remarks = $2
                     WHERE id = $3 RETURNING *`,
                    [status, remarks || null, before.id]
                );
            }
        } else if (workingStatus) {
            result = await q(
                `INSERT INTO attendance (employee_id, date, check_in, check_out, status, remarks)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                [employeeId, date, checkIn, checkOut, status, remarks || null]
            );
        } else {
            result = await q(
                `INSERT INTO attendance (employee_id, date, status, remarks)
                 VALUES ($1, $2, $3, $4) RETURNING *`,
                [employeeId, date, status, remarks || null]
            );
        }

        const attendance = result.rows[0];
        if (attendance && attendance.date != null) attendance.date = dateOnly(attendance.date);

        logAudit({
            actorId: req.user.id,
            action: 'attendance.edit',
            entityType: 'attendance',
            entityId: attendance.id,
            details: {
                employee_id: employeeId,
                date,
                scope: before ? 'update' : 'create',
                before: before ? { status: before.status, check_in: before.check_in, check_out: before.check_out, remarks: before.remarks } : null,
                after: { status: attendance.status, check_in: attendance.check_in, check_out: attendance.check_out, remarks: attendance.remarks }
            },
            ip: req.ip
        });

        res.json({ success: true, attendance, message: 'Attendance updated' });
    } catch (error) {
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

router.get('/my', verifyToken, async (req, res) => {
    try {
        // Self-heal: auto-close any missed check-out past office_end + grace for
        // today before reading, so the employee immediately sees the half-day.
        // The company-wide scan is only needed when THIS employee still has an
        // open row - the common case (already checked out / never checked in)
        // must not pay for it: on a cold Vercel instance (heavy require chain +
        // lazy Supabase pooler connect) the awaited scan could breach
        // maxDuration: 30 and 504, which surfaced as the dashboard 'Could not
        // load your attendance status.' card.
        if (req.user.role !== 'admin') {
            const openToday = await query(
                'SELECT 1 FROM attendance WHERE employee_id = $1 AND date = $2 AND check_out IS NULL',
                [req.user.id, istDateString()]
            ).catch(() => ({ rows: [] }));
            if (openToday.rows.length > 0) { await runAutoCheckout().catch(() => {}); }
        }
        const { month, year } = req.query;
        let sqlQuery = `SELECT a.id, a.employee_id, a.date, a.check_in, a.check_out, a.status,
                a.remarks, a.created_at, a.break_start, a.break_end, a.break_log,
                a.check_in_location, a.check_out_location,
                a.auto_checkout, a.auto_checkout_at, a.checkout_miss_reason, a.checkout_miss_reason_at,
                CASE WHEN apci.id IS NOT NULL THEN 1 ELSE 0 END as has_photo_checkin,
                CASE WHEN apco.id IS NOT NULL THEN 1 ELSE 0 END as has_photo_checkout
            FROM attendance a
            LEFT JOIN attendance_photos apci ON apci.token = a.photo_token
            LEFT JOIN attendance_photos apco ON apco.token = a.photo_token_checkout
            WHERE a.employee_id = $1`;
        const params = [req.user.id];
        
        if (month && year) {
            sqlQuery += ' AND to_char(a.date, \'MM\') = $2 AND to_char(a.date, \'YYYY\') = $3';
            params.push(String(month).padStart(2, '0'), String(year));
        }
        
        sqlQuery += ' ORDER BY a.date DESC';
        // q (runWithSchemaRepair) on purpose: this read SELECTs auto_checkout /
        // checkout_miss_reason / photo_token columns and LEFT JOINs
        // attendance_photos, none of which a legacy live DB is guaranteed to
        // have - a raw query there 500s every employee attendance read with a
        // bare "Server error". Self-heal instead of failing.
        const result = await q(sqlQuery, params);
        // node-postgres parses DATE columns (OID 1082) at LOCAL midnight, so
        // JSON-serializing them yields the PREVIOUS UTC day on any host east of
        // UTC (e.g. "2026-10-07" -> "2026-10-06T18:30:00.000Z"). The client finds
        // "today" via date.split('T')[0], gets yesterday, and never matches the
        // row - showing "Not checked in yet" while the record exists. Ship a
        // plain YYYY-MM-DD built from local components (TZ-independent).
        result.rows.forEach(r => { r.date = dateOnly(r.date); });
        // Today's context for the dashboard card: with NO row for today the card
        // would otherwise show a bare 'Not checked in yet' check-in invitation
        // even on a declared holiday / weekly off / approved-leave day. Ship
        // what kind of day today is so the client renders a status-aware (still
        // actionable) state instead of confusing the employee into checking in
        // on a day they don't need to.
        const todayCtxDate = istDateString();
        let todayCtx = { date: todayCtxDate, holiday: null, weekoff: false, onLeave: false };
        try {
            const wcfg = await getWorkWeekConfig().catch(() => ({ weekoffDay: 0 }));
            const [hRes, lRes] = await Promise.all([
                query('SELECT name FROM holidays WHERE is_active = 1 AND date = $1 LIMIT 1', [todayCtxDate]).catch(() => ({ rows: [] })),
                query(
                    "SELECT 1 FROM leave_applications WHERE employee_id = $1 AND status = 'approved' AND start_date <= $2 AND end_date >= $2 LIMIT 1",
                    [req.user.id, todayCtxDate]
                ).catch(() => ({ rows: [] }))
            ]);
            todayCtx = {
                date: todayCtxDate,
                holiday: hRes.rows.length ? hRes.rows[0].name : null,
                weekoff: isWeekOff(todayCtxDate, wcfg.weekoffDay),
                onLeave: lRes.rows.length > 0
            };
        } catch (e) {
            // Best-effort only: never fail the read because of today-context.
            todayCtx = { date: todayCtxDate, holiday: null, weekoff: false, onLeave: false };
        }
        res.json({
            success: true,
            attendance: result.rows,
            today: todayCtx
        });
    } catch (error) {
        // Log the real error - the old catch returned a bare 500 with NO logging,
        // so a schema drift on live was invisible except as the client toast
        // "Server error — showing empty view."
        console.error('[attendance.my]', error && error.message ? error.message : error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

router.get('/all', verifyToken, isAdminOrHr, async (req, res) => {
    try {
        // Self-heal missed check-outs before reading the register.
        await runAutoCheckout().catch(() => {});
        const { date, month, year, department, limit } = req.query;
        let sqlQuery = `
            SELECT a.*, e.first_name, e.last_name, e.employee_id as emp_id, d.name as department_name
            FROM attendance a
            JOIN employees e ON a.employee_id = e.id
            LEFT JOIN departments d ON e.department_id = d.id
            WHERE e.role != 'admin'
        `;
        const params = [];
        let paramIndex = 1;
        
        if (date) {
            sqlQuery += ` AND a.date = $${paramIndex}`;
            params.push(date);
            paramIndex++;
        }
        
        if (month && year) {
            sqlQuery += ` AND to_char(a.date, 'MM') = $${paramIndex} AND to_char(a.date, 'YYYY') = $${paramIndex + 1}`;
            params.push(String(month).padStart(2, '0'), String(year));
            paramIndex += 2;
        }
        
        if (department) {
            sqlQuery += ` AND e.department_id = $${paramIndex}`;
            params.push(department);
            paramIndex++;
        }
        
        sqlQuery += ' ORDER BY a.date DESC, a.check_in DESC, e.first_name';
        if (limit) {
            sqlQuery += ` LIMIT $${paramIndex}`;
            params.push(parseInt(limit));
        }
        const result = await query(sqlQuery, params);
        // Same DATE-serialization fix as /my: ship plain YYYY-MM-DD so every
        // consumer sees the stored calendar date regardless of server TZ.
        result.rows.forEach(r => { r.date = dateOnly(r.date); });
        res.json({ success: true, attendance: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   POST /api/attendance/miss-reason
// @desc    Employee records WHY they missed check-out on an auto-checked-out day.
//          Admin/HR can record it on anyone's behalf.
// @access  Private
router.post('/miss-reason', verifyToken, async (req, res) => {
    try {
        const attendance_id = parseInt(req.body.attendance_id, 10);
        const reason = (req.body.reason || '').trim();
        if (!attendance_id) {
            return res.status(400).json({ success: false, message: 'attendance_id is required' });
        }
        if (!reason) {
            return res.status(400).json({ success: false, message: 'Please describe why you could not check out.' });
        }
        if (reason.length > 500) {
            return res.status(400).json({ success: false, message: 'Reason is too long (max 500 characters).' });
        }

        const canManage = req.user.role === 'admin' || req.user.role === 'hr';
        const row = await q(
            `SELECT id, employee_id, auto_checkout FROM attendance WHERE id = $1`,
            [attendance_id]
        );
        if (row.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Attendance record not found' });
        }
        const record = row.rows[0];
        if (!canManage && record.employee_id !== req.user.id) {
            return res.status(403).json({ success: false, message: 'You can only add a reason for your own attendance' });
        }
        if (!record.auto_checkout) {
            return res.status(400).json({ success: false, message: 'This day was not auto-checked-out, so no reason is needed.' });
        }

        await q(
            `UPDATE attendance SET checkout_miss_reason = $1, checkout_miss_reason_at = NOW() WHERE id = $2`,
            [reason, attendance_id]
        );
        logAudit({
            actorId: req.user.id, action: 'attendance.miss_reason',
            entityType: 'attendance', entityId: attendance_id,
            details: { reason, on_behalf_of: record.employee_id }, ip: req.ip
        });
        res.json({ success: true, message: 'Reason recorded' });
    } catch (error) {
        console.error('Miss-reason error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.get('/late-count', verifyToken, isAdminOrHr, async (req, res) => {
    try {
        const month = String(parseInt(req.query.month) || istMonth()).padStart(2, '0');
        const year = String(parseInt(req.query.year) || istYear());
        const result = await query(
            `SELECT e.id, e.first_name, e.last_name, e.employee_id, 
            COUNT(a.id) as late_count
            FROM employees e
            LEFT JOIN attendance a ON a.employee_id = e.id 
                AND a.status = 'late'
                AND to_char(a.date, 'MM') = $1
                AND to_char(a.date, 'YYYY') = $2
            WHERE e.status = 'active' AND e.role != 'admin'
            GROUP BY e.id
            HAVING COUNT(a.id) > 0
            ORDER BY late_count DESC`,
            [month, year]
        );
        res.json({ success: true, month: parseInt(month), year: parseInt(year), employees: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.get('/monthly', verifyToken, isManager, async (req, res) => {
    try {
        const month = parseInt(req.query.month) || istMonth();
        const year = parseInt(req.query.year) || istYear();
        const lastDay = new Date(year, month, 0).getDate();
        const wcfg = await getWorkWeekConfig();

        // D11: a team lead sees the monthly matrix only for their own reporting
        // tree; managers/HR/admins see the whole company.
        const tlScope = req.user.role === 'team_lead' ? Array.from(await myTreeIds(req.user.id)) : null;
        const employees = tlScope
            ? await query(
                `SELECT e.id, e.employee_id, e.first_name, e.last_name, e.department_id, d.name as department_name,
                        des.name as designation_name, e.designation_id
                 FROM employees e
                 LEFT JOIN departments d ON e.department_id = d.id
                 LEFT JOIN designations des ON e.designation_id = des.id
                 WHERE e.status = $1 AND e.role != 'admin' AND e.id = ANY($2::int[])
                 ORDER BY des.name NULLS LAST, e.first_name`,
                ['active', tlScope]
            )
            : await query(
                `SELECT e.id, e.employee_id, e.first_name, e.last_name, e.department_id, d.name as department_name,
                        des.name as designation_name, e.designation_id
                 FROM employees e
                 LEFT JOIN departments d ON e.department_id = d.id
                 LEFT JOIN designations des ON e.designation_id = des.id
                 WHERE e.status = $1 AND e.role != 'admin'
                 ORDER BY des.name NULLS LAST, e.first_name`,
                ['active']
            );

        const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
        const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

        const [attendance, leaveRows, holRows] = await Promise.all([
            query(
                `SELECT employee_id, date, check_in, check_out, status, check_in_location, remarks
                 FROM attendance 
                 WHERE to_char(date, 'MM') = $1 AND to_char(date, 'YYYY') = $2`,
                [String(month).padStart(2, '0'), String(year)]
            ),
            query(
                `SELECT employee_id, start_date, end_date FROM leave_applications
                 WHERE status = 'approved'
                   AND end_date >= $1 AND start_date <= $2`,
                [monthStart, monthEnd]
            ),
            query(
                `SELECT to_char(date, 'YYYY-MM-DD') AS d FROM holidays
                 WHERE is_active = 1 AND date >= $1 AND date <= $2`,
                [monthStart, monthEnd]
            )
        ]);

        const attMap = {};
        attendance.rows.forEach(a => {
            const day = new Date(a.date).getDate();
            if (!attMap[a.employee_id]) attMap[a.employee_id] = {};
            attMap[a.employee_id][day] = { check_in: a.check_in, check_out: a.check_out, status: a.status, check_in_location: a.check_in_location, remarks: a.remarks || '' };
        });

        // Declared holidays for the month.
        const holidaySet = new Set((holRows.rows || []).map(r => r.d));

        // Approved leave days per employee (YYYY-MM-DD => set).
        // DATE columns arrive as JS Dates, so they must be coerced with dateOnly()
        // before any string work - String(date).substring(0,10) produced garbage
        // and left leaveByEmp permanently empty, which silently hid every
        // approved leave day from this matrix.
        const fmtD = (v) => dateOnly(v);
        const key = (empId, day) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const leaveByEmp = {};
        leaveRows.rows.forEach(l => {
            const s = fmtD(l.start_date), e = fmtD(l.end_date);
            if (!s || !e) return;
            let c = new Date(s + 'T00:00:00Z');
            const cEnd = new Date(e + 'T00:00:00Z');
            while (c <= cEnd) {
                const ds = fmtD(new Date(c.getUTCFullYear(), c.getUTCMonth(), c.getUTCDate()));
                if (!ds) {
                    const tmp = c.getUTCFullYear() + '-' + String(c.getUTCMonth()+1).padStart(2,'0') + '-' + String(c.getUTCDate()).padStart(2,'0');
                    (leaveByEmp[l.employee_id] = leaveByEmp[l.employee_id] || new Set()).add(tmp);
                } else {
                    (leaveByEmp[l.employee_id] = leaveByEmp[l.employee_id] || new Set()).add(ds);
                }
                c.setUTCDate(c.getUTCDate() + 1);
            }
        });

        // Paid/LOP classification: the first `monthly_leave_quota` approved
        // leave days of the month are paid ('onleave'); any extra leave days
        // beyond the quota are LOP ('absent'). Matches payroll.
        const leaveClassByEmp = {};
        Object.keys(leaveByEmp).forEach(empId => {
            const days = Array.from(leaveByEmp[empId]).sort();
            const cls = {};
            let leaveCount = 0;
            days.forEach(ds => {
                cls[ds] = leaveCount < wcfg.monthlyLeaveQuota ? 'paid' : 'lop';
                if (cls[ds] === 'paid') leaveCount++;
            });
            leaveClassByEmp[empId] = cls;
        });

        const matrix = {};
        const today = new Date();
        today.setHours(0,0,0,0);
        const keyLocal = (y,m,d) => fmtDateStr(y,m,d); // better for local comparison? but we have key; safer use date-fmt
        employees.rows.forEach(emp => {
            matrix[emp.id] = {};
            const empAtt = attMap[emp.id] || {};
            for (let d = 1; d <= lastDay; d++) {
                const date = new Date(year, month - 1, d);
                const dayOfWeek = date.getDay();
                const dateStr = key(emp.id, d);
                const rec = empAtt[d] || null;
                const leaveCls = (leaveClassByEmp[emp.id] || {})[dateStr];

                if (date > today) {
                    matrix[emp.id][d] = { status: 'upcoming', check_in: null, check_out: null };
                } else if (dayOfWeek === wcfg.weekoffDay) {
                    // Week off (the ONE configured weekly off day). An EXPLICIT
                    // attendance record always wins (a real check-in, or a
                    // weekoff an admin marked absent). With no record it shows
                    // the default Week Off, or a leave day.
                    if (rec) {
                        matrix[emp.id][d] = rec;
                    } else if (leaveCls) {
                        matrix[emp.id][d] = { status: leaveCls === 'paid' ? 'onleave' : 'absent', check_in: null, check_out: null, leave: true };
                    } else {
                        matrix[emp.id][d] = { status: 'weekoff', check_in: null, check_out: null };
                    }
                } else if (holidaySet.has(dateStr)) {
                    // Declared holiday: ALWAYS shown as H for everyone unless an
                    // admin explicitly marked this holiday absent for this
                    // employee (recognised by its remark) - then it shows A.
                    const adminHolidayAbsent = rec && rec.status === 'absent' && /Admin marked holiday absent/.test(rec.remarks || '');
                    if (adminHolidayAbsent) {
                        matrix[emp.id][d] = { status: 'absent', check_in: null, check_out: null, remarks: rec.remarks || '', leave: false };
                    } else if (leaveCls) {
                        matrix[emp.id][d] = { status: leaveCls === 'paid' ? 'onleave' : 'absent', check_in: null, check_out: null, leave: true };
                    } else {
                        matrix[emp.id][d] = { status: 'holiday', check_in: null, check_out: null };
                    }
                } else if (leaveCls) {
                    // Approved leave (paid within monthly quota, LOP beyond). An
                    // auto-marked/back-filled 'absent' row must not shadow it.
                    matrix[emp.id][d] = { status: leaveCls === 'paid' ? 'onleave' : 'absent', check_in: null, check_out: null, leave: true };
                } else if (rec) {
                    matrix[emp.id][d] = rec;
                } else if (date.getTime() === today.getTime()) {
                    // Today with no record yet is NOT an absence: the employee
                    // may simply not have checked in (or is on the way). Keep
                    // the cell neutral like future days so the admin/manager
                    // grid doesn't show everyone "Absent" at 9 AM and inflate
                    // the month's Absent count. The day only becomes absent
                    // once it is over (the auto-absent backend's job).
                    matrix[emp.id][d] = { status: 'upcoming', check_in: null, check_out: null };
                } else {
                    matrix[emp.id][d] = { status: 'absent', check_in: null, check_out: null };
                }
            }
        });

        res.json({
            success: true,
            month,
            year,
            days: lastDay,
            employees: employees.rows,
            holidays: Array.from(holidaySet),
            matrix
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/attendance/export
// @desc    Branded Excel month summary per employee (present/late/half/absent/WFH/leave)
// @access  Private (Admin)
router.get('/export', verifyToken, isAdminOrHr, async (req, res) => {
    try {
        const month = parseInt(req.query.month) || istMonth();
        const year = parseInt(req.query.year) || istYear();
        const lastDay = new Date(year, month, 0).getDate();
        const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
        const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
        const wcfg = await getWorkWeekConfig();

        const employeesRes = await query(
            `SELECT e.id, e.employee_id, e.first_name, e.last_name, d.name AS department_name
            FROM employees e
            LEFT JOIN departments d ON e.department_id = d.id
            WHERE e.status = 'active' AND e.role != 'admin'
            ORDER BY e.first_name`
        );

        const [attRes, leaveRes, wfhRes] = await Promise.all([
            query(
                `SELECT employee_id, date, status FROM attendance
                WHERE to_char(date, 'MM') = $1 AND to_char(date, 'YYYY') = $2`,
                [String(month).padStart(2, '0'), String(year)]
            ),
            query(
                `SELECT employee_id, start_date, end_date FROM leave_applications
                WHERE status = 'approved' AND end_date >= $1 AND start_date <= $2`,
                [monthStart, monthEnd]
            ),
            query(
                `SELECT employee_id, start_date, end_date FROM wfh_requests
                WHERE status = 'approved' AND end_date >= $1 AND start_date <= $2`,
                [monthStart, monthEnd]
            )
        ]);

        // Status per calendar day per employee (same rules as the monthly matrix).
        const attByEmp = {};
        attRes.rows.forEach(a => {
            const key = a.employee_id;
            const day = new Date(a.date).getDate();
            (attByEmp[key] = attByEmp[key] || {})[day] = a.status;
        });
        const inRange = (l, d) => {
            const ds = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            // l.start_date / l.end_date are DATE columns, i.e. JS Dates. Must go
            // through dateOnly() - String(date).substring(0,10) gives 'Mon Jan 26'
            // and every comparison below is then false, hiding the leave entirely.
            const s = dateOnly(l.start_date), e = dateOnly(l.end_date);
            return Boolean(s && e) && s <= ds && e >= ds;
        };
        const leavesByEmp = {};
        leaveRes.rows.forEach(l => { (leavesByEmp[l.employee_id] = leavesByEmp[l.employee_id] || []).push(l); });
        const wfhByEmp = {};
        wfhRes.rows.forEach(w => { (wfhByEmp[w.employee_id] = wfhByEmp[w.employee_id] || []).push(w); });

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const rows = employeesRes.rows.map(emp => {
            const tally = { present: 0, late: 0, half_day: 0, absent: 0, weekoff: 0, holidayish_weekoff_sat_worked: 0, leave: 0, wfh: 0 };
            let counted = 0;
            for (let d = 1; d <= lastDay; d++) {
                const date = new Date(year, month - 1, d);
                if (date > today) continue;
                counted++;
                const dow = date.getDay();
                const st = (attByEmp[emp.id] || {})[d];
                if (st === 'present') { tally.present++; continue; }
                if (st === 'late') { tally.late++; continue; }
                if (st === 'half-day') { tally.half_day++; continue; }
                if (dow === wcfg.weekoffDay) { tally.weekoff++; continue; }
                if ((leavesByEmp[emp.id] || []).some(l => inRange(l, d))) { tally.leave++; continue; }
                if ((wfhByEmp[emp.id] || []).some(w => inRange(w, d))) { tally.wfh++; continue; }
                if (!st) { tally.absent++; continue; }
                // Any other recorded status on a working day counts as present-like.
                tally.present++;
            }
            const workDays = Math.max(1, counted - tally.weekoff);
            const paidLike = tally.present + tally.late + tally.wfh + tally.leave + Math.round(tally.half_day * 0.5);
            return {
                emp_code: emp.employee_id,
                name: emp.first_name + ' ' + emp.last_name,
                department: emp.department_name,
                working_days: workDays,
                present_days: tally.present,
                late_days: tally.late,
                half_days: tally.half_day,
                absent_days: tally.absent,
                wfh_days: tally.wfh,
                leave_days: tally.leave,
                week_offs: tally.weekoff,
                attendance_percent: Math.round((paidLike / workDays) * 1000) / 10
            };
        });

        const columns = [
            { header: 'Emp ID', key: 'emp_code', width: 12 },
            { header: 'Employee Name', key: 'name', width: 22 },
            { header: 'Department', key: 'department' },
            { header: 'Working Days', key: 'working_days', type: 'number' },
            { header: 'Present', key: 'present_days', type: 'number' },
            { header: 'Late', key: 'late_days', type: 'number' },
            { header: 'Half Days', key: 'half_days', type: 'number' },
            { header: 'WFH Days', key: 'wfh_days', type: 'number' },
            { header: 'Leave Days', key: 'leave_days', type: 'number' },
            { header: 'Absent (LOP)', key: 'absent_days', type: 'number' },
            { header: 'Week Offs', key: 'week_offs', type: 'number' },
            { header: 'Attendance %', key: 'attendance_percent', type: 'percent', width: 13 }
        ];
        columns.filter(c => c.type === 'number').forEach(c => { c.total = true; });

        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        const wb = await buildReportWorkbook({
            reportName: 'Attendance Report',
            subtitleExtra: monthNames[month - 1] + ' ' + year,
            columns,
            rows,
            footerNote: req.user.name || 'Admin'
        });

        logAudit({
            actorId: req.user.id,
            action: 'data.export',
            entityType: 'report',
            entityId: null,
            details: { report: 'attendance_monthly', month, year, records: rows.length },
            ip: req.ip
        });

        await sendWorkbook(res, wb, `Attendance_${monthNames[month - 1]}_${year}.xlsx`);
    } catch (error) {
        console.error('Attendance export error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/attendance/photo/:token
// @desc    Serve check-in photo once, then delete it (one-time view)
// @access  Admin/HR only
router.get('/photo/:token', verifyToken, isAdminOrHr, async (req, res) => {
    try {
        const result = await q(
            'SELECT * FROM attendance_photos WHERE token = $1',
            [req.params.token]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Photo not found or already viewed' });
        }

        const photo = result.rows[0];

        if (new Date(photo.expires_at) < new Date()) {
            await q('DELETE FROM attendance_photos WHERE id = $1', [photo.id]);
            return res.status(404).json({ success: false, message: 'Photo has expired' });
        }

        const buf = Buffer.isBuffer(photo.photo) ? photo.photo : Buffer.from(photo.photo);

        await q(
            "UPDATE attendance_photos SET viewed = 1, viewed_at = NOW() WHERE id = $1",
            [photo.id]
        );
        await q('DELETE FROM attendance_photos WHERE id = $1', [photo.id]);

        res.set({
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Pragma': 'no-cache',
            'X-One-Time-View': '1'
        });
        res.send(buf);
    } catch (error) {
        console.error('Serve photo error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;
