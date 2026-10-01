const TIMEZONE = process.env.TIMEZONE || 'Asia/Kolkata';

// Current date as YYYY-MM-DD in the office timezone (IST by default).
// Server may run on UTC (Vercel), so Date.toISOString() would give the wrong day.
function istDateString(date) {
    return (date instanceof Date ? date : new Date())
        .toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

// Current time as HH:MM:SS (24h) in the office timezone.
function istTimeString(date) {
    return (date instanceof Date ? date : new Date())
        .toLocaleTimeString('en-GB', { timeZone: TIMEZONE, hour12: false });
}

// Current month (1-12) in the office timezone.
function istMonth() {
    return parseInt(new Date().toLocaleDateString('en-US', { timeZone: TIMEZONE, month: 'numeric' }), 10);
}

// Current year in the office timezone.
function istYear() {
    return parseInt(new Date().toLocaleDateString('en-US', { timeZone: TIMEZONE, year: 'numeric' }), 10);
}

// Coerce any DATE/DATETIME value into 'YYYY-MM-DD'.
//
// node-postgres parses DATE columns (OID 1082) into a JS Date at LOCAL midnight,
// so String(date) yields 'Mon Jan 26 2026 00:00:00 GMT...' and the very common
// String(date).substring(0, 10) silently yields 'Mon Jan 26' - a garbage string
// that then fails every comparison. toISOString() is not safe either: it converts
// that local midnight back to the PREVIOUS day on any host running east of UTC.
// Building from the local components is correct on any host.
//
// Returns null for empty/invalid input rather than throwing, so callers can
// decide whether to skip the row.
function dateOnly(value) {
    if (value === undefined || value === null || value === '') return null;
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) return null;
        return value.getFullYear() + '-' +
            String(value.getMonth() + 1).padStart(2, '0') + '-' +
            String(value.getDate()).padStart(2, '0');
    }
    const s = String(value).trim();
    if (!s) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    return d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
}

module.exports = { TIMEZONE, istDateString, istTimeString, istMonth, istYear, dateOnly };
