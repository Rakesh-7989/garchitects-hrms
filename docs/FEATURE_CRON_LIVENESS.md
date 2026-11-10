# FEATURE — Cron Liveness & Hardening (2026-11-10)

> **TL;DR** — All six Vercel cron jobs in this project had **never executed in
> production** (they were silently dead since the first deployment). This release
> (a) hardens the cron guard against the two documented Vercel failure modes,
> (b) adds a **liveness heartbeat** so a dead cron is *visible* instead of
> invisible, (c) rewrites the QA harness so a green suite can no longer coexist
> with six dead crons, (d) surfaces the health of every scheduled job on the
> admin dashboard, and (e) **finds and fixes the real root cause: the
> `CRON_SECRET` the dispatcher sent did not match the one the deployment read.**
> The dead DNS record for the custom domain looked like the cause and turned
> out to be a **red herring** — Vercel dispatches the schedule to the
> production *deployment*, not to the custom domain (§1.4).

---

## 1. The defect (proven, not inferred)

### 1.1 Evidence in the production database

Read-only inspection of the live Supabase DB (no writes) on 2026-11-10:

| Cron (`vercel.json`) | Schedule | Evidence that it never ran |
|---|---|---|
| `purge-photos` | `0 3 * * *` | `attendance_photos`: 216 rows, **206 already expired** (`expires_at < now()`), oldest expiry `2026-10-02 09:51`. `viewed = 1` count = **0** — the job deletes `expires_at < NOW() OR viewed = 1`, so it deleted **nothing, ever**. |
| `expire-announcements` | `0 4 * * *` | `announcements`: 2 rows with a past `expires_at` (`2026-11-06 09:15`, `2026-11-07 12:30`) still `is_active = 1`. `is_active = 0` count = **0** — the job has never flipped a single row. |
| `sweep-late` | `0 16 * * *` | `attendance` rows with `status = 'late'` and `date < current_date`: **9** (Oct 5, Oct 7, Oct 12, Oct 22, Oct 24 ×2, Nov 2 ×2, Nov 9); 8 of them have **no** `late` justification at all, so the sweep would have flipped them to `absent`. |
| `auto-attendance` | `30 2 * * *` | `attendance_mark_absent` audit rows exist **only** from the admin manual route (`server/routes/attendance.js:603,611`). The cron path (`server/services/attendanceAutoMark.js:110`, notify type `attendance_marked_absent`) has **0 notifications all-time**, and no `attendance` row carries the `Auto-marked absent%` remark the cron writes. |
| `auto-checkout` | `45 15 * * *` | `attendance_auto_checkout` audit rows stop at `2026-11-03 16:08` and match the **lazy read-path** (`runAutoCheckout()` called from `GET /attendance/my` and `GET /attendance/all`), not a schedule. `auto_checkout` rows = 16, last `2026-11-03`. |
| `expire-handovers` | `30 4 * * *` | No `team_handovers` row in the live DB is in `status = 'ended'`. |

**Business impact:** GA0009 (Navya, active since 2026-10-01) has only 8
attendance rows (Oct 1–10) and **0 rows for 7 November workdays**; GA0003 and
GA0006 are each missing 2 workdays. Nothing in the product ever told anyone —
the QA suite was green.

### 1.2 The first hypothesis (and why it was only part of the story)

Vercel Cron dispatches to the **production deployment** of the project. This
project's production *domain* is the custom domain **`hrms.garchitects.in`**,
which has **no DNS record**:

```
hrms.garchitects.in  →  NXDOMAIN
  Google 8.8.8.8      →  NXDOMAIN   (re-verified 2026-11-10, Status 3)
  Cloudflare 1.1.1.1  →  NXDOMAIN
  authoritative NS dns1.p02.nsone.net → NXDOMAIN
curl https://hrms.garchitects.in/...  →  exit 6 (could not resolve host)
```

The apex `garchitects.in` resolves (A `52.74.6.109`, `13.215.239.219`; NS
`dns1-4.p02.nsone.net` — **Netlify** DNS, not Vercel) but there is **no `hrms`
record** on it. Vercel's own domain config reports the apex as
`misconfigured: true` with `recommendedCNAME: cname.vercel-dns.com`.

