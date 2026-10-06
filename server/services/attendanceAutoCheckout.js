// Attendance auto-checkout.
//
// Business rule (founder requirement):
//   office_end_time + checkout_grace_minutes (default 120) = the checkout
//   deadline. If an employee checked in but never checked out by then, the
//   system auto-checks them out at the deadline. The FIRST miss in a month is
//   only a warning; from the 2nd miss onward (once the month's miss count
//   reaches checkout_miss_limit, default 2) the day is marked HALF-DAY (never
//   absent). Every miss is recorded, a warning notification is sent, and the
//   employee is asked for a reason, regardless of whether it became half-day.
//
// Runs two ways, both idempotent:
//   1. Lazily, from the attendance read endpoints (so data self-corrects even
//      if the cron never fires).
//   2. From the /api/cron/auto-checkout Vercel cron shortly after the deadline.
//
// Never throws: it is a sidecar on top of reads/cron and must not break them.

const { query } = require('../config/database');
const { runWithSchemaRepair } = require('../utils/schemaRepair');
const { istDateString } = require('../utils/date');
const { notify, peopleManagerIds } = require('./notify');
const { logAudit } = require('../utils/audit');

const q = (sql, params) => runWithSchemaRepair(() => query(sql, params));

function pad2(n) { return String(n).padStart(2, '0'); }

// 'HH:MM' (or 'HH:MM:SS') -> minutes since midnight, or null when unparseable.
function toMinutes(hhmm) {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
    if (!m) return null;
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
}

// Minutes since midnight -> 'HH:MM:SS', clamped to a legal TIME (< 24:00).
function toTimeString(minutes) {
    const capped = Math.max(0, Math.min(minutes, 23 * 60 + 59));
    return pad2(Math.floor(capped / 60)) + ':' + pad2(capped % 60) + ':00';
}

// Current time in the company timezone as minutes since midnight.
function nowMinutesIST() {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date());
    const h = parseInt(parts.find(p => p.type === 'hour').value, 10);
    const m = parseInt(parts.find(p => p.type === 'minute').value, 10);
    return h * 60 + m;
}

async function getSetting(key, fallback) {
    try {
        const r = await q('SELECT setting_value FROM company_settings WHERE setting_key = $1', [key]);
        if (r.rows && r.rows.length) {
            const v = r.rows[0].setting_value;
            if (v !== null && v !== undefined && String(v).trim() !== '') return String(v).trim();
        }
    } catch (_) { /* fall through to default */ }
    return fallback;
}

/**
 * Close every still-open attendance for `dateStr` (default: today IST) once the
 * checkout grace deadline has passed.
 *
 * @param {string} [dateStr] YYYY-MM-DD
 * @returns {Promise<{success:boolean, date?:string, closed?:number, skipped?:string, error?:string}>}
 */
