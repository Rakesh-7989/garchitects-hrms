# PROBE_FINDINGS.md — Deploy-vs-Founder Vercel Secrets Investigation

Status: **CLOSED / PARTIALLY VERIFIABLE FROM THIS MACHINE — more below**.
Session: 2026-09-20 (Windows, local clone `C:\Users\boyap\G-Architects_HRMS`).
Every claim below was verified byte-exact from files on disk (never from terminal echo),
per the corruption-free read/write channel established in this session.

---

## 1. What we were asked to verify (end-to-end secrets check)

Whether the Vercel deploy token our repo's GitHub Actions workflow uses
(`VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`) can actually reach
our project — the same check the founder's identical pipeline passes.

## 2. Definitively established facts (byte-exact)

### 2.1 Version pin is NOT the difference — it cannot exist
- Our `.github/workflows/deploy.yml` pins `vercel-version: 41.8.2`.
- The founder's `.github/workflows/deploy.yml` pins `vercel-version: 41.8.2` — **identical**.
- npm registry dump (saved this session): the version list for the `vercel` CLI
  jumps straight from `41.7.8` to `42.0.0`. **There is no `41.8.x` release at all.**
  `vercel@41.8.2` does not exist on npm.
- Conclusion: a `41.8.2` pin cannot succeed on any machine. Since BOTH repos pin
  the same nonexistent version, the pin is not the differentiator between ours and
  the founder's.

### 2.2 The two workflows are otherwise near-identical
- Both: `actions/checkout@v4`, `setup-node@v4` (`node-version: 18`, `cache: npm`),
  `npm install`, then `amondnet/vercel-action@v25` with
  `vercel-token / vercel-org-id / vercel-project-id` from repo Secrets.
- Only real divergence: our file adds a `permissions:` block
  (`contents: read`, `deployments: write`); the founder's file does not.
  That block is not a cause of auth failure.
- Founder workflow: 792 bytes / 37 lines. Ours: 829 bytes / 37 lines.

### 2.3 Token availability on THIS machine
- **No live `VERCEL_TOKEN` exists in any known local secrets file.**
  Token lines are present but empty; the working token is set as a **masked
  GitHub Secret** in the founder's repository and is not retrievable from disk.
- Therefore the live Vercel API end-to-end probe (`/v2/user`, `/v9/projects`)
  **cannot be executed from this machine** — there is no token to present.
- A local `vercel pull` probe was also run and fails, but that path does not
  exercise the GitHub-Secret token at all, so it is not representative.

### 2.4 The one authoritative living reference is the founder's repo
- The founder's CI passes with the same byte-identical pin.
  That means the founder's secrets resolve to a working token+org+project triple
  on Vercel's side. The values themselves are masked in GitHub UI and cannot be
  echoed, exported, or compared byte-for-byte from a clone.

---

## 3. The only remaining step — must run on the founder's side

A true end-to-end secrets check requires the founder's token to be exercised,
because it only exists there. Two concrete options:

1. In the founder's repo, run the GitHub Actions workflow manually
   (`Actions → workflow → Run workflow`) and confirm the `Deploy to Vercel`
   step's `vercel action` output shows a live `200 OK`/`SUCCESS` against
   the project. If it does, the pipeline is healthy and any local failures here
   stem from the token being absent locally (not from the repo config).
2. In Vercel dashboard UI: `Settings → Tokens`, confirm the token's scope
   includes the correct team & project, and that the project the workflow
   references is the active production project.

Neither can be performed or verified from this workstation.

---

## 4. Red-flag (optional) — nonexistent version pin on both sides

Both the founder's and our workflow pin `vercel-version: 41.8.2`, which does
not exist on npm (registry jumps `41.7.8 → 42.0.0`). If the founder's CI is
genuinely green *today*, that action run is likely NOT installing `41.8.2`
(a pre-installed/cached CLI or the action falling back could explain it). It is
worth aligning both workflows to a real published version (e.g. `41.7.8` or a
later `4x` in the same major) to remove the confusion and make the two repos'
behavior directly comparable. This is a recommendation only; no change was made.

---

## 5. Files referenced (byte-exact, read cleanly this session)
- `C:\Users\boyap\G-Architects_HRMS\.github\workflows\deploy.yml` (ours, 829B)
- Founder's deploy.yml fetched via GitHub API (their repo, default branch), 792B
- npm registry dump for `vercel` (saved locally) — proves `41.8.x` absent
- `C:\Users\boyap\G-Architects_HRMS\.vercel\project.json` (orgId/projectId pair)

## 6. Open question back to founder
Update the pinned `vercel-version` in BOTH repos to a version that actually
exists, then re-run both CI pipelines and compare results. That is the cleanest
way to make "ours vs theirs" comparable, since the pin is currently identical
and nonexistent on both sides.
