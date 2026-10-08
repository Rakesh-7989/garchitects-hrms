# FEATURE_QA_COMMANDER_INVARIANTS.md — Increment 1: DB-invariant assertions

> Design + verification record. Increment 1 of the QA Commander roadmap: promote the
> commander's `db` stage from WARN-only leftover scans to **real domain invariants** that
> lock the money/time-critical derivations this product must never silently break.

## 1. The ask (restated)

Sprint 1 (full-system audit) is running; in parallel, Increment 1 adds **assertions** behind
the three invariant chains the business depends on:

1. **Leave balance** — apply → approve → balance must move exactly per the domain rule.
2. **Break finalize → hours worked** — a completed day's `break_log` must be closed JSON;
   hours worked must equal (check-out − check-in) − breaks.
3. **Payroll roll-up** — a generated payroll row must respect the effective-day calculation
   and never violate `UNIQUE(employee_id, month, year)`.

These are the "DB invariants matter" items the user called out in the QA-vision: a silent
regression here corrupts balances and pay, invisible to happy-path smoke tests.

## 2. Domain rules (grounded in code, verified 2026-10-09)

### L — Leave balance (`server/routes/leave.js` `/balance` + apply guard)
- Source of truth: `leave_types.days_per_year` (yearly quota) minus **distinct months** used.
- `used_days = COUNT(DISTINCT month) of approved applications in the current IST year`
  (line 428). **Not** a day-count. Model = "1 paid day per calendar month" (apply guard,
  line ~144: `usedMonths >= days_per_year` → 400 `Insufficient leave balance`).
- `pending_days = SUM(total_days)` of pending applications (line 429).
- `remaining = max(0, days_per_year − used_days)`.
- Gender-scoped: `leave_types.gender_eligibility = 'all'` or matches the employee's gender.

**Invariant assertions (L1..L5):**
- L1 apply in a **new** month, approve → `used_days` increases by exactly 1; `remaining` −1.
- L2 two approvals in the **same** month → `used_days` +1 total (distinct-month rule — a
  day-counting regression would give +2; this assertion catches it).
- L3 pending application → `pending_days` = its `total_days`; approve → pending cleared,
  used +1; reject/cancel → neither used nor pending changes.
- L4 apply guard: requesting days that push `usedMonths` past quota → 400 (guard intact),
  and NO row is written.
- L5 `remaining` never negative (API clamps at 0) and is idempotent across reads.

### A — Break finalize → hours worked (`attendance`, harness `qa-attendance-break-finalize`)
- `attendance.break_log` is TEXT holding a JSON array `[{start, end}, ...]`, closed at
  check-out / auto-checkout; never dangling on a completed day.
- Hours worked = (check_out − check_in) − Σ(break seconds), using the `getTotalBreakSeconds`
  derivation the attendance page renders.

**Invariant assertions (A1..A3):**
- A1 completed day → `break_log` parses as JSON, every entry has both `start` and `end`,
  `end ≤ check_out`, no `null`/`Running` sentinel.
- A2 hours worked recomputed from the row equals the value the UI/client would derive (same
  formula, independent recompute in the harness).
- A3 an open break at the day's close is finalized (covered by the break-finalize harness
  end-to-end; the DB assertion only re-verifies post-conditions).

### P — Payroll roll-up (`server/routes/payroll.js` + `public/js/payroll-core.js`)
- One row per `(employee_id, month, year)` — `UNIQUE` enforced by schema (line 227).
- Effective days feed the salary proration. **As built (verified on hermetic run):** `gross_salary`
  stores the FULL basic (20000) while `net_salary` is attendance-**prorated** (6000 for 5 present
  days) — so there is NO `net = basic + allowances − deductions` identity. The relationships
  that hold structurally (by construction, payroll.js:1326-1327/1363): `allowances = gross − basic`,
  `deductions = total_deductions`, `gross ≥ basic`, `0 ≤ net ≤ gross`.

**Invariant assertions (P1..P4):**
- P1 generate → exactly one row per employee/month/year; re-generate does not duplicate
  (UNIQUE posture).
- P2 structural money identities hold on the stored row: `allowances = gross − basic`,
  `deductions = total_deductions`, `gross ≥ basic`, `0 ≤ net ≤ gross` (net is prorated, so
  no exact-sum identity is asserted).
