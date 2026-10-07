# FEATURE — Attendance check-in shown as "not checked in" (DATE serialization fix)

Shipped: 2026-10-07 · Server + QA harness + docs in one atomic commit.

## 1. Reported bug

An employee checks in; the `attendance` row is saved and the admin side shows it —
but when that employee logs in, the portal keeps showing **"Not checked in yet"**
and tells them to check in again (`#` / Keep scanning `/api/attendance/my`).

## 2. Root cause (verified)

`GET /api/attendance/my` (and `/api/attendance/all`) selected the Postgres `DATE`
column (`a.date`) raw and returned it via `res.json()`.

- node-postgres parses `DATE` columns (OID 1082) into a JS `Date` at **LOCAL
  midnight** (verified against the installed pg 8.11.3).
- `res.json()` serializes that Date with `toISOString()` → **UTC**. On any host
  east of UTC, LOCAL midnight is the PREVIOUS UTC day. Here (TZ = Asia/Kolkata,
  India Standard Time):

  ```
  DATE '2026-10-07'  ->  JS Date 2026-10-07T00:00:00+05:30
                     ->  JSON    "2026-10-06T18:30:00.000Z"
  ```

- The employee dashboard (and calendar) finds "today" with:
  ```js
  const adate = a.date ? a.date.split('T')[0] : '';   // "2026-10-06" <-- yesterday
  return adate === getTodayIST();                     // "2026-10-07"
  ```
  so the row **never matches** today → "Not checked in yet" + re-check-in prompt,
  while a duplicate check-in attempt then gets `400 Already checked in today`.
- Admin/manager pages render the same value via `formatDate()`/`new Date(...)`,
  which round-trips the shift back, so the record looks correct on the admin side —
  exactly matching the report ("admin lo store avuthundi … login lo kanipinchadam ledu").

Host matrix:
| Server TZ | JSON sent | Client match | Outcome |
|-----------|-----------|--------------|---------|
| UTC (Vercel default) | `2026-10-07T00:00:00.000Z` | split→`2026-10-07` | works |
| Asia/Kolkata (+05:30) | `2026-10-06T18:30:00.000Z` | split→`2026-10-06` | **broken** |

This is the same DATE-serialization bug class already documented in commit
`c2b28a8` ("Fix DATE-column formatting bug class found by the holiday round-trip
audit") and in `server/utils/date.js`; the attendance read endpoints were one of
the remaining unpatched sites. Manager-side attendance endpoints were already safe
(`/manager/today`, `/manager/attendance` use `::text` casts).

## 3. Fix (additive, no schema/migration)

`server/routes/attendance.js`:

- `GET /api/attendance/my` — normalize every row's `date` with the repo helper
  `dateOnly()` (server/utils/date.js, builds from local components → the stored
  calendar date on ANY host) before `res.json`.
- `GET /api/attendance/all` — same normalization (keeps the admin register and any
  future consumer on a deterministic contract).

Response contract change: `attendance[].date` is now a plain `YYYY-MM-DD` string
(was an ISO string that could be the previous day). All existing consumers already
tolerate that shape (`"2026-10-07".split('T')[0] → "2026-10-07"`; `formatDate`
parses it correctly). No client changes needed. No `sw.js` bump (no static assets
changed). No DB change.

## 4. Verification record

### Environment (honesty note)
- No production/remote Postgres is reachable from this machine. Verification ran
  against a **hermetic throwaway local PostgreSQL 16 cluster** (initdb
  `-U postgres --auth=trust -E UTF8 --locale=C`, port 5433, matching `.env`
  `DATABASE_URL`), loaded with `server/schema.sql` (full-line `//` comment lines
  stripped for psql), and the app server via `npm start`. The QA host's local time
  is **India Standard Time**, so the failing shift is real here (this is
  deliberately the environment the bug reproduces in).

### Red evidence (pre-fix)
With the installed pg (8.11.3) on this host:
```
pg.parse DATE '2026-10-07'  ->  JSON "2026-10-06T18:30:00.000Z"
client today (IST)          ->  "2026-10-07"   (split('T')[0] → "2026-10-06" ≠ today)
```
Under `TZ=UTC` the same value serializes `"2026-10-07T00:00:00.000Z"` (works) —
proving the shift is strictly a host-TZ effect, and why the fix must build from
local components (`dateOnly()`), which returns `"2026-10-07"` on every host.

### Green evidence (post-fix)
`scripts/qa-attendance-checkin-status.cjs` (hermetic `DATABASE_URL`, throwaway
admin + 2 employees, today's `attendance` rows seeded directly so "admin sees it"
is the premise, 3 logins, full API drive, then rollback) — **13/13 green**:

- logins (admin / open-day employee / completed-day employee) succeed;
- `GET /api/attendance/my` → every `date` is plain `YYYY-MM-DD`; a row exists with
  `date === "2026-10-07"` (exact string equality); no embedded `T`;
- the dashboard's exact lookup (`(a.date||'').split('T')[0] === today`) now finds
  the **open** check-in (check_in + location intact) and the **completed** day
  (check_in + check_out + status intact);
- `GET /api/attendance/all` (admin register) ships plain dates throughout;
- cleanup verified — DB left pristine (`0` QA employees remain).

Run: `node scripts/qa-attendance-checkin-status.cjs` (start `npm start` first; the
login limiter allows 10 attempts/15 min per IP and the harness uses 3 — restart the
server before a rerun to reset it).

## 5. Blast radius
- Changed: response `date` shape on `/api/attendance/my` + `/api/attendance/all`.
- Consumers (verified compatible): employee dashboard (`loadAttendanceStatus`,
  month stats, recent attendance), employee `attendance.html` (calendar, summary,
  table), admin `attendance.html` (recent logs via `formatDate`).
- Unchanged: schema, migrations, `sw.js`, other routes, manager attendance
  endpoints (already `::text`).