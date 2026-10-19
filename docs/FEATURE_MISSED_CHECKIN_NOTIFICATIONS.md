# Missed Check-in/out Notifications + Regularization Review Loop

**Date:** 2026-10-15
**Ask (founder, Telugu-roman):** missed check-out already notifies — do the same
for missed check-in, but NEVER auto-check-in; past grace = absent; a present
employee who forgot to check in files a request and admin reviews approve/reject.

## Deep-dive: what already existed

| Ask | State before this change |
|-----|--------------------------|
| Missed check-out → notify + respond | BUILT (`services/attendanceAutoCheckout.js`: auto-close at `office_end_time + checkout_grace_minutes`, `attendance_auto_checkout` notify + bell, reason via Missed-Checkouts banner; 1st miss/month warning, 2nd+ half-day, never absent) |
| Missed check-in → notify, NO auto check-in | HALF: `runAutoMark` marked `absent` past office end but **silently** (no notification). No auto check-in exists anywhere (confirmed — only absence rows are created) |
| Grace expiry = absent | BUILT (auto-mark after office end; check-in lateness via `late_grace_period`) |
| Forgot check-in → request → admin approve/reject | BUILT (`routes/regularization.js` + employee page + manager my-team tab + admin attendance section; review scope admin/HR company-wide, manager/tree since `8518f37`). **Gaps:** no notify to reviewers on filing, no notify to employee on decision, review was read-then-write (race) |

## What changed (this increment)

1. **Absent notification** (`services/attendanceAutoMark.js`): `markAbsentForDate`
   now `RETURNING id, employee_id, date`; `runAutoMark` notifies each newly-marked
   employee (`attendance_marked_absent` → `/employee/regularization`). Only
   actually-inserted rows notify, so re-runs/backfill never double-notify
   (dedupe via `uq_un_emp_entity`). No auto check-in added — by decision.
2. **Filing notifies reviewers** (`routes/regularization.js` POST `/`): direct
   reporting manager (+ secondary) and all active HR users get
   `regularization_requested` (role-appropriate URLs). Admins keep the pending
   bell badge. Best-effort sidecar, never fails the filing.
3. **Decision notifies the employee**: approve/reject sends
   `regularization_reviewed` with the date (+ reject note) → `/employee/regularization`.
4. **TOCTOU-safe review**: the status flip is now
   `UPDATE ... WHERE status = 'pending' RETURNING *`; zero rows → **409**.
   The old 400 pre-check is gone, so sequential and concurrent double-reviews
   both answer 409 (repo convention, AGENTS.md §5).

No schema changes. No new settings. No UI changes needed (pages already link
`/employee/regularization`; bell counts already include pending regularizations).

## Decisions (owner, 2026-10-15)

- Absent notify covers **all** newly-marked dates incl. backfill (not last-2-days).
- Filing notifies **direct manager + HR** (not all admins).
- Review race hardened with 409 (not left as-is).

## Verification

- Extended `scripts/qa-reg-review.cjs` 7 → **18 checks** (cron 401 guard,
  auto-mark marks + notifies + idempotent re-run with zero dupes, filing notifies
  mgr1 + HR, approve/reject notify employee, double-review 409, scope + write-back):
  **18/18 green** standalone (`node scripts/qa-reg-review.cjs`).
- The harness owns ports 5433/3000 and kills whoever holds them, so it is
  **NOT wired into `qa-commander.cjs`** (same reason its header always said
  standalone) — run it after `npm run qa`.
- Full hermetic `npm run qa`: **58/59**; the single fail is the documented
  late-night auto-checkout flake in `qa-attendance-checkin-status.cjs` (2 checks;
  run happened ~23:30 IST, past the 20:30 auto-close deadline — rows carry
  `auto_checkout: true`). Untouched code paths (check-in/check-out/auto-checkout);
  AGENTS.md §11 already records this flake. RBAC 183 probes + invariants 43 green,
  zero leftovers.

## Files changed

- `server/services/attendanceAutoMark.js` (RETURNING + notify)
- `server/routes/regularization.js` (filing notify, decision notify, TOCTOU 409)
- `scripts/qa-reg-review.cjs` (7 → 18 checks; standalone warning)
- `docs/FEATURE_MISSED_CHECKIN_NOTIFICATIONS.md` (this file)
