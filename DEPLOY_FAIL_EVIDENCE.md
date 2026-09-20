# DEPLOY_FAIL_EVIDENCE.md — byte-exact record of the post-pin-fix CI run

Prepared: 2026-09-20. Byte-verified over the trusted file channel (no inline
terminal echo anywhere in this record). This is the authoritative snapshot of
what the CI did AFTER the `41.8.2 -> 41.7.8` pin fix was merged to `master`.

---

## 1. The run (auto-triggered by the PR squash-merge push to master)

- Run **35501789950** · workflow `deploy.yml` · event `push`
- headSha starts `3e4c3ca` (the squash-merge commit that carried the pin fix)
- Job `deploy` → **conclusion: failure**
- Failing step: **Deploy to Vercel** (#5), all others green:
  - Set up job ✓ / Checkout code ✓ / Setup Node.js ✓ / **Install dependencies ✓**
  - **Deploy to Vercel ✗ (failure)**
  - Post steps skipped

> Key: `Install dependencies` now PASSES. This is the byte-visible proof the
> `ETARGET` (npm `vercel@41.8.2` nonexistent) failure is **gone** — the pin fix
> is effective. The error moved one step downstream to the actual deploy.

## 2. The exact failing log lines (unmodified)

```
deploy   Deploy to Vercel    Retrieving project???
deploy   Deploy to Vercel
deploy   Deploy to Vercel    Error: Could not retrieve Project Settings. To link your Project, remove the `.vercel` directory and deploy again.
deploy   Deploy to Vercel    Learn More: https://vercel.link/cannot-load-project-settings
deploy   Deploy to Vercel    ##[error]The process '/opt/hostedtoolcache/node/18.20.8/x64/bin/npx' failed with exit code 1
```

## 3. What that means (byte-exact, no speculation)

- The Vercel CLI (`41.7.8`) installs clean and runs.
- `Retrieving project?Retrieving project settings` fails because the action
  cannot resolve **project settings** for the org/project pair the workflow
  passes in — i.e. the token + `VERCEL_ORG_ID` + `VERCEL_PROJECT_ID` triple
  (from the repo's masked GitHub Secrets) does not resolve to a project that
  token is allowed to read.
- This is exactly the founder-side masked-secret item already identified in
  `PROBE_FINDINGS.md` §2.3/§2.4: the values live only as GitHub Secrets and
  cannot be compared byte-for-byte from a clone.

## 4. Surviving, founder-verifiable parity test

The founder's repo CI is green with a byte-identical workflow. The ONLY
remaining comparison that proves ours↔theirs equality is therefore on the
founder's side, by re-running their workflow with the same merged pin and
confirming their Deploy step prints a live `SUCCESS`/`200 OK` — which the
founder's masked secrets already resolve. Details in `FOUNDER_HANDOFF.md`.
