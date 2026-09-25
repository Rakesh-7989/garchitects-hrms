// Client mirror of server/utils/projectMath.js. Same formulas so the admin
// "target split" preview and any employee-side hints match exactly what the
// server stores in project_sets.working_days and reports back as achievements.
(function () {
    function toYMD(d) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    function perEmployeeTarget(totalTarget, teamSize) {
        const t = Number(totalTarget) || 0;
        const n = Number(teamSize) || 0;
        return n > 0 ? t / n : t;
    }

    function dailyPerEmployeeTarget(totalTarget, teamSize, workingDaysCount) {
        const wd = Number(workingDaysCount) || 0;
        const perHead = perEmployeeTarget(totalTarget, teamSize);
        return wd > 0 ? perHead / wd : perHead;
    }

    function achievementPercent(actual, target) {
        const a = Number(actual) || 0;
        const t = Number(target) || 0;
        if (t <= 0) return 0;
        return Math.round((a / t) * 1000) / 10;
    }

    // RA-bill retention (mirrors server projectMath - money to 2 decimals).
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

    // Working days in [startDate, endDate] (inclusive) excluding the configured
    // weekly off day and any optional holiday dates. On the server this also
    // reads company holidays from the DB; callers that already fetched /holidays
    // should pass them as an array/Set of 'YYYY-MM-DD' strings to match.
    function workingDaysBetween(startDate, endDate, holidayDates) {
        if (!startDate || !endDate || String(endDate) < String(startDate)) return 0;
        const start = new Date(String(startDate) + 'T00:00:00');
        const end = new Date(String(endDate) + 'T00:00:00');
        const skip = holidayDates ? new Set(holidayDates) : null;
        let count = 0;
        for (let cur = new Date(start); cur <= end; cur.setDate(cur.getDate() + 1)) {
            const isOff = window.workWeek ? window.workWeek.isWeekOff(cur) : cur.getDay() === 0;
            if (isOff) continue;
            if (skip && skip.has(toYMD(cur))) continue;
            count++;
        }
        return count;
    }

    window.projectMath = { perEmployeeTarget, dailyPerEmployeeTarget, achievementPercent, retentionAmount, netValue, workingDaysBetween };
})();