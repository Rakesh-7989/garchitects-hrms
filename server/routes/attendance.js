const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { query } = require('../config/database');
const { verifyToken, isAdmin, isManager } = require('../middleware/auth');
const { istDateString, istTimeString, istMonth, istYear } = require('../utils/date');
const { buildReportWorkbook, sendWorkbook } = require('../utils/excel');
const { logAudit } = require('../utils/audit');
const { getWorkWeekConfig } = require('../utils/workWeek');

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
            'SELECT id, check_in FROM attendance WHERE employee_id = $1 AND date = $2',
            [req.user.id, today]
        );
        
        if (existing.rows.length > 0 && existing.rows[0].check_in) {
            return res.status(400).json({ success: false, message: 'Already checked in today' });
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
        let has_photo = false;

        if (req.body.photo) {
            const photoData = req.body.photo;
            const m = photoData.match(/^data:image\/(jpeg|png|webp);base64,(.+)$/i);
            if (m) {
                const buf = Buffer.from(m[2], 'base64');
                if (buf.length <= 2 * 1024 * 1024) {
                    const token = crypto.randomBytes(32).toString('hex');
                    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
                    await query(
                        `INSERT INTO attendance_photos (attendance_id, employee_id, photo, token, expires_at, type)
                        VALUES ($1, $2, $3, $4, $5, 'check_in')`,
                        [attendance.id, req.user.id, buf, token, expiresAt]
                    );
                    await query(
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
            'SELECT check_in, status FROM attendance WHERE employee_id = $1 AND date = $2 AND check_out IS NULL',
            [req.user.id, today]
        );
        
        if (checkIn.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'No check-in found for today' });
        }
        
        let overtime = 0;
        const checkInTime = checkIn.rows[0].check_in;
        const endSettings = await query(
            `SELECT setting_key, setting_value FROM company_settings WHERE setting_key = 'office_end_time'`
        );
        const officeEnd = (endSettings.rows.length > 0 && endSettings.rows[0].setting_value) || '18:30:00';
        if (checkInTime && now > officeEnd) {
            const endParts = officeEnd.split(':').map(Number);
            const nowParts = now.split(':').map(Number);
            const endMins = endParts[0] * 60 + endParts[1];
            const nowMins = nowParts[0] * 60 + nowParts[1];
            overtime = Math.max(0, (nowMins - endMins) / 60);
        }

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

        const result = await query(
            `UPDATE attendance SET check_out = $1, overtime_hours = $2, check_out_location = $3${shortDay ? ", status = 'half-day'" : ''}
            WHERE employee_id = $4 AND date = $5 AND check_out IS NULL 
            RETURNING *`,
            [now, overtime, location, req.user.id, today]
        );

        let has_photo = false;

        if (req.body.photo) {
            const photoData = req.body.photo;
            const m = photoData.match(/^data:image\/(jpeg|png|webp);base64,(.+)$/i);
            if (m) {
                const buf = Buffer.from(m[2], 'base64');
                if (buf.length <= 2 * 1024 * 1024) {
                    const token = crypto.randomBytes(32).toString('hex');
                    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
                    await query(
                        `INSERT INTO attendance_photos (attendance_id, employee_id, photo, token, expires_at, type)
                        VALUES ($1, $2, $3, $4, $5, 'check_out')`,
                        [result.rows[0].id, req.user.id, buf, token, expiresAt]
                    );
                    await query(
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
            'SELECT * FROM attendance WHERE employee_id = $1 AND date = $2',
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
            'SELECT * FROM attendance WHERE employee_id = $1 AND date = $2',
            [req.user.id, today]
        );

        if (record.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'No check-in found today' });
        }

        if (!record.rows[0].break_start) {
            return res.status(400).json({ success: false, message: 'Break not started yet' });
        }

        if (record.rows[0].break_end) {
            return res.status(400).json({ success: false, message: 'Break already ended' });
        }

        const existingLog = (() => {
            try { return JSON.parse(record.rows[0].break_log || '[]'); } catch { return []; }
        })();
        existingLog.push({ start: record.rows[0].break_start, end: now });

        const result = await query(
            `UPDATE attendance SET break_log = $1, break_start = NULL, break_end = NULL
            WHERE employee_id = $2 AND date = $3 RETURNING *`,
            [JSON.stringify(existingLog), req.user.id, today]
        );

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
                break_start = NULL, break_end = NULL, break_log = NULL, overtime_hours = 0,
                remarks = NULL, check_in_location = NULL
                WHERE employee_id = $2 AND date = $3 RETURNING *`,
                [officeStart, employee_id, date]
            );
            res.json({ success: true, attendance: result.rows[0], message: 'Marked as present' });
        } else {
            const result = await query(
                `INSERT INTO attendance (employee_id, date, check_in, status)
                VALUES ($1, $2, $3, 'present') RETURNING *`,
                [employee_id, date, officeStart]
            );
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
        const newStatus = status || 'absent';
        if (newStatus !== 'absent') {
            await query(
                'DELETE FROM attendance WHERE employee_id = $1 AND date = $2',
                [employee_id, date]
            );
            return res.json({ success: true, message: 'Attendance reset' });
        }
        const existing = await query(
            'SELECT id FROM attendance WHERE employee_id = $1 AND date = $2',
            [employee_id, date]
        );
        if (existing.rows.length > 0) {
            const result = await query(
                `UPDATE attendance SET status = 'absent', check_in = NULL, check_out = NULL, 
                break_start = NULL, break_end = NULL, break_log = NULL, overtime_hours = 0,
                remarks = COALESCE($1, remarks)
                WHERE employee_id = $2 AND date = $3 RETURNING *`,
                [remarks, employee_id, date]
            );
            res.json({ success: true, attendance: result.rows[0], message: 'Marked as absent' });
        } else {
            const result = await query(
                `INSERT INTO attendance (employee_id, date, status, remarks) 
                VALUES ($1, $2, 'absent', $3) RETURNING *`,
                [employee_id, date, remarks]
            );
            res.json({ success: true, attendance: result.rows[0], message: 'Marked as absent' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.get('/my', verifyToken, async (req, res) => {
    try {
        const { month, year } = req.query;
        let sqlQuery = `SELECT a.id, a.employee_id, a.date, a.check_in, a.check_out, a.status,
                a.overtime_hours, a.remarks, a.created_at, a.break_start, a.break_end, a.break_log,
                a.check_in_location, a.check_out_location,
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
        const result = await query(sqlQuery, params);
        res.json({ success: true, attendance: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.get('/all', verifyToken, isAdmin, async (req, res) => {
    try {
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
        res.json({ success: true, attendance: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.get('/late-count', verifyToken, isAdmin, async (req, res) => {
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
            HAVING late_count > 0
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

        const employees = await query(
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
        const fmtD = (v) => String(v).substring(0, 10);
        const key = (empId, day) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const leaveByEmp = {};
        leaveRows.rows.forEach(l => {
            const s = fmtD(l.start_date), e = fmtD(l.end_date);
            if (!s || !e) return;
            let c = new Date(s + 'T00:00:00Z');
            const cEnd = new Date(e + 'T00:00:00Z');
            while (c <= cEnd) {
                const ds = c.toISOString().substring(0, 10);
                (leaveByEmp[l.employee_id] = leaveByEmp[l.employee_id] || new Set()).add(ds);
                c.setUTCDate(c.getUTCDate() + 1);
            }
        });

        // Paid/LOP classification: the FIRST approved leave day of the month is
        // paid ('onleave'); any extra leave days beyond it are LOP ('absent').
        const leaveClassByEmp = {};
        Object.keys(leaveByEmp).forEach(empId => {
            const days = Array.from(leaveByEmp[empId]).sort();
            const cls = {};
            let leaveCount = 0;
            days.forEach(ds => {
                cls[ds] = leaveCount < 1 ? 'paid' : 'lop';
                if (cls[ds] === 'paid') leaveCount++;
            });
            leaveClassByEmp[empId] = cls;
        });

        const matrix = {};
        const today = new Date();
        today.setHours(0,0,0,0);
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
router.get('/export', verifyToken, isAdmin, async (req, res) => {
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
            return String(l.start_date).substring(0, 10) <= ds && String(l.end_date).substring(0, 10) >= ds;
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
router.get('/photo/:token', verifyToken, isAdmin, async (req, res) => {
    try {
        const result = await query(
            'SELECT * FROM attendance_photos WHERE token = $1',
            [req.params.token]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Photo not found or already viewed' });
        }

        const photo = result.rows[0];

        if (new Date(photo.expires_at) < new Date()) {
            await query('DELETE FROM attendance_photos WHERE id = $1', [photo.id]);
            return res.status(404).json({ success: false, message: 'Photo has expired' });
        }

        const buf = Buffer.isBuffer(photo.photo) ? photo.photo : Buffer.from(photo.photo);

        await query(
            "UPDATE attendance_photos SET viewed = 1, viewed_at = NOW() WHERE id = $1",
            [photo.id]
        );
        await query('DELETE FROM attendance_photos WHERE id = $1', [photo.id]);

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
