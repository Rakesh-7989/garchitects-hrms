# Privacy, Security & SDLC Plan — G-Architects HRMS

**Status:** Proposed (awaiting owner sign-off on decisions marked ⚠)  
**Branch:** `audit/privacy-security-baseline` (created from `master` @ `8518f37`)  
**Ref:** "HRMS Compliance, Security & SDLC Blueprint" (audit snapshot 18 Oct 2026)  
**Parent docs:** `AGENTS.md` (repo operating manual), `qa/triage.md` (Sprint-1 audit ledger), `server/schema.sql`

---

## 1. What is being asked (restated)

Upgrade the existing G-Architects HRMS in controlled SDLC phases:

1. **First** — verify the live system and protect sensitive HR data (PAN/Aadhaar/passport, bank, salary, attendance photos, payroll, OTP/reset records, audit logs).
2. **Then** — fix live application defects.
3. **Then** — document privacy/legal requirements and implement consent UX.
4. **Then** — improve accessibility.
5. **Finally** — release only after role-based regression tests.

Priority order per the blueprint: protect sensitive data → resolve live defects → policy/consent UX + accessibility → release through SDLC gates.

**Hard constraints (from blueprint §1 / AGENTS.md §10):**
- Do NOT blindly enable RLS across all tables.
- Do NOT change production schema without a backup + migration + rollback plan.
- Do NOT put secrets in frontend files.
- Do NOT publish unverified legal promises or invent penalties (e.g. no $100,000 consent charge).
- This plan is engineering guidance, not legal advice — Indian counsel must validate policies before publishing.

---

## 2. Current state (deep-dive complete, 18 Oct 2026)

