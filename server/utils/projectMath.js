// Single source of truth for Projects module arithmetic.
//
// Before this file, the same "working days / per-employee target / achievement"
// calculations were duplicated in FOUR places (project-sets create, the admin
// project-management preview, project-reports, daily-work-counts summary) with
// subtly different formulas and rounding (Math.ceil vs exact division, whole-set
// vs per-employee denominators, holidays ignored). Every place that must agree —
// sets, reports, summaries, exports and the client previews — should call these
// helpers so a target split shown at set creation is exactly what the reports
// and daily-work-counts compute.
const { query } = require('../config/database');
const { getWorkWeekConfig, isWeekOff } = require('./workWeek');

// Local 'YYYY-MM-DD' key (getFullYear/getMonth/getDate, so no UTC shift for
// Asia/Kolkata timezones like toISOString().slice(0,10) would introduce).
function toYMD(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

// Normalise a pg date result (Date object or 'YYYY-MM-DD' string) to a date key.
function dateKey(v) {
    if (!v) return '';
    if (v instanceof Date && !isNaN(v.getTime())) return toYMD(v);
    const s = String(v);
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}

// Working days between two 'YYYY-MM-DD' dates (inclusive), excluding the
// configured weekly off day (company_settings.weekoff_day) AND company holidays
// (holidays table). Mirrors the attendance/payroll weekday policy.
async function workingDays(startDate, endDate) {
    if (!startDate || !endDate) return 0;
    const sVal = dateKey(startDate);
    const eVal = dateKey(endDate);
    const start = new Date(`${sVal}T00:00:00`);
    const end = new Date(`${eVal}T00:00:00`);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) return 0;

    const wcfg = await getWorkWeekConfig();

    const holidays = new Set();
    try {
        const r = await query(
            `SELECT date FROM holidays WHERE is_active = 1 AND date BETWEEN $1::date AND $2::date`,
            [sVal, eVal]
        );
        (r.rows || []).forEach(row => holidays.add(dateKey(row.date)));
    } catch (_) {
        // holidays table may be missing on a legacy DB; the schema-repair
        // wrapper heals it on the next real query. Count as no-holiday here so
        // the request never fails just to compute a preview number.
    }

    let count = 0;
    const cur = new Date(start);
    while (cur <= end) {
        if (!isWeekOff(cur, wcfg.weekoffDay) && !holidays.has(toYMD(cur))) count++;
        cur.setDate(cur.getDate() + 1);
    }
    return count;
}

// Exact per-employee share of a set's total target. Honest division (a 90-file
// target across 3 people is 30 each, not ceil(30) = 30 or a whole-set %).
function perEmployeeTarget(totalTarget, teamSize) {
    const t = Number(totalTarget) || 0;
    const n = Number(teamSize) || 0;
    return n > 0 ? t / n : t;
}

// What a single employee is expected to produce per working day.
function dailyPerEmployeeTarget(totalTarget, teamSize, workingDaysCount) {
    const wd = Number(workingDaysCount) || 0;
    const perHead = perEmployeeTarget(totalTarget, teamSize);
    return wd > 0 ? perHead / wd : perHead;
}

// Achievement percentage, one rounding rule everywhere: 1 decimal, rounded.
function achievementPercent(actual, target) {
    const a = Number(actual) || 0;
    const t = Number(target) || 0;
    if (t <= 0) return 0;
    return Math.round((a / t) * 1000) / 10;
}

// RA-bill retention (Indian practice: 5-10% held against defects liability).
// Money is rounded to 2 decimals (cents) on every step so the server-computed
// retention/net exactly matches what the client preview shows.
function retentionAmount(grossValue, retentionPct) {
    const g = Number(grossValue) || 0;
    const p = Number(retentionPct) || 0;
    if (g <= 0 || p <= 0) return 0;
    return Math.round(g * Math.min(p, 100) / 100 * 100) / 100;
}

function netValue(grossValue, retentionPct) {
    const g = Number(grossValue) || 0;
    return Math.round((g - retentionAmount(g, retentionPct)) * 100) / 100;
}

module.exports = { workingDays, perEmployeeTarget, dailyPerEmployeeTarget, achievementPercent, retentionAmount, netValue, toYMD, dateKey };