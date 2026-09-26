const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const PDFDocument = require('pdfkit');
const { query } = require('../config/database');
const { verifyToken, isAdmin, isManager } = require('../middleware/auth');
const { istDateString } = require('../utils/date');
const { sendPayslipEmail } = require('../services/email');
const { logAudit } = require('../utils/audit');
const { buildReportWorkbook, sendWorkbook } = require('../utils/excel');
const { getWorkWeekConfig } = require('../utils/workWeek');

const PP_MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Roboto ships with the Indian Rupee glyph (₹). pdfkit's built-in Helvetica
// cannot render it, so we embed Roboto and only fall back when the font files
// are missing. Uses ₹ on screen and in emails (client html2pdf renders it too).
const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
let fontsReady = false;
try {
    fs.accessSync(path.join(FONT_DIR, 'Roboto-Regular.ttf'));
    fs.accessSync(path.join(FONT_DIR, 'Roboto-Bold.ttf'));
    fontsReady = true;
} catch (e) {
    fontsReady = false;
}

const FONT_REG = fontsReady ? 'Roboto' : 'Helvetica';
const FONT_BOLD = fontsReady ? 'Roboto-Bold' : 'Helvetica-Bold';

function formatDateOnly(value) {
    if (!value) return '';
    if (value instanceof Date) return value.toISOString().split('T')[0];
    return String(value).substring(0, 10);
}

function num(value) {
    return Number(value) || 0;
}

// Indian numbering: Rupees .. Lakh .. Thousand .. Hundred .. Paise Only
function amountToWords(amount) {
    const value = Math.round(Number(amount || 0) * 100) / 100;
    const paise = Math.round((value - Math.floor(value)) * 100);
    const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
        'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
    const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

    function twoDigits(n) {
        if (n < 20) return ones[n];
        return (tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : ''));
    }

    function threeDigits(n) {
        const h = Math.floor(n / 100);
        const rest = n % 100;
        let str = '';
        if (h) str += ones[h] + ' Hundred' + (rest ? ' ' : '');
        if (rest) str += twoDigits(rest);
        return str.trim();
    }

    let rupees = Math.floor(value);
    let words = '';

    if (rupees === 0) {
        words = 'Zero';
    } else {
        const crore = Math.floor(rupees / 10000000);
        rupees %= 10000000;
        const lakh = Math.floor(rupees / 100000);
        rupees %= 100000;
        const thousand = Math.floor(rupees / 1000);
        rupees %= 1000;
        const hundred = Math.floor(rupees / 100);
        const rest = rupees % 100;

        if (crore) words += threeDigits(crore) + ' Crore ';
        if (lakh) words += twoDigits(lakh) + ' Lakh ';
        if (thousand) words += twoDigits(thousand) + ' Thousand ';
        if (hundred) words += ones[hundred] + ' Hundred ';
        if (rest) words += twoDigits(rest);
    }

    words = words.trim().replace(/\s+/g, ' ');
    let result = 'Rupees ' + words;
    if (paise > 0) {
        result += ' and ' + twoDigits(paise) + ' Paise';
    }
    result += ' Only';
    return result;
}

// Compute totals matching the payslip layout:
//   A = Earnings (basic + allowances), B = Deductions, C = Bonus (incl. extra work),
//   D = Employer contributions - shown separately on the payslip as an employer
//       cost and NEVER deducted from the employee's net pay.
//   Net = A + C - B - (per-day LOP deduction). ppCompute (client) mirrors this
//   exactly so the live preview always equals the generated PDF, and
//   server/index.js::repairPayrollNetSalaries reuses it so boot-time recomputes
//   can never drift from the /generate formula again.
function computeTotals(v) {
    const componentGross = num(v.basic_salary) + num(v.hra) + num(v.conveyance)
        + num(v.special_allowance) + num(v.other_allowance);
    const gross = num(v.monthly_gross) > 0 ? num(v.monthly_gross) : componentGross;
    const totalDeductions = num(v.pf) + num(v.esi) + num(v.professional_tax) + num(v.income_tax)
        + num(v.other_deduction);
    const bonus = num(v.bonus) + num(v.incentive) + num(v.extra_work);
    const employerTotal = num(v.employer_pf) + num(v.employer_esi) + num(v.employer_contribution);
    const workingDays = num(v.working_days);
    const presentDays = num(v.present_days);
    const leaveDays = num(v.leave_days);
    const lopDays = num(v.lop_days);
    const paidDays = presentDays + leaveDays;
    // Mid-month previews legitimately leave a gap: upcoming days are neither
    // present nor LOP, so the paid buckets only need to fit within working days.
    const attendanceValid = (presentDays + leaveDays + lopDays) <= workingDays + 0.001;
    const actualPayableGross = gross - totalDeductions + bonus;
    const totalDeductionsWithEmployer = totalDeductions + employerTotal;
    const netPayable = actualPayableGross;
    const perDaySalary = workingDays > 0 ? netPayable / workingDays : 0;
    const lopDeduction = perDaySalary * lopDays;
    const net = netPayable - lopDeduction;
    return { gross, totalDeductions, totalDeductionsWithEmployer, bonus, employerTotal, workingDays, presentDays, leaveDays, lopDays, paidDays, actualPayableGross, netPayable, perDaySalary, lopDeduction, attendanceValid, net };
}

// Download a remote image (HTTP/HTTPS) to a temp file path, returns the local path or null.
// Uses os.tmpdir() (writable on Vercel/serverless, unlike the package dir) and a
// unique file name so concurrent renders never overwrite each other's logo.
const LOGO_MAX_BYTES = 3 * 1024 * 1024; // sanity cap (3 MB) - the logo URL source is
                                        // admin-controlled (company settings), never client input.