async function runAutoCheckout(dateStr) {
    const date = dateStr || istDateString();
    try {
        const officeEnd = await getSetting('office_end_time', '18:30');
        const graceRaw = parseInt(await getSetting('checkout_grace_minutes', '120'), 10);
        const limitRaw = parseInt(await getSetting('checkout_miss_limit', '2'), 10);
        const graceMin = Number.isFinite(graceRaw) && graceRaw >= 0 ? graceRaw : 120;
        const limit = Number.isFinite(limitRaw) && limitRaw >= 0 ? limitRaw : 2;

        const endMin = toMinutes(officeEnd);
        if (endMin === null) return { success: true, date, closed: 0, skipped: 'no_office_end' };
        const deadlineMin = endMin + graceMin;
        const deadlineTime = toTimeString(deadlineMin);

        // Only enforce today's deadline on today; a back-filled past date is
        // always past the deadline.
        if (date === istDateString() && nowMinutesIST() < deadlineMin) {
            return { success: true, date, closed: 0, skipped: 'before_grace_deadline' };
        }

        const open = await q(
            `SELECT a.id, a.employee_id, e.first_name, e.last_name
               FROM attendance a
               JOIN employees e ON e.id = a.employee_id
              WHERE a.date = $1 AND a.check_in IS NOT NULL AND a.check_out IS NULL
                AND COALESCE(a.status, '') NOT IN ('holiday', 'weekoff')`,
            [date]
        );

        let closed = 0;
        const escalated = [];

        for (const row of open.rows) {
            // Count this employee's auto-checkouts for the month BEFORE closing
            // this one, so the current miss is counted exactly once and re-runs
            // stay idempotent (already-closed rows are not in `open`).
            const cnt = await q(
                `SELECT COUNT(*)::int AS n FROM attendance
                  WHERE employee_id = $1 AND auto_checkout = TRUE
                    AND date >= date_trunc('month', $2::date)
                    AND date < date_trunc('month', $2::date) + INTERVAL '1 month'`,
                [row.employee_id, date]
            );
            const priorMisses = (cnt.rows[0] && cnt.rows[0].n) || 0;
            const missCount = priorMisses + 1;

            // Rule (founder): the FIRST miss in the month is only a warning; from
            // the 2nd miss onward (once the monthly miss count reaches the
            // configured limit) the day is marked HALF-DAY.
            const markHalfDay = missCount >= limit;
            const hhmm = deadlineTime.slice(0, 5);

            const upd = await q(
                `UPDATE attendance
                    SET check_out = $1,
                        status = CASE WHEN $3 THEN 'half-day' ELSE status END,
                        auto_checkout = TRUE,
                        auto_checkout_at = NOW()
                  WHERE id = $2 AND check_out IS NULL
                  RETURNING id`,
                [deadlineTime, row.id, markHalfDay]
            );
            if (!upd.rows.length) continue;
            closed++;

            // 1) Warn the employee and ask for the reason. The warning is sent on
            //    EVERY miss; only the day-status differs.
            await notify({
                employeeId: row.employee_id,
                type: 'attendance_auto_checkout',
                title: markHalfDay
                    ? 'Missed checkout — day marked half-day'
                    : 'Missed checkout — warning',
                body: markHalfDay
                    ? `You did not check out on ${date}. The system auto-closed your attendance at the grace deadline (${hhmm}) and marked the day half-day. Missed checkouts this month: ${missCount}. Please add the reason in Attendance → Missed Checkouts.`
                    : `You did not check out on ${date}. The system auto-closed your attendance at the grace deadline (${hhmm}) and logged this as a warning. This is missed checkout #${missCount} this month — once you reach ${limit} in a month, the day is marked half-day. Please add the reason in Attendance → Missed Checkouts.`,
                url: '/employee/attendance',
                entityType: 'attendance_auto_checkout',
                entityId: row.id
            });

            // Record it durably (independent of the notification).
            logAudit({
                actorId: null,
                action: 'attendance.auto_checkout',
                entityType: 'attendance',
                entityId: row.id,
                details: { date, employee_id: row.employee_id, misses_this_month: missCount, half_day: markHalfDay, limit }
            });

            if (missCount > limit) {
                escalated.push({
                    employeeId: row.employee_id,
                    attendanceId: row.id,
                    missCount,
                    name: `${row.first_name || ''} ${row.last_name || ''}`.trim() || 'An employee'
                });
            }
        }

        if (escalated.length) {
            const managers = await peopleManagerIds();
            for (const e of escalated) {
                for (const mgr of managers) {
                    await notify({
                        employeeId: mgr,
                        type: 'attendance_auto_checkout_exceeded',
                        title: 'Employee exceeded monthly missed-checkout limit',
                        body: `${e.name} missed checkout ${e.missCount} times this month (limit ${limit}).`,
                        url: '/admin/attendance',
                        entityType: 'attendance_auto_checkout_escalation',
                        entityId: e.attendanceId
                    });
                }
            }
        }

        return { success: true, date, closed };
    } catch (error) {
        console.error('runAutoCheckout failed:', error && error.message);
        return { success: false, error: error && error.message };
    }
}

module.exports = { runAutoCheckout };