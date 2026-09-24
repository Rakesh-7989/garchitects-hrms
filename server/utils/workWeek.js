const { query } = require('../config/database');

// Work-week policy, cached 30s. Keys live in company_settings:
//   weekoff_day         0=Sunday..6=Saturday (the ONE weekly off day)
//   weekly_working_days how many working days per week
//   monthly_leave_quota how many paid leave days an employee gets per month
const DEFAULTS = { weekoffDay: 0, weeklyWorkingDays: 6, monthlyLeaveQuota: 1 };
let cache = null;
let cacheAt = 0;
const TTL_MS = 30 * 1000;

async function getWorkWeekConfig(force = false) {
    const now = Date.now();
    if (!force && cache && now - cacheAt < TTL_MS) return cache;
    try {
        const res = await query(
            `SELECT setting_key, setting_value FROM company_settings
             WHERE setting_key IN ('weekoff_day','weekly_working_days','monthly_leave_quota')`
        );
        const map = {};
        (res.rows || []).forEach(r => { map[r.setting_key] = r.setting_value; });
        const d = parseInt(map.weekoff_day, 10);
        cache = {
            weekoffDay: (d >= 0 && d <= 6) ? d : DEFAULTS.weekoffDay,
            weeklyWorkingDays: parseInt(map.weekly_working_days, 10) || DEFAULTS.weeklyWorkingDays,
            monthlyLeaveQuota: parseInt(map.monthly_leave_quota, 10) || DEFAULTS.monthlyLeaveQuota
        };
    } catch (e) {
        cache = { ...DEFAULTS };
    }
    cacheAt = now;
    return cache;
}

// Is this date the configured weekly off day? Accepts a Date or 'YYYY-MM-DD'.
function isWeekOff(dateLike, weekoffDay = DEFAULTS.weekoffDay) {
    const d = dateLike instanceof Date ? dateLike : new Date(dateLike + 'T00:00:00');
    return d.getDay() === weekoffDay;
}

// Day index of a date (0=Sunday..6=Saturday), with the same input tolerance.
function dayOfWeek(dateLike) {
    const d = dateLike instanceof Date ? dateLike : new Date(dateLike + 'T00:00:00');
    return d.getDay();
}

module.exports = { getWorkWeekConfig, isWeekOff, dayOfWeek, DEFAULTS };