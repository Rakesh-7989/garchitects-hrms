const ExcelJS = require('exceljs');

// Shared branded report builder used by every /export endpoint so all
// downloads look like one consistent professional product.
//
// Layout produced:
//   Row 1: merged company banner   - brand indigo fill, white bold
//   Row 2: merged subtitle bar     - report name, filters, generated timestamp
//   Row 3: thin spacer
//   Row 4: column headers          - indigo fill, white bold, frozen + autofilter
//   Row 5+: data rows              - alternating banding, borders, smart formats
//   Last:  TOTAL row (optional)    - SUM formulas for flagged money/number columns
//
// Column descriptor: { header, key, width?, type?, total? }
//   type: 'money' | 'date' | 'datetime' | 'number' | 'percent' | 'status' | 'text'

const BANNER_FILL = 'FF312E81';      // deep indigo - top banner
const BRAND_FILL = 'FF4F46E5';       // brand indigo - column headers
const SUBTITLE_FILL = 'FFEEF2FF';    // indigo-50 tint - subtitle bar
const BAND_FILL = 'FFF8FAFC';        // slate-50 - alternating rows
const BORDER_COLOR = 'FFCBD5E1';     // slate-300 - cell borders
const TOTAL_FILL = 'FFE0E7FF';       // indigo-100 - totals row

const STATUS_FONT_COLORS = {
    // green - positive states
    active: 'FF059669', approved: 'FF059669', completed: 'FF059669', paid: 'FF059669', resolved: 'FF059669', done: 'FF059669',
    // amber - waiting states
    pending: 'FFB45309', in_progress: 'FFB45309', paused: 'FFB45309', draft: 'FFB45309', inactive: 'FFB45309',
    // red - negative states
    rejected: 'FFDC2626', terminated: 'FFDC2626', absent: 'FFDC2626', cancelled: 'FFDC2626'
};

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

function fmtTimestamp(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}-${MONTH_NAMES[d.getMonth()].substring(0, 3)}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toDisplayText(v) {
    if (v === null || v === undefined) return '';
    return String(v);
}