### Repository & deployment
- `origin` = `https://github.com/Rakesh-7989/garchitects-hrms.git`, branch `master`.
- Local HEAD `8518f37` == `origin/master` (ahead of the blueprint's "latest inspected" `e56eefe`).
- Working tree clean; on new branch `audit/privacy-security-baseline`.
- Vercel project `garchitects-hrms`, READY production deployment linked to `master`.
- Supabase project `garchitects-hrms` (ref `wnuozsytcbjpzdvvnlfc`, region `ap-south-1`, `ACTIVE_HEALTHY`) — used as plain PostgreSQL hosting.

### Architecture (confirmed by source read)
- **Backend**: Node.js + Express, raw `pg` pool via `DATABASE_URL` — NOT Supabase PostgREST/anon key for API data.
- `@supabase/supabase-js` is used **only** in `server/services/storage.js` for file uploads (Supabase Storage, service-role key `SUPABASE_SERVICE_KEY`, server-side only).
- 35 route modules mounted in `server/index.js`; all guarded with `verifyToken`; 9 deliberately public (auth flows + cron, fail-closed on `CRON_SECRET`).
- Three-layer schema convention: (A) `server/schema.sql`, (B) startup `runMigrations()` in `server/index.js`, (C) lazy `server/utils/schemaRepair.js`.
- Existing QA: `npm run qa` hermetic (50/50 green on `master`), live smoke 12/12. QA commander + RBAC matrix (`qa/rbac-matrix.json`, 34 rows) exist.

### Sprint-1 audit (qa/triage.md) — all 36 findings resolved
0 high / 0 medium / 0 low open. Remaining: contract F4 (16 modules zero coverage) QUEUED Phase 2; security F13 (in-memory rate limit) & F15 (login status oracle) accepted by owner.

### Known live runtime errors (from blueprint §2)
All three appear **already fixed** in current HEAD:
1. `dateOnly is not defined` in `projects.js` — `dateOnly` is imported at line 5 and used at lines 90/91/96/97/127/128/263/264/289/290/342/343.
2. team-updates SQL `integer = date` mismatch — route uses `$1::date` casts throughout (lines 102, 117, 138, 143, 287, 291, 300, 304, 309, 311, 369, 375, 377, 384, 391).
3. audit-log write timeouts — `query()` shim + global handler; no obvious open defect found.

No regression test currently covers these. They must be covered before calling the release stable.

### Security advisor signal (critical exposure-risk)
Supabase security advisor reported **42 "RLS Disabled in Public"** public-schema tables, including `employees`, `payroll`, `attendance`, `attendance_photos`, `documents`, `password_reset_otps`, `leave_applications`, `wfh_requests`, `audit_logs`. This does NOT prove anonymous internet access (the app connects via `pg` as a service role), but it is a critical signal that must be tested and remediated table-by-table before adding features.

---

## 3. Phase plan & change set

### Phase 0 — Discovery & baseline (complete) ✅
- Cloned repo, inspected branch/commit, read QA audits, inventoried routes/tables/vendors.
- Confirmed Supabase project healthy, Vercel production READY on `master`.
- Confirmed `dateOnly`/`team-updates`/audit defects already fixed in HEAD; need regression coverage.
- Delivered: this plan + branch `audit/privacy-security-baseline`.

### Phase 1 — Critical risk containment (Days 3–5) ⏭️ next

**Goal:** Test/remediate the 42 RLS-disabled tables; fix/verify runtime errors; add regression tests; reviewed migration + rollback plan.

**Change set:**
1. `scripts/db-backup.cjs` (new) — one-off verified backup of the Supabase PG via `pg_dump`/`pg_dumpall` to `backups/` (gitignored); restore smoke in a throwaway local PG.
2. `scripts/rls-map.cjs` (new) — read-only inventory: for each public table, record RLS enabled/disabled, existing policies, grants, and access path (backend `pg` / direct Supabase JS / cron). Read-only, no writes.
3. `server/migrations/` (new dir) — reviewed, additive-only RLS enablement migration(s) with explicit per-table policy intent + rollback `DROP POLICY` / `ALTER TABLE ... DISABLE RLS` statements.
4. `server/index.js` — gate RLS migration behind `schema_migrations` ledger (one-time, like the existing reshape block), additive `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` + `CREATE POLICY`.
5. Add regression coverage for the 3 runtime errors into the QA harnesses (`scripts/qa-commander.cjs` regression stage).
6. Verify server-side role isolation: employee cannot read another's payroll/docs/photos; manager tree-scoped; HR read-only on projects module; anon denied on sensitive tables.

**Decisions (⚠ — need sign-off):**
- ⚠ **D1:** Which database role the backend `DATABASE_URL` connects as (superuser vs non-superuser). If superuser, RLS is bypassed by the app — the remediation is about defense-in-depth + preventing direct PostgREST/anon access, not app behavior. Confirm before enabling RLS.
- ⚠ **D2:** Table-by-table policy design (which tables get `ENABLE RLS`, which roles can read/write). Start with the most sensitive: `employees` (PII/salary/bank), `payroll`, `documents`, `attendance_photos`, `password_reset_otps`, `audit_logs`. Less sensitive (`holidays`, `announcements`, `companies`) may stay RLS-off with app-layer enforcement — document why.
- ⚠ **D3:** Whether to enable RLS on `employees` for the app's own `pg` service role (could break server queries if the role isn't a table owner / bypass). If the service role owns tables, RLS doesn't apply to it anyway — policies would only protect direct anon/PostgREST access.

**Blast radius:** Medium. RLS misconfiguration can break server reads/writes (500s). Mitigation: apply to staging DB first, test positive/negative access per role, keep rollback SQL ready, gate behind one-time migration ledger.

**Exit criteria:** Backup verified + restore tested; RLS map recorded; reviewed migration applied to staging; role-isolation tests pass (employee A ≠ employee B data; anon 403 on sensitive tables); rollback SQL documented; regression tests for the 3 runtime errors added and green.

### Phase 2 — Product & policy requirements (Week 2)

**Goal:** Approve data purposes/lawful bases with counsel; decide necessary fields; define retention; verify vendors/embeds/cookies; draft policies.