Secondary factor: the project has `ssoProtection { enabled: true,
deploymentType: 'all_except_custom_domains' }`, so the *per-deployment* URL
answers **302 → vercel.com/sso-api** for the cron path, and Vercel Cron **does
not follow redirects** (*"Cron jobs do not follow redirects… Redirect responses
are treated as final for each invocation"*).

**This looked like the root cause — and it turned out to be wrong.** The
heartbeat added by this release proved it: the first recorded invocation
arrived with `source = "vercel-cron"` and the correct `x-vercel-cron-schedule`
header, i.e. **Vercel reached the app even with the custom domain dead**.

### 1.3 The real root cause: a `CRON_SECRET` mismatch

The first rejected invocation was recorded as:

```
auto-checkout | last_run_at 2026-11-10 15:51:27 | last_status "unauthorized"
               | source "vercel-cron" | schedule "45 15 * * *"
               | {"reason":"CRON_SECRET mismatch or missing"}
```

So the dispatcher *did* call the app and *did* send an `Authorization` header —
the header simply did not match `process.env.CRON_SECRET`. The failure modes
that survive a trim fix are:

* a **newline inside** the secret (Node's HTTP parser truncates the header at
  the line break → the app receives a shorter token than it expects), or
* the deployment and the dispatcher **holding different values** (the env var
  was edited after the build; Vercel notes that *"Editing CRON_SECRET in
  project settings changes nothing until your next deployment"*).

**The fix:** rotate the project secret to a clean, whitespace-free value and
let the next deployment capture it. `CRON_SECRET` only ever gated the six
`/api/cron` endpoints (no user-facing impact) and the previous value was
proven broken, so rotating it is strictly an improvement.

**Verified after the rotation + redeploy** (2026-11-10 16:51 UTC):

| Job | Result |
|---|---|
| `auto-attendance` | 200 — **marked 47** absent days (the 30-day lookback) and notified 47 employees |
| `expire-announcements` | 200 — **expired 2** |
| `expire-handovers` | 200 — 0 (nothing to end) |
| `purge-photos` | 200 — **deleted 208** expired photos |
| `auto-checkout` | 200 — 0 open days to close |
| `sweep-late` | 200 — **absented 9** unjustified late rows |

Afterwards: `expired photos left = 0`, `expired announcements left = 0`,
`stale late rows left = 0`, `attendance_marked_absent` notifications = 47, and
every heartbeat reads `last_status = "ok"`, `source = "vercel-cron"`. The live
sweep's cron-liveness probe went from **red** to **green**
(`stale=[] failing=[] never_ran=[]`).

> **Note on the DNS:** `hrms.garchitects.in` still does not resolve. That is
> **not** what stopped the crons — but it *does* mean anyone typing the
> branded URL gets nothing, so the record is still worth adding at the
> registrar for the users' sake.

### 1.4 Why QA never caught it

`scripts/qa-cron.cjs` asserted only "401 without a secret" and "200 with a
secret" — and it **skipped the second half entirely** when `CRON_SECRET` was
not set in the local environment. The whole suite therefore passed **89/89**
while every production cron was dead. `docs/QA_FULL_SYSTEM_REPORT_2026-11-06.md`
recorded "All 6 cron endpoints without secret → 401" and stopped there: a
guard test, not a liveness test.

---

## 2. What shipped

### 2.1 Guard hardening — `server/routes/cron.js`

Vercel documents two failure modes that make a cron silently 401 on **every**
invocation. Both are now handled:

1. **A secret with surrounding whitespace / line breaks.** "If the header
   doesn't match the value your code reads, your endpoint returns 401 for every
   invocation." A secret pasted into the Vercel dashboard with a trailing
   newline therefore killed the entire schedule with no error anywhere. The
   comparison now **trims both sides** before comparing.
2. **The bearer scheme is case-insensitive** (RFC 7235) — `bearer <secret>` is
   now accepted, not just `Bearer <secret>`.

Plus a defence-in-depth change: the secret is compared with
`crypto.timingSafeEqual` on length-checked buffers instead of `===`, so the
compare is not short-circuiting on the first mismatch.

**Still fail-closed:** with no `CRON_SECRET` configured every cron answers 401.

### 2.2 Liveness heartbeat — new `cron_runs` table

Every cron run now records one row per job:

| Column | Meaning |
|---|---|
| `job` | primary key — one row per scheduled job |
| `last_run_at` | when the job last executed (success **or** failure), stored in UTC |
| `last_success_at` | when it last completed successfully |
| `last_status` | `ok` \| `error` \| `unauthorized` |
| `last_result` | JSON summary (counts only, no payloads) |
| `duration_ms` / `source` | runtime + `vercel-cron` \| `manual` |

Table added to **all three schema layers** (AGENTS.md §5):

* **A — `server/schema.sql`** (fresh installs)
* **B — `server/index.js`** startup migration (existing databases, every boot)
* **C — `server/utils/schemaRepair.js`** `ENSURE_TABLE_DDL` (lazy self-heal on
  a cold instance, so a cron never silently loses its heartbeat)

Two details worth naming:

* The heartbeat is written with `(NOW() AT TIME ZONE 'UTC')`, so the stored
  value is UTC **regardless of the database session timezone** and can be
  compared directly with a Vercel (UTC) schedule.
* The heartbeat write is best-effort — it can never turn a working cron into a
  500.
* A **rejected** Vercel invocation is recorded as `last_status =
  'unauthorized'`. It is only recorded for requests that carry Vercel's own
  markers (`x-vercel-cron-schedule`, `x-vercel-cron`, or a `vercel-cron/*`
  user agent), and the statement itself carries the throttle
  (`ON CONFLICT … DO UPDATE … WHERE last_status <> 'unauthorized' OR last_run_at
  < now() - 10 minutes`), so a stranger hammering the endpoint cannot turn the
  401 path into a write amplifier and the throttle needs no in-memory state
  (it survives a serverless cold start). This is what separates *"the
  scheduler never called us"* from *"the scheduler called us and we rejected
  it"*.

### 2.3 `GET /api/cron/health` — admin-only liveness surface

`verifyToken` + `isAdmin`. Deliberately **not** `CRON_SECRET`-gated: the
founder must be able to *see* that a job is dead without holding the secret.

```jsonc
{
  "success": true,
  "healthy": false,
  "stale_after_hours": 26,
  "stale_jobs": ["purge-photos", "sweep-late"],
  "failing_jobs": [],
  "jobs": [
    { "job": "purge-photos", "schedule": "0 3 * * *",
      "last_run_at": "2026-11-10 03:00:04", "last_status": "ok",
      "age_hours": 3.1, "never_ran": false, "stale": false, "failing": false }
  ]
}
```

* Every job in the registry is listed — including jobs that **never ran** — so
  "scheduled but never fired" is distinguishable from "not scheduled".
* `stale` = never ran, or the last run is older than **26 h**. Vercel Hobby
  cron precision is ±59 min, so two consecutive daily runs of a healthy job are
  23 h–25 h apart; 26 h leaves an hour of slack.
* Timestamps are rendered with `to_char` (raw UTC strings) on purpose —
  node-postgres parses a `TIMESTAMP` column into a JS `Date` at *local*
  midnight, which silently shifts the value by the host offset (the same class
  of bug as the `dateOnly` fix). The age is computed by Postgres itself
  (`NOW() - last_run_at`), so it is correct on any host.

### 2.4 Scheduler ↔ route parity — `server/config/cronJobs.js`

New single source of truth listing job → path → schedule. `vercel.json` holds
the schedule (Vercel reads JSON, not JS), so the two must agree — and now the
QA suite **asserts** that they do, plus that every scheduled path is actually
implemented in `server/routes/cron.js`. A scheduled-but-unrouted job fails
silently; that class of bug is now impossible to merge unnoticed.

### 2.5 Admin dashboard — "Scheduled Jobs" card

`public/pages/admin/dashboard.html` gains a **Scheduled Jobs** card (admin
portal only) showing each job, its schedule, its last run and a status badge
(`OK` / `Not run recently` / `Never ran` / `Last run failed`). A stale or
never-run job turns the badge red.

`public/sw.js` cache name bumped **v18 → v19** (AGENTS.md §8).

### 2.6 QA — the harness that can no longer be fooled

`scripts/qa-cron.cjs` was rewritten from 2 assertions to **33**, and the QA
commander now boots the app server **with a `CRON_SECRET` for that harness
only** (every other boot keeps `CRON_SECRET` empty, so the RBAC matrix's
"cron without a secret → 401" rows still hold). The harness now fails loudly
if no secret is available instead of silently skipping the authorized half.

New assertions:

* fail-closed: 401 with no secret, with a wrong secret, and with a
  **same-length wrong** secret;
* header hygiene: whitespace-padded secret → 200, lower-case `bearer` → 200;
* **the rejected-invocation path**: a request carrying Vercel's cron marker
  with a wrong secret → 401 **and** a heartbeat of `last_status =
  'unauthorized'` carrying the cron expression; a plain (non-Vercel)
  unauthorized request → **no** heartbeat write;
* **real side effects**: the forgotten check-out is closed
  (`check_out` + `auto_checkout = true`), the expired announcement is
  deactivated, the past handover is ended, the unjustified `late` row becomes
  `absent`, the expired photo is deleted, the missing check-ins are marked
  absent and each newly-marked employee is notified;
* **liveness**: all six jobs wrote a heartbeat, every heartbeat is `ok`, the
  admin health endpoint reports all jobs fresh + healthy, and an **employee**
  gets 403 on the health endpoint;
* **parity**: `vercel.json` ≡ `server/config/cronJobs.js`, and every scheduled
  path exists in `server/routes/cron.js`.

The harness rolls its world back (including the exact rows `auto-attendance`
added) so the database stays pristine, and it is **deterministic on repeat
runs** (verified: three consecutive runs, 33/33 each).

### 2.7 Live sweep + focused liveness probe — `scripts/qa-live-sweep.cjs`, `scripts/qa-cron-health.cjs`

New, read-only, credential-free sweep of the deployed app: 239 API routes
(anonymous → 401, no 2xx/5xx leak), 39 static pages, 37 clean portal URLs,
security headers on HTML + API, CORS fail-closed / allowed-origin echo,
malformed JSON → 400, unknown route → 404, invalid bearer → 401, and the six
cron endpoints fail-closed.

With `QA_LIVE_ADMIN_ID` / `QA_LIVE_ADMIN_PW` set it additionally logs in as an
admin and probes **`GET /api/cron/health`**, failing the sweep if any scheduled
job is stale or failing (skipped, not failed, without credentials). This is the
check that will turn red the moment a cron dies again.

`scripts/qa-cron-health.cjs` (`npm run qa:cron-health`) is the focused version —
it prints one line per job and explains the two possible causes:

```
  ✖ purge-photos  0 3 * * *  last_run=never  never_ran=true stale=true
  6 job(s) are NOT running. If every job says "never ran", Vercel Cron cannot
  reach the production domain - check the DNS record for the custom domain.
  If a job says "rejected", CRON_SECRET does not match what the deployment expects.
```

It exits **1** while any job is stale, so it can be wired into a monitoring
loop once the DNS is fixed.

---

## 3. Verification

| Gate | Result |
|---|---|
| `npm run qa` (hermetic, all stages) | **91/91 green** — 11 harnesses (cron harness now 33 checks, was 2), 279 RBAC cell probes, 43 DB invariants, zero leftovers |
| `node scripts/qa-cron.cjs` (standalone, verbose) | **33/33 green** — every side effect, the rejected-invocation path, the heartbeat and the parity asserted individually; 3 consecutive runs identical |
| `node scripts/qa-inline.cjs` | **39/39 pages clean** (admin dashboard inline JS) |
| `node scripts/qa-reg-review.cjs` (standalone) | **18/18 green** (owns its own stack; exercises `auto-attendance` + notifications) |
| `node scripts/qa-live-sweep.cjs` (production, read-only) | **13/13 green** — 239 API routes + 39 pages + 37 clean URLs probed, cron liveness skipped (no admin creds in CI) |
| `node --check` on every changed server/script file | clean |

One QA-tooling defect was found and fixed while building this: the commander
skipped the canonical `schema.sql` load whenever **anything** was already
listening on :3000 — so a leftover app server pointing at a freshly
initialised (empty) cluster left the whole suite running against 4 tables
(the ones the startup migration recreates on its own). The schema is now
loaded whenever the run created the cluster, regardless of :3000.

### 3.1 Post-deploy verification (live, 2026-11-10)

Pushed to `master` → Vercel production deploy `dpl_J9TCnhsoFsAyWg774ZnxitX1sAzJ`
(commit `f674f55`), READY. Verified against the deployed app:

| Probe | Result |
|---|---|
| `GET /api/cron/health` (no token) | **401** — the route exists and is JWT-gated (it was 404 before the deploy) |
| `GET /api/cron/health` (admin) | **200** — 6 jobs, `healthy: false`, all `never_ran: true`, `stale: true` |
| `GET /admin/dashboard` | **200**, "Scheduled Jobs" card present in the HTML |
| 6 × `GET /api/cron/<job>` (no secret) | **401** — still fail-closed after the deploy |
| production DB | `cron_runs` table **exists** (8 columns, created by the startup migration), **0 heartbeat rows** |
| production DB (pending damage, unchanged) | 208 expired photos, 2 expired announcements still active, 9 stale `late` rows |

**This is the intended end state for now**: the alarm is armed and reads red,
and it will turn green by itself the moment the DNS record exists — the first
successful cron run writes the heartbeat and the card flips to "OK". The
damage is left for the crons to self-heal (owner decision, 2026-11-10).

**Read-only live re-confirmation of the defect** (production DB, 2026-11-10):
206 expired photos undeleted · 2 expired announcements still active · 9 stale
`late` rows · 0 `attendance_marked_absent` notifications all-time · 0
`team_handovers` rows in `status = 'ended'`.

---

## 4. Status: RESOLVED (2026-11-10, 16:51 UTC)

| # | Item | State |
|---|---|---|
| 1 | **The `CRON_SECRET` mismatch** | ✅ **FIXED** — the project secret was rotated to a clean 64-char hex value and the next deployment captured it (§1.3). All six jobs now answer **200** and every heartbeat reads `last_status = "ok"`, `source = "vercel-cron"`. |
| 2 | **The backfill** | ✅ **DONE** (the founder's decision was "let the crons self-heal") — the first successful run marked **47** missing workdays absent (with a notification per employee), purged **208** expired photos, deactivated **2** expired announcements and swept **9** unjustified `late` rows. Payroll rows were 0, so no payslip had been computed from the incomplete attendance. |
| 3 | **The `hrms` DNS record** | ⬜ **Still open — but NOT a cron blocker.** `hrms.garchitects.in` does not resolve; Vercel dispatches the schedule to the production *deployment*, so the crons run fine. The record is still worth adding at the registrar (`hrms CNAME cname.vercel-dns.com` at `dns1-4.p02.nsone.net`) so the **branded URL works for your users**. |

The **alarm that proves it** — `npm run qa:cron-health`:

```
healthy=true  stale_after_hours=26
  ✔ auto-attendance        30 2 * * *   last_run=2026-11-10 16:51:41 (0.02h ago) status=ok
  ✔ auto-checkout          45 15 * * *  last_run=2026-11-10 16:51:42 (0.02h ago) status=ok
  ✔ purge-photos           0 3 * * *    last_run=2026-11-10 16:51:42 (0.02h ago) status=ok
  ✔ expire-announcements   0 4 * * *    last_run=2026-11-10 16:51:41 (0.02h ago) status=ok
  ✔ expire-handovers       30 4 * * *   last_run=2026-11-10 16:51:42 (0.02h ago) status=ok
  ✔ sweep-late             0 16 * * *   last_run=2026-11-10 16:51:42 (0.02h ago) status=ok
  All scheduled jobs are running.
```

---

## 5. Files touched

| File | Change |
|---|---|
| `server/routes/cron.js` | hardened guard, heartbeat writer, `cronHandler` wrapper, `GET /api/cron/health` |
| `server/config/cronJobs.js` | **new** — job registry + staleness window |
| `server/schema.sql` | `cron_runs` (layer A) |
| `server/index.js` | `cron_runs` startup migration (layer B) |
| `server/utils/schemaRepair.js` | `cron_runs` lazy self-heal (layer C) |
| `scripts/qa-cron.cjs` | rewritten — 2 → 33 assertions, real side effects |
| `scripts/qa-cron-health.cjs` | **new** — focused live liveness probe (`npm run qa:cron-health`) |
| `scripts/qa-commander.cjs` | per-harness server env (`CRON_SECRET` for the cron harness only), fail-closed baseline, schema-load fix |
| `scripts/qa-live-sweep.cjs` | **new** — live read-only sweep + optional cron-liveness probe |
| `package.json` | `qa:cron-health`, `qa:live-sweep` scripts |
| `public/pages/admin/dashboard.html` | "Scheduled Jobs" card + loader |
| `public/sw.js` | cache v18 → v19 |
| `docs/FEATURE_CRON_LIVENESS.md` | this document |
| `AGENTS.md`, `qa/triage.md` | state + finding ledger |
