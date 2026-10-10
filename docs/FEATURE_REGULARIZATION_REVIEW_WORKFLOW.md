# Attendance Workflow — Regularization Review + Clarity (2026-10-10)

## What the workflow is (founder-approved design)

1. **Employee** logs in → **checks in** (office_start_time + late_grace_period window → `present`;
   late → `late`; after noon → `half-day`). Selfie + location mandatory.
2. **Checks out** (selfie + location mandatory). Missed check-out → auto-checked-out at the
   grace deadline; 1st miss = warning, 2nd+ = `half-day`.
3. **Attendance history** (`/employee/attendance`) updates clearly: calendar + monthly table +
   summary counts. Clicking any day opens a popup with that day's status, check-in/out, hours,
   break, location, auto-check-out + miss reason, regularized flag.
4. **Employee requests a correction** for a missed day (`/employee/regularization`).
5. **Reviewer approves/rejects** → on approve the requested times are written into the attendance
   record (status `absent` → `present`).
6. **Admin edits any attendance day** directly (admin/HR company-wide, manager on own tree).

## Gap found (the only broken step)

Step 5 was broken: the **only** review UI is the manager portal
(`manager/my-team.html` → `POST /api/regularization/{id}/review`), but that endpoint was
**admin-only** (`if (req.user.role !== 'admin') 403`). So a manager could *see* their subtree's
pending requests (`GET /regularization/pending` is correctly tree-scoped) but got **403** when
approving — the request sat pending unless an admin reviewed it.

## Changes

- **`server/routes/regularization.js`** — widened `POST /:id/review` to match `/pending`'s scope:
  - `admin` / `hr` → company-wide.
  - `manager` / `team_lead` → own reporting tree only (verified via `myTreeIds`, same scope as
    the `/edit` attendance route). Out-of-tree → 403.
  - employee (and any other role) → 403.
  - The atomic write-back (BEGIN/COMMIT, `absent`→`present` + times) is unchanged.
- **`public/pages/admin/attendance.html`** — added a **Pending Regularizations** review section
  (admin/HR see all) with Approve/Reject + a review-note modal, wired to the same endpoints.
- **`public/pages/employee/attendance.html`** — a past day with **no check-in row** now shows
  **"No check-in"** instead of plain **"Absent"** (calendar cell + day-detail badge), so a
  forgotten check-in isn't mistaken for a genuine absence. Payroll counting is unchanged.

## Verification

- **`scripts/qa-reg-review.cjs`** (new, boots its own stack — run manually, not via the commander):
  7/7 green — manager in-tree approve → **200** (was 403); manager out-of-tree → **403**;
  admin approve → **200**; approve writes `check_in`/`check_out`/`status=present` into attendance;
  out-of-tree request left pending (no attendance row).
- **`qa/rbac-matrix.json`** — `regularize-review` row updated (hr/manager/team_lead `403`→`400`
  with `{}` body, since the status validator now fires for authorized roles; employee stays `403`).
- **`npm run qa`** — **59/59 green** (regression 241 checks, RBAC 183 cell probes, invariants
  43/43, zero leftovers). Inline-JS gate clean on both pages.

## Notes

- The full attendance workflow (check-in grace, check-out, auto-checkout, history, day-detail,
  admin edit) was already built and verified; this change closed the review gap + a clarity nit.
- Manager portal review UI (`my-team.html`) needed no change — it already called the endpoint and
  handles success/failure; it just stopped 403-ing.