function downloadLogoToTemp(url, depth = 0) {
    return new Promise((resolve) => {
        try {
            if (depth > 3) { resolve(null); return; }
            const client = url.startsWith('https') ? https : http;
            const tmpPath = path.join(os.tmpdir(), `_payslip_logo_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
            client.get(url, { timeout: 5000 }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    return downloadLogoToTemp(res.headers.location, depth + 1).then(resolve);
                }
                if (res.statusCode !== 200) { resolve(null); return; }
                const file = fs.createWriteStream(tmpPath);
                let size = 0;
                res.on('data', (chunk) => {
                    size += chunk.length;
                    if (size > LOGO_MAX_BYTES) { res.destroy(); file.destroy(); resolve(null); }
                });
                res.pipe(file);
                file.on('finish', () => { file.close(); resolve(tmpPath); });
                file.on('error', () => { resolve(null); });
            }).on('error', () => { resolve(null); });
        } catch (e) { resolve(null); }
    });
}

async function getProfileSalaryValues(employeeId, values) {
    const result = await query(
        `SELECT salary, basic_salary, hra, conveyance, special_allowance, other_allowance,
                pf, esi, professional_tax, income_tax, other_deduction,
                employer_pf, employer_esi, employer_contribution, personal_email,
                first_name, last_name, employee_id as emp_code,
                status as employee_status, status_reason, last_working_day
         FROM employees WHERE id = $1`,
        [employeeId]
    );
    if (result.rows.length === 0) return null;
    const profile = result.rows[0];
    // WYSIWYG: values explicitly sent in the request always win so the saved
    // payslip matches the preview the admin saw. The employee profile is only
    // used as a fallback for fields the request did not include (e.g. bulk
    // rows built from profiles). An explicit 0 is respected as a real zero.
    const provided = (v) => v !== undefined && v !== null && String(v).trim() !== '';
    const pick = (v, p) => (provided(v) ? num(v) : num(p));
    const merged = {
        basic_salary: pick(values.basic_salary, profile.basic_salary) || num(profile.salary),
        hra: pick(values.hra, profile.hra),
        conveyance: pick(values.conveyance, profile.conveyance),
        medical: 0,
        special_allowance: pick(values.special_allowance, profile.special_allowance),
        other_allowance: pick(values.other_allowance, profile.other_allowance),
        pf: pick(values.pf, profile.pf),
        esi: pick(values.esi, profile.esi),
        professional_tax: pick(values.professional_tax, profile.professional_tax),
        income_tax: pick(values.income_tax, profile.income_tax),
        loan_deduction: 0,
        advance_salary: 0,
        other_deduction: pick(values.other_deduction, profile.other_deduction),
        employer_pf: pick(values.employer_pf, profile.employer_pf),
        employer_esi: pick(values.employer_esi, profile.employer_esi),
        employer_contribution: pick(values.employer_contribution, profile.employer_contribution)
    };
    merged.monthly_gross = merged.basic_salary + merged.hra + merged.conveyance
        + merged.special_allowance + merged.other_allowance;
    // Employment-status warning (Hold/Abscond/Terminated): generation is NOT
    // blocked, but the UI shows an amber banner so payroll is done knowingly.
    const empStatus = profile.employee_status || 'active';
    let status_warning = null;
    if (empStatus === 'on_hold') status_warning = 'Employee is ON HOLD' + (profile.status_reason ? ' — ' + profile.status_reason : '') + (profile.last_working_day ? ' | LWD: ' + String(profile.last_working_day).substring(0, 10) : '') + '. Generate with caution.';
    else if (empStatus === 'absconded') status_warning = 'Employee is marked ABSCONDED' + (profile.status_reason ? ' — ' + profile.status_reason : '') + (profile.last_working_day ? ' | LWD: ' + String(profile.last_working_day).substring(0, 10) : '') + '. Generate with caution.';
    else if (empStatus === 'terminated') status_warning = 'Employee is TERMINATED' + (profile.status_reason ? ' — ' + profile.status_reason : '') + (profile.last_working_day ? ' | LWD: ' + String(profile.last_working_day).substring(0, 10) : '') + '. Generate with caution.';
    else if (empStatus === 'paused' || empStatus === 'inactive') status_warning = 'Employee is ' + empStatus.toUpperCase() + '. Generate with caution.';
    return { ...values, ...merged, personal_email: profile.personal_email || null,
        first_name: profile.first_name || '', last_name: profile.last_name || '',
        emp_code: profile.emp_code || '', employee_status: empStatus,
        status_reason: profile.status_reason || null,
        last_working_day: profile.last_working_day || null,
        status_warning };
}

// Auto-calculate payroll attendance numbers straight from the attendance,
// leave, WFH and holiday tables so admins no longer hand-count days.
// Per-day ledger: every working day resolves to exactly one bucket -
// paid (incl. approved WFH), approved leave, or LOP - so the
// working = present + leave + LOP identity always holds.
async function computeAttendanceSummary(employeeId, month, year) {
    const wcfg = await getWorkWeekConfig();
    const empRes = await query('SELECT joining_date, status as employee_status, status_reason, last_working_day FROM employees WHERE id = $1', [employeeId]);
    if (empRes.rows.length === 0) return null;
    const empStatus = empRes.rows[0];
    let status_warning = null;
    if (empStatus.employee_status === 'on_hold') status_warning = 'Employee is ON HOLD. Generate with caution.';
    else if (empStatus.employee_status === 'absconded') status_warning = 'Employee is marked ABSCONDED. Generate with caution.';
    else if (empStatus.employee_status === 'terminated') status_warning = 'Employee is TERMINATED. Generate with caution.';

    const pad = (n) => String(n).padStart(2, '0');
    const start = `${year}-${pad(month)}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const end = `${year}-${pad(month)}-${pad(lastDay)}`;
    const todayStr = istDateString();

    // Mid-month joiners only earn working days from their joining date.
    let effStart = start;
    const join = empRes.rows[0].joining_date ? formatDateOnly(empRes.rows[0].joining_date) : null;
    if (join && join > start && join <= end) effStart = join;

    // Never count days that have not happened yet - a mid-month preview must
    // not turn upcoming days into phantom LOP. Fully-future periods: zeros.
    if (effStart > todayStr) {
        return {
            working_days: 0, present_days: 0, leave_days: 0, lop_days: 0,
            total_days: 0, week_offs: 0, holidays: 0,
            breakdown: { present: 0, late: 0, half_day: 0, absent: 0, wfh: 0, holiday: 0 },
            period_start: effStart, period_end: end, future_period: true,
            employee_status: empStatus.employee_status || 'active', status_warning
        };
    }

    const [attRes, leaveRes, wfhRes, holRes, pendRes] = await Promise.all([
        query(`SELECT date, status FROM attendance
               WHERE employee_id = $1 AND date >= $2 AND date <= $3`, [employeeId, effStart, end]),
        query(`SELECT start_date, end_date FROM leave_applications
               WHERE employee_id = $1 AND status = 'approved'
                 AND end_date >= $2 AND start_date <= $3`, [employeeId, effStart, end]),
        query(`SELECT start_date, end_date FROM wfh_requests
               WHERE employee_id = $1 AND status = 'approved'
                 AND end_date >= $2 AND start_date <= $3`, [employeeId, effStart, end]),
        query(`SELECT date FROM holidays WHERE is_active = 1 AND date >= $1 AND date <= $2`, [effStart, end]),
        query(`SELECT start_date, end_date FROM leave_applications
               WHERE employee_id = $1 AND status = 'pending'
                 AND end_date >= $2 AND start_date <= $3`, [employeeId, effStart, end])
    ]);

    const fmtD = (v) => formatDateOnly(v);
    const statusByDate = {};
    attRes.rows.forEach(r => { statusByDate[fmtD(r.date)] = r.status; });
    const holidaySet = new Set(holRes.rows.map(r => fmtD(r.date)));

    // ---- Sandwich leave policy ----
    // An approved leave application that SPANS a week off / declared holiday
    // (non-working days strictly inside its date range) pays for them too:
    // those days become LEAVE days instead of free paid days.
    const sandwichDays = new Set();
    for (const l of leaveRes.rows) {
        const s = fmtD(l.start_date), e = fmtD(l.end_date);
        if (!s || !e || s >= e) continue;
        let c = new Date(s + 'T00:00:00Z');
        c.setUTCDate(c.getUTCDate() + 1);          // day after start
        const cEnd = new Date(e + 'T00:00:00Z');   // strictly before end
        while (c < cEnd) {
            const ds = istDateString(c);
            if (holidaySet.has(ds)) sandwichDays.add('H' + ds);
            else { const dow = new Date(ds + 'T00:00:00').getDay(); if (dow === wcfg.weekoffDay) sandwichDays.add(ds); }
            c.setUTCDate(c.getUTCDate() + 1);
        }
    }

    // Calendar split over the FULL month - working days are always quoted on
    // a full-month basis. Every day lands in exactly one calendar bucket:
    // holiday, week off, or working day.
    let totalDays = 0, weekOffs = 0, workingDays = 0, paidRaw = 0.0, leaveDays = 0;
    // First N late logins per payslip period are excused; beyond that each
    // late login costs half a day.
    const LATE_LOGIN_GRACE = 3;
    const tally = { present: 0, late: 0, half_day: 0, absent: 0, wfh: 0 };

    const cursor = new Date(effStart + 'T00:00:00Z');
    const endDate = new Date(end + 'T00:00:00Z');
    while (istDateString(cursor) <= istDateString(endDate)) {
        const ds = istDateString(cursor);
        const dow = new Date(ds + 'T00:00:00').getDay();
        cursor.setUTCDate(cursor.getUTCDate() + 1);

        totalDays++;
        const isHol = holidaySet.has(ds);
        const isWo = !isHol && (dow === wcfg.weekoffDay);
        const isSandwich = isHol ? sandwichDays.has('H' + ds) : (isWo && sandwichDays.has(ds));
        if (ds <= todayStr && isSandwich) {
            // Sandwich rule: this non-working day falls inside a leave span -
            // it is PAID LEAVE, not free.
            leaveDays++;
        }
        if (isHol) continue;
        if (isWo) { weekOffs++; continue; }

        workingDays++;

        // Day classification only runs up to today: upcoming days are neither
        // present nor LOP yet, so they stay unclassified.
        if (ds > todayStr) continue;

        const st = statusByDate[ds];
        if (st === 'present') { paidRaw++; tally.present++; }
        else if (st === 'wfh') { paidRaw++; tally.wfh++; }
        else if (st === 'late') {
            // Late-login policy: first 3 lates in the period are excused
            // (full day); every late from the 4th onward counts as half day.
            tally.late++;
            paidRaw += tally.late <= LATE_LOGIN_GRACE ? 1 : 0.5;
        }
        else if (st === 'half-day') { paidRaw += 0.5; tally.half_day++; }
        else if (leaveRes.rows.some(l => ds >= fmtD(l.start_date) && ds <= fmtD(l.end_date))) {
            // Approved leave day (with or without a back-filled row) is paid
            // leave - never LOP.
            leaveDays++;
        }
        else if (wfhRes.rows.some(w => ds >= fmtD(w.start_date) && ds <= fmtD(w.end_date))) {
            // Approved WFH with no check-in record is still a paid day.
            paidRaw++; tally.wfh++;
        }
        else tally.absent++;
    }

    // LOP counts only GENUINE absences (no check-in, no approved leave/WFH)
    // that have already happened. Upcoming days never inflate it.
    // Week off / holiday credit only applies up to the employee's LAST
    // ACTIVE day (attendance, approved WFH or approved leave). Someone who
    // never showed up - or walked out mid-month - earns no free week offs
    // for the rest of the period.
    let lastActive = null;
    for (const r of attRes.rows) {
        const d = fmtD(r.date);
        if (d >= effStart && d <= end && d <= todayStr && (!lastActive || d > lastActive)) lastActive = d;
    }
    const markActivityEnd = (s, e) => {
        const cs = fmtD(s), ceRaw = fmtD(e);
        if (!cs || !ceRaw) return;
        const ce = [ceRaw, end, todayStr].sort()[0];
        if (ce >= effStart && (!lastActive || ce > lastActive)) lastActive = ce;
    };
    wfhRes.rows.forEach(w => markActivityEnd(w.start_date, w.end_date));
    leaveRes.rows.forEach(l => markActivityEnd(l.start_date, l.end_date));

    let creditedWOs = 0, creditedHols = 0;
    if (lastActive) {
        let c = new Date(effStart + 'T00:00:00Z');
        const cEnd = new Date(lastActive + 'T00:00:00Z');
        while (istDateString(c) <= istDateString(cEnd)) {
            const ds = istDateString(c);
            if (holidaySet.has(ds)) creditedHols++;
            else { const dw = new Date(ds + 'T00:00:00').getDay(); if (dw === wcfg.weekoffDay) creditedWOs++; }
            c.setUTCDate(c.getUTCDate() + 1);
        }
    }
    // Present days follow the employee-view convention: check-ins (incl.
    // late logins & half days), approved WFH, plus week offs and holidays
    // up to the employee's last active day.
    const presentDays = Math.min(totalDays, Math.floor(paidRaw) + creditedWOs + creditedHols);

    // ---- Leave quota vs LOP ----
    // Every employee earns the configured number of paid leaves per month
    // (company_settings.monthly_leave_quota, default 1). Approved leaves up to
    // that quota stay "Leave Days" (no salary impact); anything beyond it,
    // plus every genuine absence, becomes LOP and alone drives the salary
    // cut. Identity: Total - Present = Leave(quota) + LOP.
    const MONTHLY_LEAVE_QUOTA = wcfg.monthlyLeaveQuota;
    const quotaCovered = Math.min(leaveDays, MONTHLY_LEAVE_QUOTA);
    // Identity-based LOP on the FULL elapsed calendar:
    //   Never showed up at all -> the WHOLE elapsed period is LOP (net pay
    //   zero, week offs and holidays included by design).
    //   Otherwise -> only unpaid WORK days are LOP: week offs and declared
    //   holidays are never deducted from an employee who worked at all.
    let lopDays;
    if (paidRaw === 0) {
        let elapsedAll = 0;
        {
            let c = new Date(effStart + 'T00:00:00Z');
            const cE = new Date([end, todayStr].sort()[0] + 'T00:00:00Z');
            while (istDateString(c) <= istDateString(cE)) { elapsedAll++; c.setUTCDate(c.getUTCDate() + 1); }
        }
        lopDays = Math.max(0, elapsedAll - quotaCovered);
    } else {
        let elapsedWorkDays = 0;
        {
            let c = new Date(effStart + 'T00:00:00Z');
            const cE = new Date([end, todayStr].sort()[0] + 'T00:00:00Z');
            while (istDateString(c) <= istDateString(cE)) {
                const ds2 = istDateString(c);
                const dw2 = new Date(ds2 + 'T00:00:00').getDay();
                if (!holidaySet.has(ds2) && dw2 !== wcfg.weekoffDay) elapsedWorkDays++;
                c.setUTCDate(c.getUTCDate() + 1);
            }
        }
        lopDays = Math.max(0, elapsedWorkDays - Math.floor(paidRaw) - quotaCovered);
    }

    return {
        // "Working days" now carries the FULL calendar month (Total Days) -
        // per-day salary divides by every day of the month, not just work days.
        working_days: totalDays,
        present_days: presentDays,
        // Payslip "Leave Days" shows only the quota-protected portion.
        leave_days: quotaCovered,
        lop_days: lopDays,
        total_days: totalDays,
        week_offs: weekOffs,
        holidays: holidaySet.size,
        // Extra context for the admin UI derivation note.
        leave_taken: leaveDays,
        monthly_leave_quota: MONTHLY_LEAVE_QUOTA,
        late_login_grace: LATE_LOGIN_GRACE,
        // Pending leaves are NOT protected - they currently count as LOP.
        pending_leave_days: (() => {
            let n = 0;
            const seen = new Set();
            for (const p of pendRes.rows) {
                let c = new Date(fmtD(p.start_date) + 'T00:00:00Z');
                const cE = new Date(fmtD(p.end_date) + 'T00:00:00Z');
                while (c <= cE) {
                    const ds = c.toISOString().substring(0, 10);
                    if (ds >= effStart && ds <= end && ds <= todayStr && !seen.has(ds)) {
                        const dw = c.getUTCDay();
                        if (dw !== wcfg.weekoffDay && !holidaySet.has(ds)) { n++; seen.add(ds); }
                    }
                    c.setUTCDate(c.getUTCDate() + 1);
                }
            }
            return n;
        })(),
        breakdown: {
            present: tally.present,
            late: tally.late,
            half_day: tally.half_day,
            absent: tally.absent,
            wfh: tally.wfh,
            holiday: holidaySet.size
        },
        period_start: effStart,
        period_end: end,
        employee_status: empStatus.employee_status || 'active',
        status_reason: empStatus.status_reason || null,
        last_working_day: empStatus.last_working_day || null,
        status_warning
    };
}

// Company branding + contact block used on the payslip.
async function getCompanyData() {
    const comp = await query('SELECT * FROM companies LIMIT 1');
    const settings = await query('SELECT setting_key, setting_value FROM company_settings');
    const map = {};
    settings.rows.forEach(s => { map[s.setting_key] = s.setting_value; });
    const c = comp.rows[0] || {};
    return {
        name: c.name || map.company_name || 'G Architects',
        logo: c.logo || null,
        address: c.address || '',
        phone: c.phone || '',
        email: c.email || map.hr_email || '',
        website: c.website || ''
    };
}

// Full auto-fetch payload: payroll row + employee profile + company details.
async function fetchPayslipWithProfile(id, userId, isPrivileged) {
    const result = await query(
        `SELECT p.*, e.first_name, e.last_name, e.employee_id as emp_id,
            e.personal_email as employee_email, e.joining_date, e.profile_photo,
            e.pan_number, e.uan_number, e.pf_number, e.esi_number,
            e.bank_name, e.bank_account, e.bank_ifsc,
            d.name as department_name, des.name as designation_name
        FROM payroll p
        JOIN employees e ON p.employee_id = e.id
        LEFT JOIN departments d ON e.department_id = d.id
        LEFT JOIN designations des ON e.designation_id = des.id
        WHERE p.id = $1${isPrivileged ? '' : ' AND p.employee_id = $2'}`,
        isPrivileged ? [id] : [id, userId]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    const company = await getCompanyData();
    return { ...row, company };
}

// Server-side A4 payslip render (used for email fallback + legacy /:id/pdf download).
// Layout matches the designer reference exactly: 794px container (A4 @96dpi), purple #7c6ca8 border,
// header with logo+divider+badge, section bars with left purple border,
// 4-col employee table, Earnings (A) / Deductions (B) side-by-side,
// summary cards (white bg, border), net salary in words (single line, italic),
// Attendance + Bonus (C) bottom row, Employer Contributions single column,
// footer with notes + signature. Single A4 page.
async function renderPayslipPdf(p, company) {
    // Resolve logo path before entering the synchronous PDF generation
    const logo = (company && company.logo) || '/assets/images/garchitects_logo.png';
    let resolvedLogoPath = null;
    try {
        if (/^https?:\/\//i.test(logo)) {
            resolvedLogoPath = await downloadLogoToTemp(logo);
        } else {
            // logo is always a web-relative path (e.g. /assets/images/garchitects_logo.png).
            // Try every plausible static root: package-relative (works when the
            // function is traced with its assets) and process.cwd()/public
            // (works on Vercel where the repo root is the working directory).
            const rel = logo.replace(/^\/+/, '');
            const candidates = [
                path.join(__dirname, '../../public', rel),
                path.join(process.cwd(), 'public', rel),
                path.join(__dirname, '../public', rel)
            ];
            resolvedLogoPath = candidates.find(p => fs.existsSync(p)) || null;
        }
    } catch (e) { /* logo is optional */ }

    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'A4', margin: 0 });
            const chunks = [];
            doc.on('data', c => chunks.push(c));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            // ---- Layout constants derived 1:1 from the preview CSS ----
            // Preview sheet: 794px wide, border-box, 1px purple border,
            // padding 22px top / 28px sides → content box x=29 y=23 w=736.
            const PW = doc.page.width;
            const S = PW / 794;
            const ML = 29 * S;
            const CW = 736 * S;
            const PAD_TOP = 23 * S;
            // Tables: font-size 11.5px, line-height 14px, cell
            // padding 5px 10px, collapsed 1px borders
            // → one row = 14 + 10 + 2 = 26px EXACT (same for every table).
            const ROW = 26 * S;
            // Section bar (.pp-sec): 14px line + 12px vert padding + 2 borders.
            const SEC_H = 28 * S;
            const F = (px) => px * S;
            const LH = 1.172; // PDFKit TTF normal line-height factor (Roboto)
            const plainINR = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

            if (fontsReady) {
                doc.registerFont('Roboto', path.join(FONT_DIR, 'Roboto-Regular.ttf'));
                doc.registerFont('Roboto-Bold', path.join(FONT_DIR, 'Roboto-Bold.ttf'));
            }

            const PURPLE = '#7c6ca8';
            const DARK = '#38286b';
            // ONE border system for the whole sheet: every table edge, internal
            // separator, card outline and the words bar share this exact color
            // and 1px weight. Visual hierarchy comes from the row backgrounds
            // (#e5e0f5 header / #efeafb totals), never from thicker lines.
            const BORDER = '#d8cfe8';
            const BAR = '#e5e0f5';
            const CARD = '#fbfbfd';
            const TOTAL = '#efeafb';
            const DED = '#d97706';
            const NET = '#2e7d32';
            const BODY = '#222222';
            const FL = FONT_REG;
            const FB = FONT_BOLD;

            // Vertical centering of one text line inside an h-tall row.
            const centerY = (y, h, fontPx) => y + (h - F(fontPx) * LH) / 2;

            // Section bar (.pp-sec): 4px purple accent + #e5e0f5 bar + 1px grid.
            // Text starts after accent(4) + padding-left(10) = 14px.
            const sectionBar = (title, x, y, w, opts) => {
                const h = SEC_H;
                const o = opts || {};
                doc.rect(x, y, 4 * S, h).fill(PURPLE);
                doc.rect(x + 4 * S, y, w - 4 * S, h).fill(BAR);
                doc.strokeColor(BORDER).lineWidth(1 * S);
                if (o.noBottom) {
                    // attendance variant: border-bottom:none
                    doc.moveTo(x, y + h).lineTo(x, y).lineTo(x + w, y).lineTo(x + w, y + h).stroke();
                } else {
                    doc.rect(x, y, w, h).stroke();
                }
                doc.fill(DARK).font(FB).fontSize(F(11.5)).text(title, x + 14 * S, centerY(y, h, 11.5));
                return y + h;
            };

            // Financial table mirroring .pp-fin CSS exactly: header row on
            // #e5e0f5 (bold dark), data rows (regular), total row on #efeafb
            // (bold dark); single thin 1px #d5cee6 grid on every edge.
            const finTable = (x, title, rows, totalLabel, total, baseY, tableW) => {
                const w = tableW || (CW - 12 * S) / 2; // flex gap 12px between pair
                const AMT_W = 95 * S;
                const vcol = x + w - AMT_W;
                const bw = 1 * S;
                let ty = baseY;
                const cellText = (txt, x0, w0, bold, color, align) => {
                    doc.fill(color).font(bold ? FB : FL).fontSize(F(11.5));
                    doc.text(txt, x0, centerY(ty, ROW, 11.5), { width: w0, align: align || 'left', lineBreak: false });
                };
                // Header row
                doc.rect(x, ty, w, ROW).fill(BAR);
                cellText(title, x + 10 * S, vcol - x - 20 * S, true, DARK);
                cellText('AMOUNT (\u20B9)', vcol + 10 * S, AMT_W - 20 * S, true, DARK, 'right');
                ty += ROW;
                // Data rows (amounts regular weight, like the preview td)
                rows.forEach(([k, v]) => {
                    cellText(k, x + 10 * S, vcol - x - 20 * S, false, BODY);
                    cellText(plainINR(v), vcol + 10 * S, AMT_W - 20 * S, false, BODY, 'right');
                    ty += ROW;
                });
                // Total row
                doc.rect(x, ty, w, ROW).fill(TOTAL);
                cellText(totalLabel, x + 10 * S, vcol - x - 20 * S, true, DARK);
                cellText(plainINR(total), vcol + 10 * S, AMT_W - 20 * S, true, DARK, 'right');
                ty += ROW;
                // Grid: outer border + every internal separator + amount divider
                doc.strokeColor(BORDER).lineWidth(bw);
                doc.rect(x, baseY, w, ty - baseY).stroke();
                for (let i = 1; i < rows.length + 2; i++) {
                    doc.moveTo(x, baseY + i * ROW).lineTo(x + w, baseY + i * ROW).stroke();
                }
                doc.moveTo(vcol, baseY).lineTo(vcol, ty).stroke();
                return ty;
            };

            // ---- Container border (1px purple, inset so the stroke stays
            //      fully inside the page like the CSS border-box) ----
            doc.strokeColor(PURPLE).lineWidth(1 * S)
                .rect(0.5 * S, 0.5 * S, PW - 1 * S, doc.page.height - 1 * S).stroke();

            let y = PAD_TOP;

            // ---- Header: logo | divider | company info + PAYSLIP badge ----
            // Flex row: logo (130×72 contain cap) --gap15--> divider
            // (margin 0 5px, 1px wide, 95px tall) --gap15--> text column;
            // badge 150px on the right. The divider sits immediately after the
            // ACTUAL rendered logo box (not the cap), same as the preview.
            const badgeW = 150 * S;
            const badgeX = ML + CW - badgeW;
            // Mirror the browser preview contain-box exactly (max-width 130px,
            // max-height 72px, aspect preserved) so PDF and preview match.
            const LOGO_CAP_W = 130 * S;
            const LOGO_CAP_H = 72 * S;
            const GROUP_H = 95 * S; // divider height drives the group height

            // Logo vertically centered in the group (align-items:center), at
            // its real aspect ratio, scaled to fit inside the 130×72 box.
            let logoBoxW = 0;
            if (resolvedLogoPath) {
                try {
                    const img = doc.openImage(resolvedLogoPath);
                    const scale = Math.min(LOGO_CAP_W / img.width, LOGO_CAP_H / img.height);
                    if (scale > 0) {
                        const lw = img.width * scale;
                        const lh = img.height * scale;
                        logoBoxW = lw;
                        doc.image(img, ML, y + (GROUP_H - lh) / 2, { width: lw, height: lh });
                    }
                } catch (e) { /* logo is optional */ }
            }

            const divX = ML + logoBoxW + 15 * S + 5 * S; // gap 15 + margin-left 5
            doc.rect(divX, y, 1 * S, GROUP_H).fill(PURPLE);

            const infoX = divX + 1 * S + 5 * S + 15 * S; // line + margin-right 5 + gap 15
            const infoW = badgeX - infoX;
            // Company block comes from the DB (companies/company_settings) with
            // the garchitects defaults only as a fallback, so settings edits reflect
            // on payslips without code changes.
            const coName = (company && company.name) || 'G Architects';
            const coAddress = String((company && company.address) || 'Plot no. 84, Flat no. 302, Sri Nikethan, near Balaji Temple,\nSiddhi Vinayak Nagar, Balaji Hills, Khanammet, Hyderabad, 500081, Telangana, India');
            const addressSegs = coAddress.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
            const contactLines = [];
            // Contact lines are mandatory on the payslip - same garchitects
            // fallbacks as the browser preview (buildPayslipHTML).
            contactLines.push('E-Mail: ' + ((company && company.email) || 'garchitects99@gmail.com'));
            contactLines.push('Ph No: ' + ((company && company.phone) || '+91 63740 48059'));

            // Estimate the text-column height first so the whole column can be
            // vertically centered in the 95px group (flex align-items:center).
            const smallLH = F(10.5) * 1.2;   // address/email/phone divs: line-height:1.2
            const nameH = F(19) * LH;
            let estLines = 0;
            addressSegs.forEach(seg => {
                estLines += Math.max(1, Math.ceil(doc.widthOfString(seg) / (infoW - 2 * S)));
            });
            const textColH = nameH + 5 * S + estLines * smallLH + 3 * S
                + contactLines.length * (smallLH + 3 * S);
            const colTop = y + (GROUP_H - Math.min(textColH, GROUP_H)) / 2;

            doc.fill('#111111').font(FB).fontSize(F(19));
            doc.text(coName.toUpperCase(), infoX, colTop, { width: infoW, lineBreak: false, letterSpacing: 0.2 * S });
            let iy = colTop + nameH + 5 * S;
            doc.font(FL).fontSize(F(10.5)).fill('#222222');
            addressSegs.forEach(seg => {
                doc.text(seg, infoX, iy, { width: infoW });
                iy = doc.y + 3 * S;
            });
            contactLines.forEach(l => {
                doc.text(l, infoX, iy, { width: infoW });
                iy += smallLH + 3 * S;
            });

            // PAYSLIP badge: 150px, radius 6, 1px PURPLE border, overflow hidden
            // → top half purple with rounded TOP corners, bottom half white.
            const bPad1 = 7 * S, bPad2 = 8 * S;
            const bh1 = F(15) * LH + bPad1 * 2;   // PAYSLIP row
            const bh2 = F(13.5) * LH + bPad2 * 2; // period row
            const bH = bh1 + bh2 + 2 * S;         // + top/bottom borders
            const r6 = 6 * S;
            doc.save();
            doc.roundedRect(badgeX, y, badgeW, bH, r6).clip();
            doc.rect(badgeX, y, badgeW, bh1 + 1 * S).fill(PURPLE);
            doc.rect(badgeX, y + bh1 + 1 * S, badgeW, bh2).fill('#FFFFFF');
            doc.restore();
            doc.strokeColor(PURPLE).lineWidth(1 * S).roundedRect(badgeX, y, badgeW, bH, r6).stroke();
            doc.fill('#FFFFFF').font(FB).fontSize(F(15)).text('PAYSLIP', badgeX, centerY(y, bh1, 15), { width: badgeW, align: 'center', letterSpacing: 1 * S, lineBreak: false });
            doc.fill('#111111').font(FB).fontSize(F(13.5)).text(`${PP_MONTHS[p.month] || ''} ${p.year}`, badgeX, centerY(y + bh1 + 1 * S, bh2, 13.5), { width: badgeW, align: 'center', lineBreak: false });

            // Header bottom: padding-bottom 16 + 2px purple border, margin 16.
            const hdrContentH = Math.max(GROUP_H, Math.min(textColH, GROUP_H), bH);
            y += hdrContentH + 16 * S;
            doc.strokeColor(PURPLE).lineWidth(2 * S).moveTo(ML, y + 1 * S).lineTo(ML + CW, y + 1 * S).stroke();
            y += 2 * S + 16 * S;

            // ---- Employee details (4 equal columns) ----
            // Zero vertical gap: the table starts immediately below the bar.
            // The bar's bottom border and the table's top border coincide into
            // one single 1px line (border-collapse behaviour) - no spacing.
            y = sectionBar('EMPLOYEE DETAILS', ML, y, CW);
            const colW = CW / 4;
            const empCells = [
                ['Employee ID', p.emp_id || '-'],
                ['Pay Period', `${PP_MONTHS[p.month] || ''} ${p.year}`],
                ['Employee Name', `${p.first_name || ''} ${p.last_name || ''}`.trim() || '-'],
                ['Total Days', p.working_days || 0],
                ['Designation', p.designation_name || '-'],
                ['Present Days', p.present_days || 0],
                ['Department', p.department_name || '-'],
                ['Leave Days', p.leave_days || 0],
                ['Date of Joining', formatDateOnly(p.joining_date)],
                ['LOP Days', p.lop_days || 0],
                ['PAN Number', p.pan_number || '-'],
                ['Bank Account No.', p.bank_account || '-'],
                ['UAN Number', p.uan_number || '-'],
                ['Bank Name', p.bank_name || '-']
            ];
            const t0 = y;
            const ecol = (ci) => ML + ci * colW;
            // Border fix: draw in three passes like finTable - backgrounds,
            // then text, THEN the grid. Previously each row's borders were
            // stroked before the NEXT row's background fill was painted, which
            // covered the lower half of every internal line and made the
            // cell borders look faint or missing.
            // Pass 1: alternating column backgrounds.
            for (let r = 0; r < 7; r++) {
                for (let c = 0; c < 4; c++) {
                    const colBg = c % 2 === 0 ? '#fbf9fc' : '#FFFFFF';
                    doc.fill(colBg).rect(ecol(c), t0 + r * ROW, colW, ROW).fill();
                }
            }
            // Pass 2: cell text.
            for (let r = 0; r < 7; r++) {
                for (let c = 0; c < 4; c++) {
                    const pair = empCells[r * 2 + Math.floor(c / 2)];
                    const isVal = c % 2 === 1;
                    // label cells: #333 regular · value cells: #111 semibold
                    doc.fill(isVal ? '#111111' : '#333333').font(isVal ? FB : FL).fontSize(F(11.5));
                    doc.text(String(pair[isVal ? 1 : 0]), ecol(c) + 10 * S, centerY(t0 + r * ROW, ROW, 11.5), { width: colW - 20 * S, lineBreak: false });
                }
            }
            // Pass 3: full grid on top of every fill - internal verticals span
            // the whole table height once, internal horizontals between rows,
            // and the outer rect closes all four edges. Every line is drawn
            // exactly once at the shared BORDER color and 1px weight.
            doc.strokeColor(BORDER).lineWidth(1 * S);
            for (let c = 1; c < 4; c++) {
                doc.moveTo(ecol(c), t0).lineTo(ecol(c), t0 + 7 * ROW);
            }
            for (let r = 1; r < 7; r++) {
                doc.moveTo(ML, t0 + r * ROW).lineTo(ML + CW, t0 + r * ROW);
            }
            doc.stroke();
            doc.rect(ML, t0, CW, 7 * ROW).stroke();
            y = t0 + 7 * ROW + 12 * S;

            // ---- Earnings (A) / Deductions (B) tables ----
            const totals = computeTotals(p);
            const earningsRows = [
                ['Basic Salary', num(p.basic_salary)],
                ['HRA', num(p.hra)],
                ['Conveyance Allowance', num(p.conveyance)],
                ['Medical Allowance', num(p.other_allowance)],
                ['Special Allowance', num(p.special_allowance)]
            ];
            const deductionRows = [
                ['PF Contribution', num(p.pf)],
                ['ESI Contribution', num(p.esi)],
                ['Professional Tax', num(p.professional_tax)],
                ['Income Tax', num(p.income_tax)],
                ['Other Deductions', num(p.other_deduction)]
            ];
            const halfW = (CW - 12 * S) / 2;
            const eyE = finTable(ML, 'EARNINGS', earningsRows, 'TOTAL EARNINGS (A)', totals.gross, y);
            const eyD = finTable(ML + halfW + 12 * S, 'DEDUCTIONS', deductionRows, 'TOTAL DEDUCTIONS (B)', totals.totalDeductions, y);
            y = Math.max(eyE, eyD) + 6 * S;

            // ---- Summary cards: Gross (A) / Deductions (B) / Net Payable (A+C-B-D) ----
            const cardW = (CW - 20 * S) / 3;
            const cards = [
                { label: 'GROSS SALARY (A)', value: totals.gross, color: DARK },
                { label: 'TOTAL DEDUCTIONS', value: totals.totalDeductionsWithEmployer, color: DED },
                { label: 'NET SALARY PAYABLE', value: totals.net, color: NET }
            ];
            let cx = ML;
            cards.forEach(card => {
                const ch = 65 * S;
                doc.roundedRect(cx, y, cardW, ch, 5 * S).fill(CARD);
                doc.strokeColor(BORDER).lineWidth(1 * S).roundedRect(cx, y, cardW, ch, 5 * S).stroke();
                // CSS: padding 8px 5px + flex-column justify-content:center
                const cPadV = 8 * S;
                const labelH = F(13.5) * LH;
                const valueH = F(19) * LH;
                const blockH = labelH + 5 * S + valueH;
                const labelY = y + cPadV + ((ch - 2 * cPadV) - blockH) / 2;
                doc.fill('#444444').font(FB).fontSize(F(13.5)).text(card.label, cx + 5 * S, labelY, { width: cardW - 10 * S, align: 'center', lineBreak: false });
                doc.fill(card.color).font(FB).fontSize(F(19)).text('\u20B9 ' + plainINR(card.value), cx + 5 * S, labelY + labelH + 5 * S, { width: cardW - 10 * S, align: 'center', lineBreak: false });
                cx += cardW + 10 * S;
            });
            y += 65 * S + 6 * S;

            // ---- Net salary in words ----
            // CSS: padding 7px 12px + 14px line + 1px borders = 30px tall.
            const wH = 14 * S + 14 * S + 2 * S;
            doc.rect(ML, y, CW, wH).fill(CARD);
            doc.strokeColor(BORDER).lineWidth(1 * S).rect(ML, y, CW, wH).stroke();
            const wordsLabel = 'NET SALARY IN WORDS:';
            doc.fill(DARK).font(FB).fontSize(F(11.5));
            doc.text(wordsLabel, ML + 12 * S, centerY(y, wH, 11.5), { lineBreak: false });
            const labelW = doc.widthOfString(wordsLabel);
            // Italic words: Roboto with a 12° oblique skew → same font metrics
            // as the label so both sit on one identical baseline. The skew is
            // applied around the text origin (translate first, then transform).
            const itX = ML + 12 * S + labelW + 12 * S; // flex gap 12px
            const itY = centerY(y, wH, 11.5);
            doc.save();
            doc.translate(itX, itY);
            doc.transform(1, 0, Math.tan(-12 * Math.PI / 180), 1, 0, 0);
            doc.fill(BODY).font(FL).fontSize(F(11.5)).text(amountToWords(totals.net), 0, 0, { lineBreak: false });
            doc.restore();
            y += wH + 12 * S;

            // ---- Attendance summary (4-col) + Bonus (C) side by side ----
            const attX = ML;
            // Mirrors preview: attendance column is a fixed 340px (4 integer
            // 85px columns), bonus takes the remaining 376px, gap 20px.
            const attW = 340 * S;
            const rowGap = 20 * S;
            const bnsX = ML + attW + rowGap;
            const bnsW = CW - attW - rowGap;
            // CSS fixes these heights: .pp-sec bar, th height 30px,
            // .pp-att-values td height 28px (normal table model).
            const attBarY = y;
            const attHeadH = 30 * S;
            const attValueH = 28 * S;
            sectionBar('ATTENDANCE SUMMARY', attX, attBarY, attW, { noBottom: true });

            const attColW = attW / 4;
            const attHeads = ['Total Days', 'Present Days', 'Leave Days', 'LOP Days'];
            const attVals = [p.working_days || 0, p.present_days || 0, p.leave_days || 0, p.lop_days || 0];
            let ay = attBarY + SEC_H;
            // Header row (30px, #e5e0f5, bold dark, centered)
            doc.rect(attX, ay, attW, attHeadH).fill(BAR);
            attHeads.forEach((h, c) => {
                doc.fill(DARK).font(FB).fontSize(F(11.5)).text(h, attX + c * attColW, centerY(ay, attHeadH, 11.5), { width: attColW, align: 'center', lineBreak: false });
            });
            ay += attHeadH;
            // Value row (28px, white, bold, centered)
            doc.fill('#FFFFFF').rect(attX, ay, attW, attValueH).fill();
            attVals.forEach((v, c) => {
                doc.fill(BODY).font(FB).fontSize(F(11.5)).text(String(v), attX + c * attColW, centerY(ay, attValueH, 11.5), { width: attColW, align: 'center', lineBreak: false });
            });
            ay += attValueH;
            // Grid: every edge explicit - outer TOP (table's own top border,
            // since the bar above is noBottom), internal verticals spanning
            // header+value rows, separator between the two rows, outer
            // left/right/bottom. All drawn AFTER the fills at 1px BORDER.
            doc.strokeColor(BORDER).lineWidth(1 * S);
            doc.moveTo(attX, attBarY + SEC_H).lineTo(attX + attW, attBarY + SEC_H).stroke();
            for (let c = 1; c < 4; c++) {
                doc.moveTo(attX + c * attColW, attBarY + SEC_H).lineTo(attX + c * attColW, ay).stroke();
            }
            doc.moveTo(attX, attBarY + SEC_H + attHeadH).lineTo(attX + attW, attBarY + SEC_H + attHeadH).stroke();
            doc.moveTo(attX, ay).lineTo(attX + attW, ay).stroke();
            doc.moveTo(attX, attBarY + SEC_H).lineTo(attX, ay).stroke();
            doc.moveTo(attX + attW, attBarY + SEC_H).lineTo(attX + attW, ay).stroke();

            const bonusRows = [
                ['Incentive', num(p.incentive)],
                ['Attendance Incentive', num(p.bonus)],
                ['Extra Work', num(p.extra_work)]
            ];
            const by = finTable(bnsX, 'BONUS (C)', bonusRows, 'TOTAL BONUS (C)', totals.bonus, attBarY, bnsW);
            // Preview band has margin-bottom:12px before EMPLOYER CONTRIBUTIONS.
            y = Math.max(ay, by) + 12 * S;

            // ---- Employer Contributions (single column, full width finTable) ----
            const empTotal = totals.employerTotal;
            const eRows = [
                ['Employer PF Contribution', num(p.employer_pf)],
                ['Employer ESI Contribution', num(p.employer_esi)],
                ['Employer Other Contribution', num(p.employer_contribution)]
            ];
            y = finTable(ML, 'EMPLOYER CONTRIBUTIONS', eRows, 'TOTAL EMPLOYER CONTRIBUTION (D)', empTotal, y, CW) + 2 * S;

            // ---- Footer: notes + signature ----
            // The footer is anchored to the BOTTOM of the page (mirroring the
            // sheet's 22px padding) so the notes and the signature block sit in
            // a fixed, balanced position instead of floating mid-page with a
            // large blank area underneath. It never rises above the content.
            const pageBottom = doc.page.height - PAD_TOP;
            const fLineH = F(10.5) * 1.4;
            const leftBlockH = fLineH * 4;                 // Note: + 3 bullets
            const sepY = Math.max(y + 8 * S, pageBottom - 6 * S - leftBlockH);
            doc.strokeColor(BORDER).lineWidth(1 * S).moveTo(ML, sepY).lineTo(ML + CW, sepY).stroke();
            const fTop = sepY + 6 * S;

            // Left: Note + bullet list (ul padding-left 15px, disc markers)
            doc.fill('#555555').font(FB).fontSize(F(10.5)).text('Note:', ML, fTop);
            let bY = fTop + fLineH;
            doc.font(FL);
            ['This is a computer generated payslip.',
                'No signature is required.',
                'Please contact HR for any discrepancies.'].forEach(t => {
                doc.fill('#555555').text('\u2022', ML + 15 * S, bY, { lineBreak: false });
                doc.text(t, ML + 27 * S, bY, { lineBreak: false });
                bY += fLineH;
            });

            // Right: company authorization, bottom-aligned with the left block.
            // Measure the disclaimer so a wrap to 2 lines keeps alignment.
            const sigW = CW * 0.48;
            const sigX = ML + CW - sigW;
            doc.font(FL).fontSize(F(10.5));
            const disclaimer = 'This is a system generated document and does not require signature.';
            const disLines = Math.max(1, Math.ceil(doc.widthOfString(disclaimer) / sigW));
            const rightBlockH = F(10.5) * LH + 8 * S + disLines * F(10.5) * LH;
            const rightY = fTop + leftBlockH - rightBlockH;
            doc.fill(DARK).font(FB).fontSize(F(10.5)).text('For ' + coName.toUpperCase(), sigX, rightY, { width: sigW, align: 'right', lineBreak: false });
            doc.fill('#555555').font(FL).text(disclaimer, sigX, rightY + F(10.5) * LH + 8 * S, { width: sigW, align: 'right' });

            doc.end();
        } catch (err) {
            console.error('Render payslip PDF error:', err);
            reject(err);
        }
    });
}

