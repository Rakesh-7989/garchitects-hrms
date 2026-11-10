# FEATURE — Consent UI + recent-activity fix (2026-11-10)

> **TL;DR** — While testing the attendance matrix in a real browser, the admin
> dashboard threw three JavaScript errors on every load. Chasing them exposed
> **four pre-existing defects that had disabled the whole consent/consent-gate
> feature** (shipped with the privacy phase): the consent API was called with a
> double `/api` prefix, the consent modal existed on only 2 of ~35 pages, the
> consent buttons were never bound to any handler, and the `purpose` column was
> `VARCHAR(100)` while a notice purpose is a 300+ character paragraph. The
> consent gate could therefore **never** be satisfied. All four are fixed, plus
> the missing `formatIstTime` helper that broke the dashboard's "Recent
> Activity" feed.

---

## 1. The three console errors (admin dashboard, every load)

| # | Error | Root cause |
|---|---|---|
| 1 | `ReferenceError: formatIstTime is not defined` at `admin/dashboard.html:389` | the helper was defined **only** in `admin/audit-logs.html:228`. The dashboard's "Recent Activity" feed rendered nothing (the whole `loadActivityFeed` map threw). |
| 2 | `GET /api/api/consent/mine → 404` | `apiCall()` already prefixes `API_URL = '/api'`; the consent calls passed `'/api/consent/mine'` and `'/api/consent/record'` → `/api/api/...`. |
| 3 | `TypeError: Cannot set properties of null (setting 'innerHTML')` at `auth.js:795` | the footer link `showConsentModal()` exists on **~35 pages**, but the `#consentModal` markup existed only on `login.html` and `employee/profile.html`. |

## 2. Two more defects found while fixing them

| # | Defect | Consequence |
|---|---|---|
| 4 | **The consent buttons were never bound.** `consentBtnConfirm` / `consentBtnSkip` had no `onclick` anywhere in the repo — `confirmConsents()` was defined but never called. | "I Agree & Continue" did nothing on **any** page. |
| 5 | **`consent_records.purpose` was `VARCHAR(100)`** while a notice purpose is a 300+ character paragraph → every `POST /api/consent/record` failed with Postgres **22001** ("One of the entered values is too long"). | Even with everything else fixed, the consent could not be recorded. The column is now `TEXT` on **all three schema layers** (fresh install / startup migration / lazy self-heal), plus an idempotent `ALTER TABLE consent_records ALTER COLUMN purpose TYPE TEXT` on every boot for existing databases. |

## 3. What shipped

**`public/js/auth.js`** (the shared client layer, loaded on every page)

* `formatIstTime(ts)` — moved here from `admin/audit-logs.html` (which no longer
  defines its own copy) so both the dashboard feed and the audit trail use one
  implementation.
* `apiCall()` gained an `opts.noRedirect` flag: an **optional** check that is
  allowed to come back empty no longer bounces the user to the login page on a
  401. The consent lookups use it (on the login page nobody is signed in, and
  a 401 there used to reload the page the user was already on).
* `checkConsentRequired()` returns the static required-notice list immediately
  when there is no token — no pointless request, no console 401.
* `ensureConsentModals()` — the consent + consent-management modals are
  **injected on demand** when a page does not carry the markup (instead of
  duplicating it into ~35 pages), and the buttons are bound:
  `consentBtnConfirm → confirmConsents()`, `consentBtnSkip`/`consentBtnClose`
  → close. Idempotent, and it also fixes the pages that carry their own
  (older) markup.
* `closeConsentModal()` / `closeConsentManageModal()` are null-safe.
* The three double-prefixed calls now use `/consent/mine` and
  `/consent/record`.
* `showConsentManageModal()` on an anonymous visitor shows a friendly toast
  ("Sign in to manage your consent choices.") instead of a failed fetch.

**Anonymous vs signed-in behaviour** (deliberate, and now honest):

| | Signed in | Not signed in (login page) |
|---|---|---|
| "Privacy Policy" | the modal with the pending notices **and** the radio choices; "I Agree & Continue" records them | the notices **read-only** with a Close button (nothing can be recorded before signing in) |
| "Manage Consent" | the recorded choices, with a Withdraw button | a toast asking to sign in |

**`server/schema.sql` + `server/index.js` + `server/utils/schemaRepair.js`**
— `consent_records.purpose` is `TEXT` on all three layers (§2, defect 5).

### 3.1 The production surprise: the startup migration was silently failing

After deploying, the **production** column was still `VARCHAR(100)`. The
Vercel runtime logs said why:

```
[Migration] Leave types migration skipped: Connection terminated due to connection timeout
```

