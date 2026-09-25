// Shared frontend work-week policy helper.
// Fetches the admin-configured weekly off day (company_settings.weekoff_day)
// ONCE per page load and caches it, then exposes sync helpers the leave /
// WFH / project pages use for day-count previews. Falls back to Sunday (0)
// when the fetch fails or the setting is missing, so pages never break.
(function () {
    // 0=Sunday .. 6=Saturday
    let weekoffDay = 0;
    let weeklyWorkingDays = 6;
    let monthlyLeaveQuota = 1;
    let loaded = false;

    async function ensureLoaded() {
        if (loaded) return;
        try {
            const d = await apiCall('/settings/company');
            if (d && d.success && d.settings) {
                const v = parseInt(d.settings.weekoff_day, 10);
                if (v >= 0 && v <= 6) weekoffDay = v;
                const w = parseInt(d.settings.weekly_working_days, 10);
                if (w >= 1 && w <= 7) weeklyWorkingDays = w;
                const q = parseInt(d.settings.monthly_leave_quota, 10);
                if (q >= 1) monthlyLeaveQuota = q;
            }
        } catch (e) { /* keep default */ }
        loaded = true;
    }

    function dayOf(date) { return new Date(date).getDay(); }

    // Is this date the configured weekly off day?
    function isWeekOff(date) { return dayOf(date) === weekoffDay; }

    // Business days strictly between start+end (inclusive), excluding the
    // weekly off day (approved holidays are NOT excluded here - callers that
    // have holiday data subtract them separately).
    function businessDaysBetween(start, end) {
        let count = 0;
        const s = new Date(start);
        const e = new Date(end);
        for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
            if (dayOf(d) !== weekoffDay) count++;
        }
        return count;
    }

    // Auto-load once so pages can rely on the cached value by the time any
    // date-range preview runs (they run after user interaction).
    if (typeof apiCall === 'function') {
        ensureLoaded().catch(() => {});
    }

    window.workWeek = {
        ensureLoaded,
        isWeekOff,
        businessDaysBetween,
        get weekoffDay() { return weekoffDay; },
        get weeklyWorkingDays() { return weeklyWorkingDays; },
        get monthlyLeaveQuota() { return monthlyLeaveQuota; }
    };
})();