// Convert an incoming base64 PDF payload into a Buffer (handles data URIs).
function pdfFromBase64(pdfBase64) {
    if (!pdfBase64) return null;
    const cleaned = String(pdfBase64).replace(/^data:application\/pdf;base64,/, '');
    return Buffer.from(cleaned, 'base64');
}

// Simple in-memory rate limiter for the CPU-heavy PDF render endpoints
// (30 renders/minute per user). Prevents a single session from hogging the
// serverless function with concurrent renders.
const pdfRateBuckets = new Map();
function pdfRateLimit(req, res, next) {
    const key = (req.user && req.user.id) || req.ip || 'anon';
    const now = Date.now();
    let bucket = pdfRateBuckets.get(key);
    if (!bucket || now - bucket.start > 60000) {
        bucket = { start: now, count: 0 };
        pdfRateBuckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > 30) {
        return res.status(429).json({ success: false, message: 'Too many PDF requests. Please wait a moment and try again.' });
    }
    next();
}

// @route   GET /api/payroll/my
// @desc    Current employee's payslips
// @access  Private
router.get('/my', verifyToken, async (req, res) => {
    try {
        const { month, year } = req.query;
        let sqlQuery = `
            SELECT p.*, e.first_name, e.last_name, e.employee_id as emp_id
            FROM payroll p
            JOIN employees e ON p.employee_id = e.id
            WHERE p.employee_id = $1
        `;
        const params = [req.user.id];
        let paramIndex = 2;

        if (month) { sqlQuery += ` AND p.month = $${paramIndex}`; params.push(month); paramIndex++; }
        if (year) { sqlQuery += ` AND p.year = $${paramIndex}`; params.push(year); paramIndex++; }

        sqlQuery += ' ORDER BY p.year DESC, p.month DESC';
        const result = await query(sqlQuery, params);
        res.json({ success: true, payslips: result.rows });
    } catch (error) {
        console.error('Get my payroll error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/payroll/all
// @desc    All payroll records (admin), filterable by month/year/status/search
// @access  Admin
router.get('/all', verifyToken, isAdmin, async (req, res) => {
    try {
        const { month, year, status, search, limit } = req.query;
        let sqlQuery = `
            SELECT p.*, e.first_name, e.last_name, e.employee_id as emp_id,
                e.status as employee_status, e.status_reason, e.last_working_day
            FROM payroll p
            JOIN employees e ON p.employee_id = e.id
            WHERE 1=1
        `;
        const params = [];
        let paramIndex = 1;

        if (month) { sqlQuery += ` AND p.month = $${paramIndex}`; params.push(month); paramIndex++; }
        if (year) { sqlQuery += ` AND p.year = $${paramIndex}`; params.push(year); paramIndex++; }
        if (status) { sqlQuery += ` AND p.status = $${paramIndex}`; params.push(status); paramIndex++; }
        if (search) {
            sqlQuery += ` AND (LOWER(e.first_name) LIKE LOWER($${paramIndex}) OR LOWER(e.last_name) LIKE LOWER($${paramIndex}) OR LOWER(e.employee_id) LIKE LOWER($${paramIndex}))`;
            params.push(`%${search}%`);
            paramIndex++;
        }

        sqlQuery += ' ORDER BY p.year DESC, p.month DESC, e.first_name';
        if (limit) {
            sqlQuery += ` LIMIT $${paramIndex}`;
            params.push(parseInt(limit));
        }
        const result = await query(sqlQuery, params);
        res.json({ success: true, payroll: result.rows });
    } catch (error) {
        console.error('Get all payroll error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/payroll/attendance-summary?employee_id=&month=&year=
// @desc    Auto-computed attendance numbers for a payslip period
// @access  Admin
router.get('/attendance-summary', verifyToken, isAdmin, async (req, res) => {
    try {
        const employee_id = parseInt(req.query.employee_id, 10);
        const month = parseInt(req.query.month, 10);
        const year = parseInt(req.query.year, 10);
        if (!employee_id || !month || !year || month < 1 || month > 12) {
            return res.status(400).json({ success: false, message: 'employee_id, month and year are required' });
        }
        const summary = await computeAttendanceSummary(employee_id, month, year);
        if (!summary) return res.status(404).json({ success: false, message: 'Employee not found' });
        res.json({ success: true, summary });
    } catch (error) {
        console.error('Attendance summary error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   POST /api/payroll/render-pdf
// @desc    Render a PDF from payslip payload data (for unsaved / live preview downloads)
// @access  Private
router.post('/render-pdf', verifyToken, isManager, pdfRateLimit, async (req, res) => {
    try {
        const p = req.body;
        if (!p) return res.status(400).json({ success: false, message: 'No payslip data' });
        // Company details always come from the DB (admin-managed settings).
        // Ignoring any client-supplied company object also kills the SSRF /
        // unbounded-logo-download vector (a crafted company.logo_url could have
        // pointed the server at an internal address).
        const company = await getCompanyData();
        const buf = await renderPayslipPdf(p, company);
        const empId = p.emp_id || p.employee_id || 'emp';
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=payslip_${empId}_${p.month || ''}_${p.year || ''}.pdf`);
        res.send(buf);
    } catch (error) {
        console.error('Render PDF error:', error);
        res.status(500).json({ success: false, message: 'PDF generation failed' });
    }
});

// @route   GET /api/payroll/export
// @desc    Branded Excel salary register for a month (earnings, deductions,
//          employer contributions and net pay per employee).
// @access  Private (Admin)
// NOTE: registered before GET /:id so "export" is never captured as an id.
router.get('/export', verifyToken, isAdmin, async (req, res) => {
    try {
        const month = parseInt(req.query.month) || new Date().getMonth() + 1;
        const year = parseInt(req.query.year) || new Date().getFullYear();

        const result = await query(
            `SELECT p.*, e.first_name || ' ' || e.last_name AS employee_name,
                e.employee_id AS emp_code, d.name AS department_name
            FROM payroll p
            JOIN employees e ON e.id = p.employee_id
            LEFT JOIN departments d ON d.id = e.department_id
            WHERE p.month = $1 AND p.year = $2
            ORDER BY e.employee_id ASC`,
            [month, year]
        );

        const rows = result.rows.map(p => ({
            emp_code: p.emp_code,
            name: p.employee_name,
            department: p.department_name,
            working_days: Number(p.working_days) || 0,
            present_days: Number(p.present_days) || 0,
            leave_days: Number(p.leave_days) || 0,
            lop_days: Number(p.lop_days) || 0,
            basic_salary: p.basic_salary,
            hra: p.hra,
            conveyance: p.conveyance,
            medical: p.medical,
            special_allowance: p.special_allowance,
            bonus: p.bonus,
            incentive: p.incentive,
            extra_work: p.extra_work,
            other_allowance: p.other_allowance,
            gross_salary: p.gross_salary,
            pf: p.pf,
            esi: p.esi,
            professional_tax: p.professional_tax,
            income_tax: p.income_tax,
            loan_deduction: p.loan_deduction,
            advance_salary: p.advance_salary,
            other_deduction: p.other_deduction,
            total_deductions: p.total_deductions,
            employer_pf: p.employer_pf,
            employer_esi: p.employer_esi,
            employer_contribution: p.employer_contribution,
            net_salary: p.net_salary,
            status: p.status,
            payment_date: p.payment_date
        }));

        const M = (header, key, opts = {}) => ({ header, key, type: 'money', ...opts });
        const columns = [
            { header: 'Emp ID', key: 'emp_code', width: 12 },
            { header: 'Employee Name', key: 'name', width: 22 },
            { header: 'Department', key: 'department' },
            { header: 'Working Days', key: 'working_days', type: 'number' },
            { header: 'Present Days', key: 'present_days', type: 'number' },
            { header: 'Leave Days', key: 'leave_days', type: 'number' },
            { header: 'LOP Days', key: 'lop_days', type: 'number' },
            M('Basic Salary', 'basic_salary'),
            M('HRA', 'hra'),
            M('Conveyance', 'conveyance'),
            M('Medical Allowance', 'medical'),
            M('Special Allowance', 'special_allowance'),
            M('Bonus', 'bonus'),
            M('Incentive', 'incentive'),
            M('Extra Work', 'extra_work'),
            M('Other Allowance', 'other_allowance'),
            M('Gross Salary', 'gross_salary'),
            M('Employee PF', 'pf'),
            M('Employee ESI', 'esi'),
            M('Professional Tax', 'professional_tax'),
            M('Income Tax', 'income_tax'),
            M('Loan Deduction', 'loan_deduction'),
            M('Advance Salary', 'advance_salary'),
            M('Other Deduction', 'other_deduction'),
            M('Total Deductions', 'total_deductions'),
            M('Employer PF', 'employer_pf'),
            M('Employer ESI', 'employer_esi'),
            M('Employer Contribution', 'employer_contribution'),
            M('NET SALARY', 'net_salary'),
            { header: 'Status', key: 'status', type: 'status' },
            { header: 'Payment Date', key: 'payment_date', type: 'date', width: 13 }
        ];
        // Totals on every money column - instant month cost roll-up.
        columns.filter(c => c.type === 'money').forEach(c => { c.total = true; });

        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        const wb = await buildReportWorkbook({
            reportName: 'Salary Register',
            subtitleExtra: monthNames[month - 1] + ' ' + year + ' • Confidential',
            columns,
            rows,
            footerNote: req.user.name || 'Admin'
        });

        logAudit({
            actorId: req.user.id,
            action: 'data.export',
            entityType: 'report',
            entityId: null,
            details: { report: 'salary_register', month, year, records: rows.length },
            ip: req.ip
        });

        await sendWorkbook(res, wb, `Salary_Register_${monthNames[month - 1]}_${year}.xlsx`);
    } catch (error) {
        console.error('Payroll export error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/payroll/:id
// @desc    Full payslip payload (components + employee profile + company) for preview/PDF/print/email
// @access  Private (owner or admin)
router.get('/:id', verifyToken, async (req, res) => {
    try {
        const isPrivileged = req.user.role === 'admin';
        const row = await fetchPayslipWithProfile(req.params.id, req.user.id, isPrivileged);
        if (!row) return res.status(404).json({ success: false, message: 'Not found' });
        res.json({ success: true, payslip: row });
    } catch (error) {
        console.error('Get payroll error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/payroll/:id/pdf
// @desc    Server-rendered PDF download (fallback / backward compatible)
// @access  Private (owner or admin)
router.get('/:id/pdf', verifyToken, pdfRateLimit, async (req, res) => {
    try {
        const isPrivileged = req.user.role === 'admin';
        const row = await fetchPayslipWithProfile(req.params.id, req.user.id, isPrivileged);
        if (!row) return res.status(404).json({ success: false, message: 'Payslip not found' });
        const buf = await renderPayslipPdf(row, row.company);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=payslip_${row.emp_id}_${row.month}_${row.year}.pdf`);
        res.send(buf);
    } catch (error) {
        console.error('Generate payslip PDF error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   POST /api/payroll/generate
// @desc    Create/update a payslip (processed) and auto-email the employee with the PDF
// @access  Admin
router.post('/generate', verifyToken, isAdmin, async (req, res) => {
    try {
        const v = req.body;
        const employee_id = v.employee_id;
        const month = parseInt(v.month, 10);
        const year = parseInt(v.year, 10);

        if (!employee_id || !month || !year) {
            return res.status(400).json({ success: false, message: 'Employee, month and year are required' });
        }

        const payrollValues = await getProfileSalaryValues(employee_id, v);
        if (!payrollValues) {
            return res.status(404).json({ success: false, message: 'Employee profile not found' });
        }
        // Always compute attendance server-side so the late-login grace,
        // sandwich policy, monthly leave quota and LOP rules are applied
        // consistently. Day values sent by the form are intentionally ignored.
        const attVals = await computeAttendanceSummary(employee_id, month, year);
        if (!attVals) {
            return res.status(404).json({ success: false, message: 'Employee attendance could not be computed. Check joining date and try again.' });
        }
        const finalValues = { ...payrollValues, ...attVals };
        const totals = computeTotals(finalValues);
        if (!totals.attendanceValid) {
            return res.status(400).json({ success: false, message: 'Attendance calculation is incorrect.' });
        }
        const gross = totals.gross;
        const totalDeductions = totals.totalDeductions;
        const net = totals.net;
        // Keep legacy columns in sync for older report code.
        const allowances = gross - num(payrollValues.basic_salary);
        const deductions = totalDeductions;

        const result = await query(
            `INSERT INTO payroll (
                employee_id, month, year, working_days, present_days, leave_days, lop_days,
                basic_salary, hra, conveyance, medical, special_allowance, bonus, incentive, other_allowance, extra_work,
                pf, esi, professional_tax, income_tax, loan_deduction, advance_salary, other_deduction,
                employer_pf, employer_esi, employer_contribution,
                gross_salary, total_deductions, allowances, deductions, net_salary, status
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7,
                $8, $9, $10, $11, $12, $13, $14, $15, $16,
                $17, $18, $19, $20, $21, $22, $23,
                $24, $25, $26,
                $27, $28, $29, $30, $31, 'processed'
            )
            ON CONFLICT (employee_id, month, year) DO UPDATE SET
                working_days = $4, present_days = $5, leave_days = $6, lop_days = $7,
                basic_salary = $8, hra = $9, conveyance = $10, medical = $11, special_allowance = $12,
                bonus = $13, incentive = $14, other_allowance = $15, extra_work = $16,
                pf = $17, esi = $18, professional_tax = $19, income_tax = $20, loan_deduction = $21,
                advance_salary = $22, other_deduction = $23,
                employer_pf = $24, employer_esi = $25, employer_contribution = $26,
                gross_salary = $27, total_deductions = $28, allowances = $29, deductions = $30,
                net_salary = $31, status = 'processed', updated_at = NOW()
            RETURNING *`,
            [
                employee_id, month, year,
                Math.round(num(finalValues.working_days)), Math.round(num(finalValues.present_days)),
                Math.round(num(finalValues.leave_days)), Math.round(num(finalValues.lop_days)),
                num(payrollValues.basic_salary), num(payrollValues.hra), num(payrollValues.conveyance), num(payrollValues.medical),
                num(payrollValues.special_allowance), num(payrollValues.bonus), num(payrollValues.incentive), num(payrollValues.other_allowance),
                num(payrollValues.extra_work),
                num(payrollValues.pf), num(payrollValues.esi), num(payrollValues.professional_tax), num(payrollValues.income_tax),
                num(payrollValues.loan_deduction), num(payrollValues.advance_salary), num(payrollValues.other_deduction),
                num(payrollValues.employer_pf), num(payrollValues.employer_esi), num(payrollValues.employer_contribution),
                gross, totalDeductions, allowances, deductions, net
            ]
        );

        const payslip = result.rows[0];

        logAudit({
            actorId: req.user.id,
            action: 'payroll.generate',
            entityType: 'payslip',
            entityId: payslip.id,
            details: { employee_db_id: payslip.employee_id, month, year, net, employee_status: finalValues.employee_status || payrollValues.employee_status || 'active' },
            ip: req.ip
        });

        // Auto-email the employee using their personal email ONLY (never the official/work email).
        // personal_email already comes back from getProfileSalaryValues (no extra query).
        let email_sent = null;
        const empEmail = payrollValues.personal_email;
        if (empEmail) {
            let pdfBuffer = pdfFromBase64(v.pdfBase64);
            if (!pdfBuffer) {
                const row = await fetchPayslipWithProfile(payslip.id, req.user.id, true);
                if (row) pdfBuffer = await renderPayslipPdf(row, row.company);
            }
            if (pdfBuffer) {
                const filename = `payslip_${payrollValues.emp_code || payslip.employee_id}_${month}_${year}.pdf`;
                email_sent = await sendPayslipEmail(empEmail, filename, pdfBuffer, {
                    name: `${payrollValues.first_name || ''} ${payrollValues.last_name || ''}`.trim(),
                    empId: payrollValues.emp_code,
                    net
                });
            }
        }

        res.json({ success: true, payslip, email_sent,
            employee_status: finalValues.employee_status || payrollValues.employee_status || 'active',
            status_warning: finalValues.status_warning || payrollValues.status_warning || null });
    } catch (error) {
        console.error('Generate payroll error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   POST /api/payroll/generate-bulk
// @desc    Batch-generate processed payslips for multiple employees and email each
// @access  Admin
router.post('/generate-bulk', verifyToken, isAdmin, async (req, res) => {
    try {
        const items = req.body.items;
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ success: false, message: 'No payslip items provided' });
        }

        const results = [];
        let created = 0;
        let emailed = 0;
        let failed = 0;

        for (const v of items) {
            try {
                const employee_id = v.employee_id;
                const month = parseInt(v.month, 10);
                const year = parseInt(v.year, 10);
                if (!employee_id || !month || !year) { failed++; results.push({ employee_id, ok: false, reason: 'Invalid employee/month/year' }); continue; }

                const payrollValues = await getProfileSalaryValues(employee_id, v);
                if (!payrollValues) {
                    failed++;
                    results.push({ employee_id, ok: false, reason: 'Employee profile not found' });
                    continue;
                }
                // Always recompute server-side (same as single generation) so
                // every attendance policy is applied uniformly in bulk runs.
                const attVals = await computeAttendanceSummary(employee_id, month, year);
                if (!attVals) {
                    failed++;
                    results.push({ employee_id, ok: false, reason: 'Employee attendance could not be computed' });
                    continue;
                }
                const finalValues = { ...payrollValues, ...attVals };
                const totals = computeTotals(finalValues);
                if (!totals.attendanceValid) {
                    failed++;
                    results.push({ employee_id, ok: false, reason: 'Attendance calculation is incorrect.' });
                    continue;
                }
                const gross = totals.gross;
                const totalDeductions = totals.totalDeductions;
                const net = totals.net;
                const allowances = gross - num(payrollValues.basic_salary);
                const deductions = totalDeductions;

                const result = await query(
                    `INSERT INTO payroll (
                        employee_id, month, year, working_days, present_days, leave_days, lop_days,
                        basic_salary, hra, conveyance, medical, special_allowance, bonus, incentive, other_allowance, extra_work,
                        pf, esi, professional_tax, income_tax, loan_deduction, advance_salary, other_deduction,
                        employer_pf, employer_esi, employer_contribution,
                        gross_salary, total_deductions, allowances, deductions, net_salary, status
                    ) VALUES (
                        $1, $2, $3, $4, $5, $6, $7,
                        $8, $9, $10, $11, $12, $13, $14, $15, $16,
                        $17, $18, $19, $20, $21, $22, $23,
                        $24, $25, $26,
                        $27, $28, $29, $30, $31, 'processed'
                    )
                    ON CONFLICT (employee_id, month, year) DO UPDATE SET
                        working_days = $4, present_days = $5, leave_days = $6, lop_days = $7,
                        basic_salary = $8, hra = $9, conveyance = $10, medical = $11, special_allowance = $12,
                        bonus = $13, incentive = $14, other_allowance = $15, extra_work = $16,
                        pf = $17, esi = $18, professional_tax = $19, income_tax = $20, loan_deduction = $21,
                        advance_salary = $22, other_deduction = $23,
                        employer_pf = $24, employer_esi = $25, employer_contribution = $26,
                        gross_salary = $27, total_deductions = $28, allowances = $29, deductions = $30,
                        net_salary = $31, status = 'processed', updated_at = NOW()
                    RETURNING id`,
                    [
                        employee_id, month, year,
                        Math.round(num(finalValues.working_days)), Math.round(num(finalValues.present_days)),
                        Math.round(num(finalValues.leave_days)), Math.round(num(finalValues.lop_days)),
                        num(payrollValues.basic_salary), num(payrollValues.hra), num(payrollValues.conveyance), num(payrollValues.medical),
                        num(payrollValues.special_allowance), num(payrollValues.bonus), num(payrollValues.incentive), num(payrollValues.other_allowance),
                        num(payrollValues.extra_work),
                        num(payrollValues.pf), num(payrollValues.esi), num(payrollValues.professional_tax), num(payrollValues.income_tax),
                        num(payrollValues.loan_deduction), num(payrollValues.advance_salary), num(payrollValues.other_deduction),
                        num(payrollValues.employer_pf), num(payrollValues.employer_esi), num(payrollValues.employer_contribution),
                        gross, totalDeductions, allowances, deductions, net
                    ]
                );
                created++;

                // Email each employee using their personal email ONLY (never the official/work email).
                // personal_email already comes back from getProfileSalaryValues (no extra query).
                let email_sent = false;
                if (payrollValues.personal_email) {
                    let pdfBuffer = pdfFromBase64(v.pdfBase64);
                    if (!pdfBuffer) {
                        const row = await fetchPayslipWithProfile(result.rows[0].id, req.user.id, true);
                        if (row) pdfBuffer = await renderPayslipPdf(row, row.company);
                    }
                    if (pdfBuffer) {
                        const filename = `payslip_${payrollValues.emp_code || employee_id}_${month}_${year}.pdf`;
                        const sent = await sendPayslipEmail(payrollValues.personal_email, filename, pdfBuffer, {
                            name: `${payrollValues.first_name || ''} ${payrollValues.last_name || ''}`.trim(),
                            empId: payrollValues.emp_code,
                            net
                        });
                        if (sent.success) { emailed++; email_sent = true; }
                    }
                }
                results.push({ employee_id, ok: true, email_sent });
            } catch (e) {
                failed++;
                results.push({ employee_id: v.employee_id, ok: false, reason: e.message });
            }
        }

        logAudit({
            actorId: req.user.id,
            action: 'payroll.generate_bulk',
            entityType: 'payslip',
            entityId: null,
            details: { created, emailed, failed, requested: items.length },
            ip: req.ip
        });

        res.json({ success: true, created, emailed, failed, results });
    } catch (error) {
        console.error('Bulk generate payroll error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   DELETE /api/payroll/:id
// @desc    Delete a payslip
// @access  Admin
router.delete('/:id', verifyToken, isAdmin, async (req, res) => {
    try {
        const result = await query('DELETE FROM payroll WHERE id = $1 RETURNING id', [req.params.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Payslip not found' });
        }
        logAudit({ actorId: req.user.id, action: 'payroll.delete', entityType: 'payslip', entityId: req.params.id, ip: req.ip });
        res.json({ success: true, message: 'Payslip deleted successfully' });
    } catch (error) {
        console.error('Delete payslip error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;
// computeTotals is the single source of truth for payroll net-pay math. It is
// reused by server/index.js::repairPayrollNetSalaries so the boot-time recompute
// can never drift from the /generate formula again.
module.exports.computeTotals = computeTotals;
