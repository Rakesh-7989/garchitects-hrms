const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { runWithSchemaRepair } = require('../utils/schemaRepair');
const { istDateString } = require('../utils/date');

// @route   GET /api/team-updates
// @desc    "Who reported today" for the caller's reporting tree
// @access  Private (manager / team_lead / admin / hr)
//
// WHY THIS ROUTE EXISTS
// --------------------
// An employee posting a daily update was invisible to their own reporting
// manager. project_daily_updates was written and then only ever readable on the
// admin's project page; the manager's own "My Team" page had no tab for it, and
// /project-leads/mine (which the team-lead project pages read) is empty until
// somebody is formally made a project lead. So in practice a manager could not
// answer "did my team report today?" anywhere in the product - which is the only
// question the feature exists to answer.
//
// This route is the answer, and it is deliberately reporting-TREE scoped
// (reporting_manager_id / secondary_reporting_manager_id) rather than
// project-scoped, because the roster is a people question, not a project one.
//
// EXPECTED-TO-REPORT
// ------------------
// "Hasn't reported" is only meaningful against someone who was supposed to. The
// roster excludes, per person per date:
//   - non-active employees (inactive/terminated/...)
//   - the weekly off day (company_settings.weekoff_day)
//   - a declared holiday (holidays.is_active = 1)
//   - approved leave covering that date
//   - someone who joined after the date, or whose last_working_day precedes it
// Approved WFH is NOT an exemption - working from home is still working, so they
// are expected to file an update. That is the professional rule, and it is the
// one the site teams actually want.
//
// This is ADVISORY. Nothing here blocks anyone from working or marks attendance;
// it exists so a manager can see a gap and ask about it. A hard "you must post"
// lock would be worse than useless on a construction site.

const safe = (p) => p.catch((err) => {
    console.error('team-updates query failed:', err.message);
    return { rows: [] };
});
const q = (sql, params) => safe(runWithSchemaRepair(() => query(sql, params)));

/** Roles allowed to see a team view. Employees get 403 - they have /api/project-updates for their own. */
const CAN_VIEW_TEAM = ['admin', 'hr', 'manager', 'team_lead'];

function setting(key, fallback) {
    return query(`SELECT setting_value FROM company_settings WHERE setting_key = $1`, [key])
        .then(r => ((r.rows[0] || {}).setting_value !== undefined && (r.rows[0] || {}).setting_value !== null)
            ? String(r.rows[0].setting_value) : fallback)
        .catch(() => fallback);
}

