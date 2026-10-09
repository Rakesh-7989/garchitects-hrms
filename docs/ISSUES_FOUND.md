# Issues Found & Fixes (G-Architects HRMS)

## Summary
Full audit performed. Baseline QA (hermetic): 56/56 green. Fixes applied focus on correctness/TZ safety and error hygiene. Post-fix QA (hermetic): 56/56 green.

## Fixes Applied

### F1. Error hygiene: missing pgErrorResponse in routes (P1 - Correctness/Security)
**Files**: `server/routes/auth.js`, `server/routes/notifications.js`, `server/routes/documents.js`  
**Issue**: Several catch blocks logged raw errors and returned generic 500 without using `pgErrorResponse()` (which maps 23505/23503/22P02/22007/22008/23514/23502 to friendly 400s and prevents leaking raw Postgres details).  
**Fix**: Imported `pgErrorResponse` from `schemaRepair` and replaced affected 500 responses with mapped status/message.  
**Verification**: `node --check` passes; hermetic QA 56/56.

### F2. TZ-safe date serialization (P1 - Correctness)
**Files**: `server/routes/attendance.js`, `server/routes/employees.js`, `server/routes/onboarding.js`, `server/routes/holidays.js`, `server/routes/payroll.js`, `server/routes/auth.js`, `server/scripts/test-smtp.js`  
**Issue**: Multiple spots used `Date.toISOString()` to extract `YYYY-MM-DD`. On hosts east of UTC (and with DATE columns at local-midnight), this can produce the previous UTC day (known class of bugs). Existing codebase prefers `dateOnly()`/TZ-safe formatting.  
**Fix**: Replaced `toISOString().split('T')[0]`/similar with `dateOnly()` where appropriate; for calendar round-trips, compare via UTC calendar components. In attendance photo expiry, store Date object (not string) consistent with DB types. Export filenames now use local calendar date via `getFullYear()/getMonth()+1/getDate()`.  
**Verification**: `node --check` clean; no remaining `toISOString()` in routes logic (left only comments). QA 56/56.

### F3. Minor robustness in attendance leave loop (P2 - Defensive)
**File**: `server/routes/attendance.js` (leave generation)  
**Issue**: Fallback used `toISOString()` if `dateOnly()` failed.  
**Fix**: Use explicit UTC calendar components in fallback to avoid TZ drift.  
**Verification**: Syntax check passes.

## Remaining Observations (Non-blocking)
- Many `console.log/error/warn` in server code (startup/migrations/crons/services). These are operational/logging, not correctness/security leaks in responses; consistent with existing codebase.
- Some comments reference `toISOString()` (documentation only) — left as-is.
- No raw `error.message` leaking to API responses in the modified routes (now mapped). Other routes/services may log to console; responses in routes generally return generic messages per repo hygiene.

## QA Results
- Hermetic: **56/56 passed, 0 failed** (pre and post fix)
- Syntax checks: all touched files pass `node --check`

All changes committed (0035f2a) and pushed to master.