- P3 generation respects attendance statuses (absent days reduce effective days — assert on
  a seeded mixed attended/absent month, per the derivation in payroll-core.js).
- P4 negative/zero gross impossible on generated rows (net ≥ 0).

## 3. Wiring (blast radius — hermetic only)

- New harness **`scripts/qa-db-invariants.cjs`**: seeds a throwaway employee + leave type +
  attendance rows in the hermetic DB, drives the real HTTP routes (apply/approve via the
  approved role, `/balance`, `/attendance/my`, payroll generate), recomputes derivations
  **independently** from raw rows, cleans up to zero leftovers (same discipline as the RBAC
  stage: `qa%` employee id prefix + verify 0 rows).
- **Commander change** (`scripts/qa-commander.cjs`, ~10 lines): add a 5th stage `invariants`
  between `rbac` and `db`, run via `runHarness()` with its own server restart (login limiter),
  stage report line `[invariants] … pass / … fail`.
- Existing `db` stage stays as the WARN-only leftover scan (rename responsibility: hygiene).
- **Targets:** hermetic **only**. Live target skips invariants (they write data; live role
  probes already cover the approved throwaway-user flow and stay the only live writer).
- Expected count: ~23 assertions (L5 + A3 + P4). `node --check` both files; full commander
  run re-verified green afterwards (target: 50/50 + invariants green).

## 4. Decisions (⚠, approval recorded 2026-10-09 via "go forward until project complete")

- **D1** Distinct-month leave counting is the intended domain model — the invariant encodes
  it and catches day-counting regressions, rather than "fixing" the model.
- **D2** New `invariants` stage, not a rewrite of the `db` stage (hygiene stays separate).
- **D3** Payroll assert structural integrity + arithmetic on seeds, not real salary math
  (payroll amounts are org-config data; the formula contract is what's lockable).
- **D4** Invariants run hermetic-only; never against the live DB without the approved
  throwaway flow.

## 5. Verification record
- [ ] `node --check scripts/qa-db-invariants.cjs scripts/qa-commander.cjs`
- [ ] `npm run qa` → 50/50 regression+rbac **plus** invariants N/N green, zero leftovers
- [ ] Report + exit code 0; `qa/report.json` reflects the new stage
- [ ] AGENTS.md §11 + this doc updated; commit + push to `master` (atomic)
- [ ] Post-deploy: live smoke re-run (invariants hermetic-skipped on live — expected)

## 6. As-built notes (harness validation, 2026-10-09)

Four lessons from the first hermetic validation rounds — each is a class of false-fail the
harness itself had to be protected from:

1. **pg returns `COUNT`/`SUM` as strings** (`used_days: "0"`, `pending_days: "0"`). Every
   balance comparison must `Number()`-wrap. Strict `=== 1` against a pg aggregate always fails.
2. **The apply overlap rule is per-employee across ALL leave types** (leave.js:98-106 filters
   only `employee_id + status`, not `leave_type_id`). The quota-exhaustion case (L4) therefore
   cannot reuse a month already consumed by the primary leave type — it uses **next-year
   Jan/Feb** (fresh, overlap-free, both future) with a throwaway quota-1 leave type.
3. **Every non-admin employee is auto-assigned to the admin as secondary reporting manager**
   (approvalRouting.js:25-26). A throwaway employee without `secondary_reporting_manager_id`
   gets 400 "No reporting manager assigned" on EVERY apply — the harness seeds it with the
   admin's id to match the product's own policy.
4. **Payroll `net` is attendance-prorated while `gross_salary` stays full** — no
   `net = gross − deductions` identity exists (see §2 P). Only the by-construction identities
   are asserted. Also: a rapid check-in→break→check-out API flow is a ~0-second shift, so the
   hours invariant on that row is "never negative, ≤ 24h", not a big-shift sanity value.

## 7. Status
- **2026-10-09:** design written; grounded in leave.js:419-451, schema.sql:99-228,
  break-finalize harness. Implementation in validation: `qa-db-invariants.cjs` + `invariants`
  commander stage wired; iterations 1-2 of hermetic validation fixed the four as-built notes
  above. Final green run + atomic commit + full `npm run qa` regression is the next step.