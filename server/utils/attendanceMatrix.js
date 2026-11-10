// Shared per-employee month-cell builder.
//
// The attendance matrix (GET /api/attendance/monthly) and the per-employee
// drill-down (GET /api/employees/:id/activity) must agree on what a day looks
// like - a LOP leave day is "absent" but a paid leave day is "onleave", a
// holiday an admin marked absent is "absent", today without a record is not an
// absence, and so on. Duplicating that logic in two places is how the two
// views silently drift apart, so it lives here and both call it.

// Resolve one employee's day cells for a month.
//
// @param {object} o
// @param {number} o.year
// @param {number} o.month          1-12
// @param {number} o.days           number of days in the month
// @param {object} o.attMap         { [day]: { status, check_in, check_out, check_in_location, remarks } }
// @param {object} o.leaveClass     { 'YYYY-MM-DD': 'paid' | 'lop' }
// @param {Set}    o.holidaySet     { 'YYYY-MM-DD' }
// @param {object} o.wcfg           { weekoffDay }
// @param {Date}   o.today          local midnight of "today"
function buildEmployeeMonthCells(o) {
    const { year, month, days, attMap, leaveClass, holidaySet, wcfg, today } = o;
    const cells = {};
    const weekoffDay = (wcfg && typeof wcfg.weekoffDay === 'number') ? wcfg.weekoffDay : 0;
    for (let d = 1; d <= days; d++) {
        const date = new Date(year, month - 1, d);
        const dayOfWeek = date.getDay();
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const rec = attMap[d] || null;
        const leaveCls = (leaveClass || {})[dateStr];

        if (date > today) {
            cells[d] = { status: 'upcoming', check_in: null, check_out: null };
        } else if (dayOfWeek === weekoffDay) {
            // Week off (the ONE configured weekly off day). An EXPLICIT
            // attendance record always wins (a real check-in, or a weekoff an
            // admin marked absent). With no record it shows the default Week
            // Off, or a leave day.
            if (rec) {
                cells[d] = rec;
            } else if (leaveCls) {
                cells[d] = { status: leaveCls === 'paid' ? 'onleave' : 'absent', check_in: null, check_out: null, leave: true };
            } else {
                cells[d] = { status: 'weekoff', check_in: null, check_out: null };
            }
        } else if (holidaySet.has(dateStr)) {
            // Declared holiday: ALWAYS shown as H for everyone unless an
            // admin explicitly marked this holiday absent for this employee
            // (recognised by its remark) - then it shows A.
            const adminHolidayAbsent = rec && rec.status === 'absent' && /Admin marked holiday absent/.test(rec.remarks || '');
            if (adminHolidayAbsent) {
                cells[d] = { status: 'absent', check_in: null, check_out: null, remarks: rec.remarks || '', leave: false };
            } else if (leaveCls) {
                cells[d] = { status: leaveCls === 'paid' ? 'onleave' : 'absent', check_in: null, check_out: null, leave: true };
            } else {
                cells[d] = { status: 'holiday', check_in: null, check_out: null };
            }
        } else if (leaveCls) {
            // Approved leave (paid within monthly quota, LOP beyond). An
            // auto-marked/back-filled 'absent' row must not shadow it.
            cells[d] = { status: leaveCls === 'paid' ? 'onleave' : 'absent', check_in: null, check_out: null, leave: true };
        } else if (rec) {
            cells[d] = rec;
        } else if (date.getTime() === today.getTime()) {
            // Today with no record yet is NOT an absence: the employee may
            // simply not have checked in (or is on the way). Keep the cell
            // neutral like future days so the grid doesn't show everyone
            // "Absent" at 9 AM and inflate the month's Absent count. The day
            // only becomes absent once it is over (the auto-absent backend's
            // job).
            cells[d] = { status: 'upcoming', check_in: null, check_out: null };
        } else {
            cells[d] = { status: 'absent', check_in: null, check_out: null };
        }
    }
    return cells;
}

// Count the day cells of a month into the summary the UI shows
// (present / late / half-day / on-leave / wfh / absent / week-off / holiday).
function summariseMonthCells(cells) {
    const s = { present: 0, late: 0, halfDay: 0, absent: 0, leave: 0, wfh: 0, weekoff: 0, holiday: 0, upcoming: 0 };
    for (const key of Object.keys(cells || {})) {
        const cell = cells[key] || {};
        const isLopLeave = cell.status === 'absent' && cell.leave === true;
        switch (cell.status) {
            case 'present': s.present++; break;
            case 'late': s.late++; break;
            case 'half-day': s.halfDay++; break;
            case 'onleave': s.leave++; break;
            case 'wfh': s.wfh++; break;
            case 'holiday': s.holiday++; break;
            case 'weekoff': s.weekoff++; break;
            case 'upcoming': s.upcoming++; break;
            case 'absent': if (isLopLeave) s.leave++; else s.absent++; break;
            default: break;
        }
    }
    return s;
}

module.exports = { buildEmployeeMonthCells, summariseMonthCells };