/** Validate + default a YYYY-MM-DD query param, falling back to today (IST). */
function resolveDate(raw) {
    const d = String(raw || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : istDateString();
}

/**
 * The caller's reporting tree: people who report to me directly or as secondary
 * manager. Admin/HR see everyone (the owner needs the whole picture; HR needs it
 * for reporting), managers/team_leads see their own tree only.
 *
 * startIndex is explicit because callers bind different leading params, and a
 * hardcoded $1 would silently bind to the wrong value.
 */
function rosterClause(req, startIndex) {
    if (req.user.role === 'admin' || req.user.role === 'hr') {
        return { clause: '', params: [] };
    }
    const me = `$${startIndex}`;
    return {
        clause: ` AND (e.reporting_manager_id = ${me} OR e.secondary_reporting_manager_id = ${me})`,
        params: [req.user.id]
    };
}

router.get('/', verifyToken, async (req, res) => {
    try {
        if (!CAN_VIEW_TEAM.includes(req.user.role)) {
            return res.status(403).json({ success: false, message: 'Only managers can view team daily updates' });
        }
        const date = resolveDate(req.query.date);
        const scope = rosterClause(req, 2); // $1 is the date

        const [weekoffRaw, cutoffRaw, holiday] = await Promise.all([
            setting('weekoff_day', '0'),
            setting('daily_update_cutoff_time', ''),
            q(`SELECT name FROM holidays WHERE date = $1 AND is_active = 1 LIMIT 1`, [date])
        ]);
        const weekoff = Number(weekoffRaw);
        const holidayName = (holiday.rows[0] || {}).name || null;

        // Day of week for the chosen date. Date arithmetic is done in SQL on the
        // date itself (no JS Date), so this cannot drift with the server timezone.
        const dowRow = await q(`SELECT EXTRACT(ISODOW FROM $1::date)::int AS dow`, [date]);
        const dow = parseInt((dowRow.rows[0] || {}).dow, 10) || 0; // 1=Mon .. 7=Sun
        const isWeekoff = Number.isFinite(weekoff) && weekoff >= 0 && weekoff <= 6 && dow === weekoff + 1;
        const nonWorkingDay = isWeekoff || !!holidayName;

        // Roster + exemption flags in one pass.
        const people = await q(
            `SELECT e.id, e.employee_id, e.first_name, e.last_name, e.role,
                    e.joining_date, e.last_working_day, e.designation_id,
                    d.name AS designation,
                    (e.joining_date > $1::date) AS joined_after,
                    (e.last_working_day IS NOT NULL AND e.last_working_day < $1::date) AS left_before,
                    EXISTS (
                        SELECT 1 FROM leave_applications la
                        WHERE la.employee_id = e.id AND la.status = 'approved'
                          AND la.start_date <= $1::date AND la.end_date >= $1::date
                    ) AS on_leave
             FROM employees e
             LEFT JOIN designations d ON d.id = e.designation_id
             WHERE e.status = 'active'${scope.clause}
             ORDER BY e.first_name, e.last_name`,
            [date, ...scope.params]
        );

        const roster = people.rows || [];
        const ids = roster.map(p => p.id);

        // Their daily updates for that date.
        let updates = [];
        if (ids.length) {
            const u = await q(
                `SELECT du.id, du.employee_id, du.project_id, du.unit_id, du.task_cat,
                        du.description, du.hours, du.notes, du.created_at,
                        p.name AS project_name, u.name AS unit_name,
                        (SELECT 1 FROM daily_update_reads dr
                          WHERE dr.manager_id = $2 AND dr.daily_update_id = du.id) AS seen
                 FROM project_daily_updates du
                 JOIN projects p ON p.id = du.project_id
                 LEFT JOIN project_units u ON u.id = du.unit_id
                 WHERE du.employee_id = ANY($1::int[]) AND du.update_date = $3::date
                 ORDER BY du.created_at DESC`,
                [ids, req.user.id, date]
            );
            updates = u.rows || [];
        }

        // Group by person, preserving roster order.
        const byPerson = new Map();
        for (const r of roster) {
            byPerson.set(r.id, {
                employee_id: r.employee_id,
                name: [r.first_name, r.last_name].filter(Boolean).join(' '),
                first_name: r.first_name,
                role: r.role,
                designation: r.designation || null,
                // An exemption is shown to the manager WITH its reason - "on leave"
                // and "weekly off" are answers, silence would look like a gap.
                exempt: (!!nonWorkingDay) || r.joined_after || r.left_before || r.on_leave,
                exempt_reason: nonWorkingDay
                    ? (holidayName ? holidayName : 'Weekly off')
                    : r.joined_after ? 'Joined after this date'
                        : r.left_before ? 'Left before this date'
                            : r.on_leave ? 'On approved leave' : null,
                expected: !nonWorkingDay && !r.joined_after && !r.left_before && !r.on_leave,
                updates: [],
                total_hours: 0
            });
        }
        for (const du of updates) {
            const p = byPerson.get(du.employee_id);
            if (!p) continue;
            p.updates.push({
                id: du.id,
                project: du.project_name,
                unit: du.unit_name,
                task_cat: du.task_cat,
                description: du.description,
                hours: parseFloat(du.hours || 0) || 0,
                notes: du.notes,
                created_at: du.created_at,
                seen: !!du.seen
            });
            p.total_hours = Math.round((p.total_hours + (parseFloat(du.hours || 0) || 0)) * 10) / 10;
        }

        const team = [...byPerson.values()];
        const expected = team.filter(p => p.expected);
        const reported = expected.filter(p => p.updates.length > 0);
        const notReported = expected.filter(p => p.updates.length === 0);

        res.json({
            success: true,
            date,
            cutoff_time: cutoffRaw || null,
            non_working_day: nonWorkingDay,
            non_working_reason: nonWorkingDay ? (holidayName || 'Weekly off') : null,
            summary: {
                total: team.length,
                expected: expected.length,
                reported: reported.length,
                not_reported: notReported.length,
                total_hours: Math.round(team.reduce((s, p) => s + p.total_hours, 0) * 10) / 10,
                unseen: updates.filter(u => !u.seen).length
            },
            not_reported: notReported.map(p => ({ employee_id: p.employee_id, name: p.name })),
            team
        });
    } catch (error) {
        console.error('team-updates error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

/**
 * @route   POST /api/team-updates/seen
 * @desc    Mark the caller's reports' daily updates as seen
 * @access  Private (manager / team_lead / admin / hr)
 *
 * Scoped to the caller's own reporting tree on purpose: a manager cannot mark
 * somebody else's reads, only their own view of their own team.
 */
router.post('/seen', verifyToken, async (req, res) => {
    try {
        if (!CAN_VIEW_TEAM.includes(req.user.role)) {
            return res.status(403).json({ success: false, message: 'Only managers can mark team updates seen' });
        }
        const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
        const clean = ids.map(x => parseInt(x, 10)).filter(x => !Number.isNaN(x) && x > 0).slice(0, 500);
        if (!clean.length) {
            return res.status(400).json({ success: false, message: 'No update ids supplied' });
        }
        // $1 = me, $2 = ids, so the tree clause binds to $3.
        const scope = rosterClause(req, 3);
        // The employee_id IN (own tree) sub-select is the guard: only updates
        // written by people who report to the caller can be acknowledged.
        const r = await q(
            `INSERT INTO daily_update_reads (manager_id, daily_update_id)
             SELECT $1, du.id
             FROM project_daily_updates du
             WHERE du.id = ANY($2::int[])
               AND du.employee_id IN (
                     SELECT e.id FROM employees e WHERE e.status = 'active'${scope.clause}
               )
             ON CONFLICT (manager_id, daily_update_id) DO NOTHING`,
            [req.user.id, clean, ...scope.params]
        );
        // The bell shows a "someone posted a report" message for each of these, and the
        // My Team tab shows an unseen count for the same rows. One action must
        // resolve both, otherwise the manager marks the tab reviewed and the bell
        // still nags them about the same update.
        safe(runWithSchemaRepair(() => query(
            `UPDATE user_notifications SET read_at = NOW()
             WHERE employee_id = $1 AND type = 'work_update' AND entity_type = 'project_daily_update'
               AND entity_id = ANY($2::int[]) AND read_at IS NULL`,
            [req.user.id, clean]
        ))).catch(() => {});

        res.json({ success: true, marked: r.rowCount || 0 });
    } catch (error) {
        console.error('team-updates seen error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

/**
 * @route   GET /api/team-updates/summary
 * @desc    Lightweight badge numbers for the My Team tab (today only)
 * @access  Private (manager / team_lead / admin / hr)
 *
 * Deliberately NOT derived from notifications: a manager wants "3 of 4 have not
 * reported", which is a statement about today, not about unread mail. It also
 * has to be cheap, because it is polled on every page load.
 */
router.get('/summary', verifyToken, async (req, res) => {
    try {
        if (!CAN_VIEW_TEAM.includes(req.user.role)) {
            return res.status(403).json({ success: false, message: 'Only managers can view team summary' });
        }
        const date = resolveDate(req.query.date);
        const scope = rosterClause(req, 1);
        const dowRow = await q(`SELECT EXTRACT(ISODOW FROM $1::date)::int AS dow`, [date]);
        const dow = parseInt((dowRow.rows[0] || {}).dow, 10) || 0;
        const weekoffRaw = await setting('weekoff_day', '0');
        const weekoff = Number(weekoffRaw);
        const holiday = await q(`SELECT 1 AS x FROM holidays WHERE date = $1 AND is_active = 1 LIMIT 1`, [date]);
        const nonWorkingDay = (Number.isFinite(weekoff) && weekoff >= 0 && weekoff <= 6 && dow === weekoff + 1)
            || holiday.rows.length > 0;

        const r = await q(
            `SELECT
                COUNT(*)::int AS expected,
                COUNT(*) FILTER (WHERE EXISTS (
                    SELECT 1 FROM project_daily_updates du
                    WHERE du.employee_id = e.id AND du.update_date = $1::date
                ))::int AS reported
             FROM employees e
             WHERE e.status = 'active'
               AND e.joining_date <= $1::date
               AND (e.last_working_day IS NULL OR e.last_working_day >= $1::date)
               AND NOT EXISTS (
                     SELECT 1 FROM leave_applications la
                     WHERE la.employee_id = e.id AND la.status = 'approved'
                       AND la.start_date <= $1::date AND la.end_date >= $1::date
               )${scope.clause}`,
            [date, ...scope.params]
        );
        const row = r.rows[0] || {};
        const expected = nonWorkingDay ? 0 : (parseInt(row.expected, 10) || 0);
        const reported = nonWorkingDay ? 0 : (parseInt(row.reported, 10) || 0);

        // New (unseen) updates from the caller's own tree - drives the tab badge.
        // Deliberately NOT date-filtered: a manager should not lose yesterday's
        // unreviewed reports by opening today's tab. $1 is always referenced, so
        // admin/hr (empty clause) still binds exactly one parameter.
        const unseenScope = rosterClause(req, 2);
        const unseen = await q(
            `SELECT COUNT(*)::int AS n
             FROM project_daily_updates du
             WHERE du.employee_id IN (SELECT e.id FROM employees e WHERE e.status = 'active'${unseenScope.clause})
               AND NOT EXISTS (
                     SELECT 1 FROM daily_update_reads dr
                     WHERE dr.manager_id = $1 AND dr.daily_update_id = du.id
               )`,
            [req.user.id, ...unseenScope.params]
        );

        res.json({
            success: true,
            date,
            non_working_day: nonWorkingDay,
            expected,
            reported,
            not_reported: Math.max(expected - reported, 0),
            unseen_total: parseInt((unseen.rows[0] || {}).n, 10) || 0
        });
    } catch (error) {
        console.error('team-updates summary error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

/**
 * @route   GET /api/team-updates/me
 * @desc    "Have I reported?" for the caller - the employee-side of the same rule
 * @access  Private (ALL roles - an employee needs to know their own status)
 *
 * The manager can see a gap, but if the employee cannot see it themselves the
 * manager's "3 of 4 have not reported" is just an accusation. Showing the same
 * status on the employee's own page turns it into a prompt.
 *
 * Also returns whether today is even a working day, so nobody is nagged to file a
 * report on a Sunday or a declared holiday.
 */
router.get('/me', verifyToken, async (req, res) => {
    try {
        const date = resolveDate(req.query.date);
        const [weekoffRaw, cutoffRaw, holiday] = await Promise.all([
            setting('weekoff_day', '0'),
            setting('daily_update_cutoff_time', ''),
            q(`SELECT name FROM holidays WHERE date = $1 AND is_active = 1 LIMIT 1`, [date])
        ]);
        const weekoff = Number(weekoffRaw);
        const dowRow = await q(`SELECT EXTRACT(ISODOW FROM $1::date)::int AS dow`, [date]);
        const dow = parseInt((dowRow.rows[0] || {}).dow, 10) || 0;
        const isWeekoff = Number.isFinite(weekoff) && weekoff >= 0 && weekoff <= 6 && dow === weekoff + 1;
        const holidayName = (holiday.rows[0] || {}).name || null;

        const me = await q(
            `SELECT e.joining_date, e.last_working_day, e.status,
                    (e.joining_date > $1::date) AS joined_after,
                    (e.last_working_day IS NOT NULL AND e.last_working_day < $1::date) AS left_before
             FROM employees e WHERE e.id = $2`,
            [date, req.user.id]
        );
        const row = me.rows[0] || {};
        const mine = await q(
            `SELECT COUNT(*)::int AS n, COALESCE(SUM(hours), 0) AS h
             FROM project_daily_updates WHERE employee_id = $1 AND update_date = $2::date`,
            [req.user.id, date]
        );
        const onLeave = await q(
            `SELECT 1 AS x FROM leave_applications
             WHERE employee_id = $1 AND status = 'approved' AND start_date <= $2::date AND end_date >= $2::date
             LIMIT 1`,
            [req.user.id, date]
        );

        const nonWorking = isWeekoff || !!holidayName;
        let exemptReason = null;
        if (nonWorking) exemptReason = holidayName || 'Weekly off';
        else if (row.joined_after) exemptReason = 'You had not joined on this date';
        else if (row.left_before) exemptReason = 'You had already left on this date';
        else if (onLeave.rows.length) exemptReason = 'On approved leave';

        const count = parseInt((mine.rows[0] || {}).n, 10) || 0;
        res.json({
            success: true,
            date,
            cutoff_time: cutoffRaw || null,
            non_working_day: nonWorking,
            exempt_reason: exemptReason,
            expected: !exemptReason && row.status === 'active',
            reported: count > 0,
            update_count: count,
            hours: Math.round((parseFloat((mine.rows[0] || {}).h) || 0) * 10) / 10
        });
    } catch (error) {
        console.error('team-updates/me error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;