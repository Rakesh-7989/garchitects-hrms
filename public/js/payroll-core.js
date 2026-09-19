/* ============================================================
   Payroll Core - shared helpers for admin + employee pages
   Single source payslip template (preview / download / print /
   email). Used together with html2pdf + JSZip (loaded on demand).
   ============================================================ */

const PP_MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function ppNum(v) { return Number(v) || 0; }

function ppEsc(str) {
    if (str === null || str === undefined) return '';
    // Escape &, <, > and quotes so values are safe in both text nodes and
    // attribute positions (src="...", style="...").
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function ppFormatINR(amount) {
    return '₹' + Number(amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ppFormatCurrency(amount) {
    return '₹' + Number(amount || 0).toLocaleString('en-IN');
}

// Plain Indian-formatted number (no currency symbol) for payslip tables, matching the reference.
function ppNumFmt(amount) {
    return Number(amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Indian number -> words ("Rupees .. Lakh .. Thousand .. Hundred .. Paise Only")
function ppAmountInWords(amount) {
    const value = Math.round(ppNum(amount) * 100) / 100;
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
        const crore = Math.floor(rupees / 10000000); rupees %= 10000000;
        const lakh = Math.floor(rupees / 100000); rupees %= 100000;
        const thousand = Math.floor(rupees / 1000); rupees %= 1000;
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
    if (paise > 0) result += ' and ' + twoDigits(paise) + ' Paise';
    result += ' Only';
    return result;
}

// Mirrors the server-side computeTotals
//   A = Earnings (basic + allowances), B = Deductions, C = Bonus (incl. extra work),
//   D = Employer contributions, Net = Gross - LOP deduction + C - (B + D).
function ppCompute(v) {
    const componentGross = ppNum(v.basic_salary) + ppNum(v.hra) + ppNum(v.conveyance)
        + ppNum(v.special_allowance) + ppNum(v.other_allowance);
    const gross = ppNum(v.monthly_gross) > 0 ? ppNum(v.monthly_gross) : componentGross;
    const totalDeductions = ppNum(v.pf) + ppNum(v.esi) + ppNum(v.professional_tax) + ppNum(v.income_tax)
        + ppNum(v.other_deduction);
    const bonus = ppNum(v.bonus) + ppNum(v.incentive) + ppNum(v.extra_work);
    const employerTotal = ppNum(v.employer_pf) + ppNum(v.employer_esi) + ppNum(v.employer_contribution);
    const workingDays = ppNum(v.working_days);
    const presentDays = ppNum(v.present_days);
    const leaveDays = ppNum(v.leave_days);
    const lopDays = ppNum(v.lop_days);
    const paidDays = presentDays + leaveDays;
    // Mid-month previews legitimately leave a gap (upcoming days are neither
 // present nor LOP), so paid buckets only need to fit WITHIN working days.
 const attendanceValid = (presentDays + leaveDays + lopDays) <= workingDays + 0.001;
    const actualPayableGross = gross - totalDeductions + bonus;
    const totalDeductionsWithEmployer = totalDeductions + employerTotal;
    const netPayable = actualPayableGross - employerTotal;
    const perDaySalary = workingDays > 0 ? netPayable / workingDays : 0;
    const lopDeduction = perDaySalary * lopDays;
    const net = netPayable - lopDeduction;
    return { gross, totalDeductions, totalDeductionsWithEmployer, bonus, employerTotal, workingDays, presentDays, leaveDays, lopDays, paidDays, actualPayableGross, netPayable, perDaySalary, lopDeduction, attendanceValid, net };
}

// ---- Dynamic library loading (JSZip only – PDF is server-rendered) ----
let ppLibsPromise = null;

function ppLoadScript(src) {
    return new Promise((resolve, reject) => {
        if (document.querySelector('script[src="' + src + '"]')) return resolve();
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('Failed to load ' + src));
        document.head.appendChild(s);
    });
}

function ppEnsureLibs() {
    if (ppLibsPromise) return ppLibsPromise;
    ppLibsPromise = ppLoadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
    return ppLibsPromise;
}

// ---- Helper: get auth token for server API calls ----
function ppAuthToken() {
    return localStorage.getItem('token') || '';
}

// ---- Helper: fetch a real text-based PDF from the server (PDFKit) ----
async function ppFetchServerPdf(p) {
    const token = ppAuthToken();
    let resp;
    if (p && p.id) {
        resp = await fetch(API_URL + '/payroll/' + p.id + '/pdf', {
            headers: { 'Authorization': 'Bearer ' + token }
        });
    } else {
        resp = await fetch(API_URL + '/payroll/render-pdf', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify(p)
        });
    }
    if (!resp.ok) throw new Error('PDF generation failed (status ' + resp.status + ')');
    return await resp.blob();
}

// ---- Single-source payslip template (matches designer reference) ----

function ppSecBar(title) {
    return '<div class="pp-sec">' + title + '</div>';
}

function ppEmpRow(l1, v1, l2, v2) {
    return '<tr>' +
        '<td>' + l1 + '</td><td>' + v1 + '</td>' +
        '<td>' + l2 + '</td><td>' + v2 + '</td></tr>';
}

function ppNumRow(label, value, last) {
    return '<tr>' +
        '<td>' + label + '</td>' +
        '<td class="text-right">' + value + '</td></tr>';
}

function buildPayslipHTML(p) {
    if (!p) return '';
    const company = p.company || {};
    const empName = ((p.first_name || '') + ' ' + (p.last_name || '')).trim() || '-';
    const period = (PP_MONTHS[p.month] || '') + ' ' + (p.year || '');
    const totals = ppCompute(p);
    const doj = p.joining_date ? String(p.joining_date).substring(0, 10) : '-';
    const earnings = [
        ['Basic Salary', ppNumFmt(p.basic_salary)],
        ['HRA', ppNumFmt(p.hra)],
        ['Conveyance Allowance', ppNumFmt(p.conveyance)],
        ['Medical Allowance', ppNumFmt(p.other_allowance)],
        ['Special Allowance', ppNumFmt(p.special_allowance)]
    ];
    const deductions = [
        ['PF Contribution', ppNumFmt(p.pf)],
        ['ESI Contribution', ppNumFmt(p.esi)],
        ['Professional Tax', ppNumFmt(p.professional_tax)],
        ['Income Tax', ppNumFmt(p.income_tax)],
        ['Other Deductions', ppNumFmt(p.other_deduction)]
    ];
    const bonusRows = [
        ['Incentive', ppNumFmt(p.incentive)],
        ['Attendance Incentive', ppNumFmt(p.bonus)],
        ['Extra Work', ppNumFmt(p.extra_work)]
    ];
    const finTable = (title, rows, totalLabel, totalValue) =>
        '<table class="pp-fin">' +
            // Fixed layout + explicit col widths keep the AMOUNT divider at an
            // exact integer position at every zoom level.
            '<colgroup><col /><col style="width:95px;" /></colgroup>' +
            '<thead><tr><th>' + title + '</th><th class="text-right">AMOUNT (\u20B9)</th></tr></thead>' +
            '<tbody>' +
                rows.map((r) => '<tr><td>' + r[0] + '</td><td class="text-right">' + r[1] + '</td></tr>').join('') +
                '<tr class="total-row"><td>' + totalLabel + '</td><td class="text-right">' + ppNumFmt(totalValue) + '</td></tr>' +
            '</tbody></table>';
    const logoHtml = (company.logo || '/assets/images/garchitects_logo.png')
        ? '<img src="' + ppEsc(company.logo || '/assets/images/garchitects_logo.png') + '" alt="G-Architects Logo" style="width:175px;height:auto;object-fit:contain;flex-shrink:0;" onerror="this.style.display=\'none\';">'
        : '<i class="fas fa-building" style="font-size:26px;color:#7c6ca8;"></i>';
    // Company block from DB data with garchitects defaults as fallback, so settings
    // edits reflect on payslips without code changes.
    const coName = company.name || 'G Architects';
    const coAddress = String(company.address || 'Plot no. 84, Flat no. 302, Sri Nikethan, near Balaji Temple,\nSiddhi Vinayak Nagar, Balaji Hills, Khanammet, Hyderabad, 500081, Telangana, India');
    const addressHtml = ppEsc(coAddress).replace(/\r?\n/g, '<br>');
    // Contact lines must ALWAYS be visible on the payslip. If the company
    // settings have not loaded (or fields are empty), fall back to the garchitects
    // defaults - exactly like the server-side PDF renderer does.
    const contactBits = [];
    contactBits.push('E-Mail: ' + ppEsc(company.email || 'garchitects99@gmail.com'));
    contactBits.push('Ph No: ' + ppEsc(company.phone || '+91 63740 48059'));
    return '<div class="pp-sheet ppslip" style="width:794px;box-sizing:border-box;margin:0 auto;background:#ffffff;color:#222;font-family:Arial,Helvetica,sans-serif;border:1px solid #7c6ca8;padding:22px 28px;box-shadow:0 0 12px rgba(0,0,0,0.08);">' +
        '<style>' +
        '.ppslip{line-height:normal;}' +
        '.ppslip *{box-sizing:border-box;}' +
        '.ppslip table{width:100%;table-layout:fixed;border-collapse:collapse;border-spacing:0;font-size:11.5px;margin-bottom:12px;}' +
        '.ppslip th,.ppslip td{border:1px solid #d8cfe8;padding:5px 10px;line-height:14px;text-align:left;font-size:11.5px;text-transform:none;letter-spacing:normal;white-space:normal;}' +
        '.ppslip th{font-weight:700;}' +
        '.ppslip tbody tr:last-child td{border-bottom:1px solid #d8cfe8;}' +
        '.ppslip tbody tr:hover{background:transparent;}' +
        '.ppslip tr{transition:none;}' +
        '.ppslip .text-right{text-align:right;}' +
        '.ppslip .pp-sec{background:#e5e0f5;color:#38286b;padding:6px 10px;line-height:14px;font-size:11.5px;font-weight:700;display:flex;align-items:center;gap:6px;border-top:1px solid #d8cfe8;border-right:1px solid #d8cfe8;border-bottom:1px solid #d8cfe8;border-left:4px solid #7c6ca8;margin-bottom:8px;}' +
        '.ppslip .pp-emp td{width:25%;}' +
        '.ppslip .pp-emp td:nth-child(odd){background:#fbf9fc;color:#333;}' +
        '.ppslip .pp-emp td:nth-child(even){color:#111;font-weight:600;}' +
        '.ppslip .pp-fin th{background:#e5e0f5;color:#38286b;font-weight:700;font-size:11.5px;border:1px solid #d8cfe8;}' +
        '.ppslip .pp-fin td{border:1px solid #d8cfe8;}' +
        '.ppslip .pp-att-values td{padding-top:2px;padding-bottom:2px;height:28px;}' +
        '.ppslip .pp-attendance th{height:30px;line-height:1.0;}' +
        '.ppslip .total-row td{background:#efeafb;font-weight:700;color:#38286b;}' +
        '</style>' +
        '<!-- HEADER -->' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #7c6ca8;padding-bottom:16px;margin-bottom:16px;">' +
            '<div style="display:flex;align-items:center;gap:15px;">' +
                '<div style="flex-shrink:0;">' + logoHtml + '</div>' +
                '<div style="width:1px;height:95px;background:#7c6ca8;margin:0 5px;flex-shrink:0;align-self:center;"></div>' +
                '<div style="display:flex;flex-direction:column;justify-content:center;">' +
                    '<div style="font-size:19px;font-weight:900;color:#111;letter-spacing:0.2px;margin-bottom:5px;">' + ppEsc(coName.toUpperCase()) + '</div>' +
                    '<div style="display:flex;align-items:center;font-size:10.5px;color:#222;line-height:1.2;margin-bottom:3px;">' + addressHtml + '</div>' +
                    contactBits.map(function (c) {
                        return '<div style="display:flex;align-items:center;font-size:10.5px;color:#222;line-height:1.2;margin-bottom:3px;">' + c + '</div>';
                    }).join('') +
                '</div>' +
            '</div>' +
            '<div style="width:150px;border:1px solid #7c6ca8;border-radius:6px;overflow:hidden;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.05);">' +
                '<div style="background:#7c6ca8;color:#FFFFFF;font-weight:700;font-size:15px;letter-spacing:1px;padding:7px 0;">PAYSLIP</div>' +
                '<div style="background:#FFFFFF;color:#111111;font-weight:700;font-size:13.5px;padding:8px 0;">' + ppEsc(period) + '</div>' +
            '</div>' +
        '</div>' +
        '<!-- EMPLOYEE DETAILS -->' +
        '<div class="pp-sec" style="margin-bottom:0;">EMPLOYEE DETAILS</div>' +
        '<table class="pp-emp">' +
            ppEmpRow('Employee ID', ppEsc(p.emp_id || '-'), 'Pay Period', ppEsc(period)) +
            ppEmpRow('Employee Name', ppEsc(empName), 'Working Days', ppNum(p.working_days)) +
            ppEmpRow('Designation', ppEsc(p.designation_name || '-'), 'Present Days', ppNum(p.present_days)) +
            ppEmpRow('Department', ppEsc(p.department_name || '-'), 'Leave Days', ppNum(p.leave_days)) +
            ppEmpRow('Date of Joining', ppEsc(doj), 'LOP Days', ppNum(p.lop_days)) +
            ppEmpRow('PAN Number', ppEsc(p.pan_number || '-'), 'Bank Account No.', ppEsc(p.bank_account || '-')) +
            ppEmpRow('UAN Number', ppEsc(p.uan_number || '-'), 'Bank Name', ppEsc(p.bank_name || '-')) +
        '</table>' +
        '<!-- EARNINGS / DEDUCTIONS -->' +
        '<div style="display:flex;gap:12px;margin-bottom:6px;">' +
            '<div style="width:362px;">' + finTable('EARNINGS', earnings, 'TOTAL EARNINGS (A)', totals.gross) + '</div>' +
            '<div style="width:362px;">' + finTable('DEDUCTIONS', deductions, 'TOTAL DEDUCTIONS (B)', totals.totalDeductions) + '</div>' +
        '</div>' +
        '<!-- SUMMARY CARDS -->' +
        '<div style="display:flex;justify-content:center;gap:10px;margin-bottom:6px;">' +
            '<div style="width:239px;height:65px;background:#fbfbfd;border:1px solid #d8cfe8;border-radius:5px;padding:8px 5px;text-align:center;display:flex;flex-direction:column;justify-content:center;">' +
                '<div style="font-size:13.5px;font-weight:700;color:#444;margin-bottom:5px;white-space:nowrap;">GROSS SALARY (A)</div>' +
                '<div style="font-size:19px;font-weight:700;color:#38286b;">\u20B9 ' + ppNumFmt(totals.gross) + '</div></div>' +
            '<div style="width:238px;height:65px;background:#fbfbfd;border:1px solid #d8cfe8;border-radius:5px;padding:8px 5px;text-align:center;display:flex;flex-direction:column;justify-content:center;">' +
                '<div style="font-size:13.5px;font-weight:700;color:#444;margin-bottom:5px;white-space:nowrap;">TOTAL DEDUCTIONS</div>' +
                '<div style="font-size:19px;font-weight:700;color:#d97706;">\u20B9 ' + ppNumFmt(totals.totalDeductionsWithEmployer) + '</div></div>' +
            '<div style="width:239px;height:65px;background:#fbfbfd;border:1px solid #d8cfe8;border-radius:5px;padding:8px 5px;text-align:center;display:flex;flex-direction:column;justify-content:center;">' +
                '<div style="font-size:13.5px;font-weight:700;color:#444;margin-bottom:5px;white-space:nowrap;">NET SALARY PAYABLE</div>' +
                '<div style="font-size:19px;font-weight:700;color:#2e7d32;">\u20B9 ' + ppNumFmt(totals.net) + '</div></div>' +
        '</div>' +
        '<!-- Net Salary in Words -->' +
        '<div style="background:#fbfbfd;border:1px solid #d8cfe8;padding:7px 12px;line-height:14px;font-size:11.5px;margin-bottom:12px;display:flex;gap:12px;align-items:center;">' +
            '<span style="font-weight:700;color:#38286b;white-space:nowrap;">NET SALARY IN WORDS:</span>' +
            '<span style="font-style:italic;color:#222222;">' + ppEsc(ppAmountInWords(totals.net)) + '</span>' +
        '</div>' +
        '<!-- ATTENDANCE + BONUS -->' +
        '<div style="display:flex;gap:20px;margin-bottom:12px;align-items:flex-start;">' +
            '<div style="width:340px;">' +
                '<div class="pp-sec" style="margin-bottom:0;border-bottom:none;">ATTENDANCE SUMMARY</div>' +
                '<table class="pp-fin pp-attendance">' +
                    '<colgroup><col /><col /><col /><col /></colgroup>' +
                    '<thead><tr><th style="text-align:center;">Working Days</th><th style="text-align:center;">Present Days</th><th style="text-align:center;">Leave Days</th><th style="text-align:center;">LOP Days</th></tr></thead>' +
                    '<tbody><tr class="pp-att-values">' +
                        '<td style="text-align:center;font-weight:700;">' + ppNum(p.working_days) + '</td>' +
                        '<td style="text-align:center;font-weight:700;">' + ppNum(p.present_days) + '</td>' +
                        '<td style="text-align:center;font-weight:700;">' + ppNum(p.leave_days) + '</td>' +
                        '<td style="text-align:center;font-weight:700;">' + ppNum(p.lop_days) + '</td>' +
                    '</tr></tbody>' +
                '</table>' +
            '</div>' +
            '<div style="width:376px;">' + finTable('BONUS (C)', bonusRows, 'TOTAL BONUS (C)', totals.bonus) + '</div>' +
        '</div>' +
        '<!-- EMPLOYER CONTRIBUTIONS -->' +
        '<div style="margin-bottom:2px;">' + finTable('EMPLOYER CONTRIBUTIONS', [
            ['Employer PF Contribution', ppNumFmt(p.employer_pf)],
            ['Employer ESI Contribution', ppNumFmt(p.employer_esi)],
            ['Employer Other Contribution', ppNumFmt(p.employer_contribution)]
        ], 'TOTAL EMPLOYER CONTRIBUTION (D)', totals.employerTotal) + '</div>' +
        '<!-- FOOTER -->' +
        '<div style="display:flex;justify-content:space-between;margin-top:8px;padding-top:6px;padding-bottom:0;border-top:1px solid #d8cfe8;font-size:10.5px;align-items:flex-end;">' +
            '<div>' +
                '<strong>Note:</strong>' +
                '<ul style="list-style-type:disc;padding-left:15px;color:#555;line-height:1.4;margin:0;">' +
                    '<li>This is a computer generated payslip.</li>' +
                    '<li>No signature is required.</li>' +
                    '<li>Please contact HR for any discrepancies.</li>' +
                '</ul>' +
            '</div>' +
            '<div style="text-align:right;">' +
                '<div style="font-weight:700;color:#38286b;margin-bottom:8px;">For ' + ppEsc(coName.toUpperCase()) + '</div>' +
                '<div style="color:#555555;">This is a system generated document and does not require signature.</div>' +
            '</div>' +
        '</div>' +
    '</div>';
}

// Render preview into a container
function renderPayslipPreview(p, container) {
    if (!container) return;
    container.innerHTML = buildPayslipHTML(p);
}

// Server-side PDF: generate a real text-based PDF blob from the payslip data
async function payslipHtmlToPdfBlob(p) {
    return await ppFetchServerPdf(p);
}

function ppBlobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(blob);
    });
}