**Change set:**
1. `DATA_INVENTORY.md` (new, in `docs/`) — per-field record: element, source/form, required/optional, purpose, lawful basis, who can view/edit, recipients/vendors, storage, retention, deletion, export route, severity. Mark each field "confirmed collected" / "schema available only" / "not used".
2. Vendor/embed inventory — grep source + built HTML for external scripts, iframes, fonts, analytics, maps, CDN, storage. Confirm Supabase Storage (photos/documents), SMTP/email, web-push, Vercel logs.
3. Draft policies (counsel review before publish):
   - `docs/POLICY_PRIVACY.md` (public, versioned)
   - `docs/POLICY_EMPLOYEE_NOTICE.md` (HR-specific, attendance photos/location)
   - `docs/POLICY_TERMS_ACCEPTABLE_USE.md`
   - `docs/POLICY_COOKIE_LOCALSTORAGE.md` (only if non-essential storage exists)
   - `docs/POLICY_RETENTION_DELETION.md` (internal)
   - `docs/POLICY_INCIDENT_RESPONSE.md` (internal)
   - `docs/POLICY_VENDOR_REGISTER.md` (internal)
   - Refund policy — mark "Not applicable" (internal HR tool, no payments) unless owner confirms otherwise.

**Decisions (⚠):**
- ⚠ **D4:** Which fields are truly necessary (e.g. Aadhaar/passport — collect only if statutory purpose documented). Fields without a purpose → drop from forms or mark optional.
- ⚠ **D5:** Retention periods per category (payroll statutory vs attendance photos vs OTPs vs audit logs).
- ⚠ **D6:** Whether to publish a cookie/local-storage banner — only if non-essential storage is confirmed.

**Blast radius:** Low (documentation + drafting). No code changes except possibly removing unused fields/forms.

### Phase 3 — Consent & accessibility (Week 3)

**Goal:** Versioned notices, optional consent controls, attendance camera/location notice, withdrawal/exception workflow, keyboard/labels/alt-text/contrast/clear errors.

**Change set:**
1. New table `consent_records` (id, user_id, notice_key, notice_version, purpose, choice granted/declined/withdrawn/acknowledged, timestamp, method, notice hash/version, locale, withdrawal_timestamp) — added to all 3 schema layers (A/B/C).
2. `POST /api/consent/record` + `GET /api/consent/mine` routes (server-side write only; append audit event; no client-forgable fields).
3. Attendance check-in notice modal (camera selfie + location permission at invocation time only; explains what is stored, who can view, retention, exception/manual-review path if permission fails).
4. Privacy/consent links on login + footer; consent version captured at first use.
5. Accessibility fixes across portal pages: alt text, labels, focus order, contrast, error summaries, keyboard navigation.
6. Withdrawal flow where consent is the lawful basis; refusal must not silently block unrelated HRMS functions.

**Decisions (⚠):**
- ⚠ **D7:** Is camera/location truly required for attendance, or optional? If required, document the exception/manual-review workflow (per blueprint §4).
- ⚠ **D8:** Which processing is genuinely consent-based vs employment-processing (another lawful basis) — counsel advice.

**Blast radius:** Medium (new table + routes + UI modals). Schema change → all 3 layers + migration.

### Phase 4 — Regression & release hardening (Week 4) ⏳ IN PROGRESS

**Goal:** Expand API↔UI contract tests + RBAC matrix across all route modules; add tests for WFH/tickets/documents/letters/project-access/transfers/handovers/cron; run QA; test backup/restore; inspect headers/CORS/secrets.