The startup migration runs at module load on a cold Vercel instance against the
**Supabase transaction pooler** (port 6543), which closes idle connections. One
statement dying mid-run killed **the rest of that block** — the consent column
widening never landed, and nobody noticed because every migration failure is
only a `console.warn`.

Two systemic fixes:

* `server/config/database.js` — a connection-level error (`Connection
  terminated`, `timeout expired`, `ECONNRESET`, `EPIPE`, …) now **recycles the
  pool**, so the next attempt opens a fresh connection instead of failing the
  caller. This helps every request, not only the migrations.
* `server/index.js` — all **118** startup statements now go through a
  `migrate()` helper that retries a transient connection error up to 4 times
  (0.5 s / 1 s / 1.5 s backoff). Every statement is idempotent, so retrying is
  safe.

The production column was widened manually once (a non-destructive
`ALTER TABLE consent_records ALTER COLUMN purpose TYPE TEXT`) so the consent
gate works on production immediately; the migration now applies it by itself on
the next boot.

**Lesson worth keeping:** a startup migration that only warns is a silent
failure. The hermetic QA boots a local Postgres, so it never saw the pooler
problem — only the live runtime logs did.

**`public/pages/admin/audit-logs.html`** — the page-local `formatIstTime`
removed (single definition in `auth.js`).

**`public/pages/employee/profile.html`** — the double-prefixed
`apiCall('/api/consent/mine')` corrected.

**`public/sw.js`** — cache **v19 → v20**: `auth.js` is a cache-first static
asset in the service worker, so without the bump the fix would not have
reached users at all (this was observed live in the browser test).

## 4. Verification

**In Chromium (local hermetic stack):**

| Probe | Before | After |
|---|---|---|
| admin dashboard console errors | `formatIstTime is not defined`, `/api/api/consent/mine` 404, `showConsentModal` TypeError | **0 errors** |
| "Recent Activity" feed | empty (threw) | renders: `auth.login_success By UI Admin • employee #1 10 Nov 2026, 08:40:38 pm` |
| consent modal auto-open (signed in) | TypeError | opens with **6 notices / 9 choices** |
| "I Agree & Continue" | dead button | records all notices → *"Thank you. Your consent choices are recorded."* → modal closes |
| "Manage Consent" | TypeError | lists the recorded choices (notice key, purpose, choice, timestamp, Withdraw) |
| reload after consenting | — | the modal does **not** re-open (the gate is satisfied) |
| login page → "Privacy Policy" | 401 + page reload | opens read-only (5 notices, Close button), **no redirect**, **no console error** |
| login page → "Manage Consent" | 404 | friendly toast "Sign in to manage your consent choices." |

**Automated:** new `scripts/qa-consent-ui.cjs` (**22/22**) wired into the QA
commander as a regression stage:

* client contract (source level): no double-prefixed `apiCall('/api/…')`,
  `formatIstTime` defined once in `auth.js`, the consent modal injectable, the
  buttons bound, `closeConsentModal` null-safe;
* schema contract: `purpose` is `TEXT` in all three layers **and** the live
  column accepts a full notice paragraph (`character_maximum_length` is
  unlimited / > 300), the startup migration widens an existing database, the
  migrations retry a transient connection error, and a lost pooled connection
  is recycled;
* API contract: record with a full-length purpose → **201**, the purpose is
  stored intact, `GET /api/consent/mine` returns it, a second notice can be
  recorded, an unknown `notice_key` → 400, an invalid `choice` → 400, no token
  → 401.

Full hermetic `npm run qa`: **92/92 green** (12 harnesses, 279 RBAC cell
probes, 43 DB invariants, zero leftovers). `npm run qa:inline`: 39/39.

## 5. Files touched

| File | Change |
|---|---|
| `public/js/auth.js` | `formatIstTime`, `apiCall({noRedirect})`, `ensureConsentModals()`, button binding, null-safe close, corrected API paths, anonymous-user handling |
| `public/pages/admin/audit-logs.html` | page-local `formatIstTime` removed |
| `public/pages/employee/profile.html` | double-prefixed consent call fixed |
| `public/pages/admin/dashboard.html` | (no change needed — it only *called* the missing helper) |
| `public/sw.js` | cache v19 → v20 (auth.js is a cache-first asset) |
| `server/schema.sql`, `server/index.js`, `server/utils/schemaRepair.js` | `consent_records.purpose` → `TEXT` (+ idempotent ALTER on boot) |
| `server/config/database.js` | **new** — a lost pooled connection is detected and the pool is recycled |
| `server/index.js` | all 118 startup statements now retry a transient connection error |
| `scripts/qa-consent-ui.cjs` | **new** — consent records + consent UI contract harness |
| `scripts/qa-commander.cjs` | the new harness wired into the regression stage |