async function payslipToDataUrl(p) {
    const blob = await payslipHtmlToPdfBlob(p);
    return await ppBlobToBase64(blob);
}

// Download the payslip PDF (server-side PDFKit – real selectable text)
async function downloadPayslip(p, filename) {
    const blob = await ppFetchServerPdf(p);
    const name = filename || ('payslip_' + (p.emp_id || p.employee_id || '') + '_' + (p.month || '') + '_' + (p.year || '') + '.pdf');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

// Open print window with only the payslip (proper A4 dimensions)
function printPayslip(p) {
    const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Payslip</title>' +
        '<style>' +
        '@page{size:A4 portrait;margin:0;}' +
        'html,body{margin:0;padding:0;background:#FFFFFF;}' +
        '*{-webkit-print-color-adjust:exact;print-color-adjust:exact;color-adjust:exact;}' +
        '.pp-sheet{width:100% !important;max-width:none !important;min-height:297mm !important;margin:0 auto !important;padding:22px 28px !important;box-sizing:border-box !important;box-shadow:none !important;border:none !important;}' +
        '@media screen{html,body{width:210mm;height:297mm;overflow:hidden;}body{display:flex;justify-content:center;align-items:flex-start;}.pp-sheet{max-width:794px !important;margin:10px auto !important;box-shadow:0 0 12px rgba(0,0,0,0.08) !important;border:1px solid #7c6ca8 !important;}}' +
        '</style></head><body>' +
        buildPayslipHTML(p) +
        '<script>window.onload=function(){window.focus();setTimeout(function(){window.print();},400);};<\/script>' +
        '</body></html>';
    // Blob URL instead of document.write (deprecated + blocked in some contexts).
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const w = window.open(url, '_blank');
    if (!w) {
        URL.revokeObjectURL(url);
        showToast('Popup blocked. Allow popups to print.', 'error');
        return;
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Bulk ZIP download of payslip PDFs (server-side real text PDFs)
async function zipPayslips(payslips, zipName) {
    await ppEnsureLibs();
    const zip = new JSZip();
    for (const p of payslips) {
        try {
            const blob = await ppFetchServerPdf(p);
            zip.file('Payslip_' + (p.emp_id || p.employee_id || 'emp') + '_' + (p.month || '') + '_' + (p.year || '') + '.pdf', blob);
        } catch (e) {
            console.error('Failed to render PDF for', p.emp_id || p.employee_id, e);
        }
    }
    const content = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(content);
    const a = document.createElement('a');
    a.href = url;
    a.download = zipName || ('payslips_' + Date.now() + '.zip');
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

if (typeof window !== 'undefined') {
    window.ppNum = ppNum;
    window.ppEsc = ppEsc;
    window.ppFormatINR = ppFormatINR;
    window.ppFormatCurrency = ppFormatCurrency;
    window.ppAmountInWords = ppAmountInWords;
    window.ppCompute = ppCompute;
    window.buildPayslipHTML = buildPayslipHTML;
    window.renderPayslipPreview = renderPayslipPreview;
    window.payslipHtmlToPdfBlob = payslipHtmlToPdfBlob;
    window.payslipToDataUrl = payslipToDataUrl;
    window.downloadPayslip = downloadPayslip;
    window.printPayslip = printPayslip;
    window.zipPayslips = zipPayslips;
    window.PP_MONTHS = PP_MONTHS;
}