**Progress:**
- ✅ RBAC matrix expanded to cover all 35 modules (was 18 modules / 34 rows → now 35 modules / 58 rows). Closed audit-contract.md F4 (16 modules previously had zero coverage: auth, cron, daily-work-logs, letters, project-access, project-documents, project-leads, project-reports, project-status-updates, project-updates, push, team-handovers, team-transfers, team-updates, tickets, wfh).
- ✅ `noTokenSweep` expanded to include cron endpoints (CRON_SECRET fail-closed → 401).
- ✅ `scripts/qa-inline.cjs` created + `npm run qa:inline` wired into package.json (syntax-gates all 39 portal pages' inline script blocks; 0 failures).
- ⬜ Business-logic harnesses for cron (job execution), auth (token_version revocation, SMTP-down forgot-password), and WFH/tickets approve flows.
- ⬜ Headers/CORS/secrets inspection; backup/restore exercise.
- ⬜ Full `npm run qa` hermetic pass + `qa:json` report.

**Change set:**
1. RBAC matrix rows for all previously-uncovered modules (committed to `qa/rbac-matrix.json`).
2. `scripts/check-inline-js.cjs` wired to a package script (syntax gate).
3. Headers/CORS/secrets inspection: confirm no secrets in client bundle; `ALLOWED_ORIGINS` set on Vercel; `NODE_ENV=production`.
4. Backup/restore exercise on a throwaway DB.
5. Full `npm run qa` hermetic pass + `qa:json` report.

### Phase 5 — Controlled release & monitoring

**Goal:** Merge via PR, deploy preview, smoke with test accounts, approve production, verify health/error logs, monitor 24–72h, document rollback.

**Change set:**
1. PR `audit/privacy-security-baseline` → `master` with code + `docs/` + tests.
2. Preview deploy → smoke: login, dashboard, attendance, leave, WFH, profile, projects, documents, payslips, each role's approvals (no production employee data in screenshots).
3. Production merge → smoke: health, auth, role boundaries, privacy links, consent version, forms, uploads/downloads, cron runs, logs.
4. Rollback plan documented (revert commit + rollback migration SQL).
5. Re-run Supabase security advisor after migrations; recurring monthly/quarterly review cadence.

**Exit criteria (Definition of done):**
- No known critical/high access exposure; RLS/grants reviewed table-by-table.
- No secrets in client bundle.
- Critical runtime errors fixed + regression tests.
- Every role passes positive and negative authorization tests.
- Privacy notice matches actual data flow; consent auditable/withdrawable where applicable.
- Accessibility checklist passed.
- Backups + rollback tested; policy owner sign-off.

---

## 4. Risk register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| RLS misconfiguration breaks server reads/writes | Medium | High | Staging-first; one-time migration ledger; rollback SQL ready; test per-role before promote |
| Direct anon/PostgREST access to sensitive tables | Medium | High | Confirm app role; enable RLS + policies; disable unnecessary public exposure |
| Production schema change without backup | Low | Critical | Mandatory `pg_dump` backup + restore test before any DDL; migration behind ledger |
| Legal/policy language unverified | Medium | Medium | Indian counsel review before publishing any policy; no invented penalties |
| Consent UX introduces UX friction / blocked attendance | Medium | Medium | Documented manual-review exception for camera/location refusal |
| Secrets leaked in Git/browser bundles | Low | Critical | Secret scan; `.env` gitignored; service-role key server-side only; rotate if ever committed |

---

## 5. Sign-off requested (decisions ⚠)

Please confirm before I implement Phase 1:

1. **D1** — Confirm the `DATABASE_URL` connection role (superuser or non-superuser), so RLS remediation is designed correctly.
2. **D2** — Approve starting RLS enablement on the most sensitive tables (`employees`, `payroll`, `documents`, `attendance_photos`, `password_reset_otps`, `audit_logs`) with app-layer enforcement on the rest.
3. **D3** — Confirm whether RLS policies should also constrain the app's own `pg` service role (likely no — the service role owns tables and bypasses RLS; policies protect direct PostgREST/anon access).
4. **D4–D8** — Policy/consent decisions (deferred to Phase 2/3; flag any you want decided earlier).

Once you sign off on D1–D3, I'll implement Phase 1: backup script, RLS mapping script, reviewed migration, regression test coverage, and role-isolation verification — all committed to `audit/privacy-security-baseline` for your review before any production change.