async function buildReportWorkbook({ company = 'G Architects', reportName, subtitleExtra, columns, rows, footerNote }) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'G-Architects HRMS';
    wb.created = new Date();

    const safeSheet = (reportName || 'Report').replace(/[\\/*?:[\]]/g, '').substring(0, 31) || 'Report';
    const ws = wb.addWorksheet(safeSheet, { views: [{ state: 'frozen', ySplit: 4 }] });

    const lastCol = columns.length;

    // Row 1 - company banner
    // Row 1 - company banner (left aligned, deep indigo premium fill)
    ws.mergeCells(1, 1, 1, lastCol);
    const banner = ws.getCell(1, 1);
    banner.value = company;
    banner.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
    banner.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BANNER_FILL } };
    banner.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    ws.getRow(1).height = 32;

    // Row 2 - subtitle bar (light indigo tint, left aligned)
    ws.mergeCells(2, 1, 2, lastCol);
    let sub = `${reportName}  •  Generated ${fmtTimestamp(new Date())}`;
    if (subtitleExtra) sub += `  •  ${subtitleExtra}`;
    const subCell = ws.getCell(2, 1);
    subCell.value = sub;
    subCell.font = { size: 11, color: { argb: 'FF4338CA' }, bold: true, italic: true };
    subCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SUBTITLE_FILL } };
    subCell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    ws.getRow(2).height = 20;
    ws.getRow(3).height = 6;

    // Row 4 - headers
    const headerRow = ws.getRow(4);
    columns.forEach((c, i) => {
        const cell = headerRow.getCell(i + 1);
        cell.value = c.header;
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_FILL } };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        cell.border = borderAll();
    });
    headerRow.height = 24;

    // Data rows
    const startRow = 5;
    rows.forEach((r, idx) => {
        const row = ws.getRow(startRow + idx);
        columns.forEach((c, i) => {
            const cell = row.getCell(i + 1);
            const raw = r[c.key];
            switch (c.type) {
                case 'money':
                    if (raw !== null && raw !== undefined && raw !== '') {
                        cell.value = Number(raw) || 0;
                        cell.numFmt = '"₹"#,##0.00';
                    }
                    break;
                case 'date': {
                    if (raw) {
                        const d = raw instanceof Date ? raw : new Date(raw);
                        if (!isNaN(d.getTime())) { cell.value = d; cell.numFmt = 'dd-mm-yyyy'; }
                    }
                    break;
                }
                case 'datetime': {
                    if (raw) {
                        const d = raw instanceof Date ? raw : new Date(raw);
                        if (!isNaN(d.getTime())) { cell.value = d; cell.numFmt = 'dd-mm-yyyy hh:mm'; }
                    }
                    break;
                }
                case 'percent':
                    if (raw !== null && raw !== undefined && raw !== '') {
                        cell.value = Number(raw) || 0;
                        cell.numFmt = '0.0"%"';
                    }
                    break;
                case 'status': {
                    const s = toDisplayText(raw).toLowerCase();
                    cell.value = toDisplayText(raw);
                    if (STATUS_FONT_COLORS[s]) cell.font = { color: { argb: STATUS_FONT_COLORS[s] }, bold: true };
                    break;
                }
                default:
                    cell.value = toDisplayText(raw);
            }
            cell.border = borderAll();
            if (idx % 2 === 1) {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND_FILL } };
            }
        });
    });

    // TOTAL row - SUM formulas for columns flagged total
    if (rows.length > 0) {
        const totalFlags = columns.some(c => c.total);
        if (totalFlags) {
            const tRow = ws.getRow(startRow + rows.length);
            columns.forEach((c, i) => {
                const cell = tRow.getCell(i + 1);
                cell.border = { top: { style: 'double', color: { argb: BRAND_FILL } }, bottom: { style: 'thin', color: { argb: BORDER_COLOR } }, left: { style: 'thin', color: { argb: BORDER_COLOR } }, right: { style: 'thin', color: { argb: BORDER_COLOR } } };
                cell.font = { bold: true, color: { argb: 'FF312E81' } };
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTAL_FILL } };
                if (i === 0) {
                    cell.value = 'TOTAL';
                    cell.alignment = { horizontal: 'left', indent: 1 };
                } else if (c.total && (c.type === 'money' || c.type === 'number')) {
                    const colLetter = columnLetter(i + 1);
                    cell.value = { formula: `SUM(${colLetter}${startRow}:${colLetter}${startRow + rows.length - 1})` };
                    if (c.type === 'money') cell.numFmt = '"₹"#,##0.00';
                }
            });
        }
    }

    // Footer note
    const noteRowNum = startRow + rows.length + 1;
    ws.mergeCells(noteRowNum, 1, noteRowNum, Math.min(lastCol, 8));
    const note = ws.getCell(noteRowNum, 1);
    note.value = `${rows.length} record(s)${footerNote ? ' • Exported by ' + footerNote : ''} • G-Architects HRMS`;
    note.font = { size: 9, italic: true, color: { argb: 'FF9CA3AF' } };

    // Auto width estimation (respect explicit widths)
    columns.forEach((c, i) => {
        if (c.width) { ws.getColumn(i + 1).width = c.width; return; }
        let max = c.header.length;
        for (const r of rows) {
            const v = r[c.key];
            const len = v === null || v === undefined ? 0 : toDisplayText(v).length;
            if (len > max) max = len;
        }
        ws.getColumn(i + 1).width = Math.min(Math.max(max + 2, 11), 42);
    });

    // AutoFilter across the header range
    ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: lastCol } };

    return wb;
}

function borderAll() {
    return {
        top: { style: 'thin', color: { argb: BORDER_COLOR } },
        left: { style: 'thin', color: { argb: BORDER_COLOR } },
        bottom: { style: 'thin', color: { argb: BORDER_COLOR } },
        right: { style: 'thin', color: { argb: BORDER_COLOR } }
    };
}

function columnLetter(n) {
    let s = '';
    while (n > 0) {
        const m = (n - 1) % 26;
        s = String.fromCharCode(65 + m) + s;
        n = Math.floor((n - m - 1) / 26);
    }
    return s;
}

// Stream the workbook as a downloadable .xlsx response.
async function sendWorkbook(res, workbook, filename) {
    const buf = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(Buffer.from(buf));
}

module.exports = { buildReportWorkbook, sendWorkbook };
