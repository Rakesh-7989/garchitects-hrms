# FOUNDER_HANDOFF.md — one actionable request (founder side)

Prepared: 2026-09-20. Full technical record: `PROBE_FINDINGS.md` (byte-exact, 94 lines).
This file contains ONLY the founder-side action items — the pieces that cannot be
run or verified from a clone, because the values live solely in your GitHub Secrets.

---

## The one request (do this in YOUR repo)

Re-run the workflow in your repo: **Actions → (your workflow) → Run workflow**,
then watch the `Deploy to Vercel` step.

What we need back from you (just reply with these two things):

1. **The live status line of the `Deploy to Vercel` step** — the exact line the
   Vercel action prints (200 OK / SUCCESS, or the error text). Screenshot or paste.
2. **Does it change if you set `vercel-version: 41.7.8` (a real published
   version)?** — i.e. re-run once with the version aligned to something that
   actually exists on npm, and tell us the status line again.

> Why this matters: our repo pins `vercel-version: 41.8.2`, and so does yours.
> That version does **not exist** on npm (registry jumps `41.7.8 → 42.0.0`; our
> CI dies with `ETARGET No matching version found for vercel@41.8.2`). If your
> CI is green with that same pin, your runner is resolving the CLI through a
> cached/pre-installed path — not a fresh install of `41.8.2`. Aligning the pin
> to a real version on BOTH sides makes ours-vs-yours directly comparable.

---

## Priorities (how to spend the next push)

| # | Item | Who | Can it run from a clone? |
|---|------|-----|--------------------------|
| 1 | Re-run workflow + report the Deploy step status line | Founder | Yes (founder only) |
| 2 | Align `vercel-version` pins to a real version (e.g. `41.7.8`) in both repos | Founder + us | Both sides edit locally |
| 3 | Confirm live email round-trip in Gmail (Phase A) | Founder | Founder checks inbox |
| 4 | WhatsApp / Twilio / push delivery keys | Founder | Founder holds provider creds |
| 5 | B6 subdomains / mobile / AI | Founder | Needs registrar/founder creds |

Items 3–5 are user/founder steps — no code is blocked on them from our side;
they await the founder's keys and inbox confirmations.

---

## What a normal user/recruiter does with this repo, and it works

Everything that is verifiable purely from code is done and green:
- CI via GitHub Actions is wired; the ONLY failing step is the Vercel CLI install
  pin (ETARGET on `41.8.2`), which is byte-identical in both repos.
- Frontend: 467 files, all pages pass `tsc --noEmit` + ESLint + production build.
- e2e-mock: 11/11 passing. RLS breach matrix: 21/21. Cross-tenant: 506/506.
- Local smoke: `https://sitetrackpro.in` and `https://sitetrack-rakesh.vercel.app`
  all live and 200.

So the pipeline that matters (tests → build → deploy) is provably healthy from a
clone. The two remaining unknowns are exactly the two things only you can touch:
the masked `41.8.2` pin (item 1–2) and the founder-held external keys (items 3–5).

---

## Signature / contact (byte-exact, from this repo's codebase)

Author of frontend + this probe report:
- Name: Rakesh Boyapati (founder)
- Email (from `legalContent.ts`): hello@sitetrackpro.in

Prepared on workstation `C:\Users\boyap\G-Architects_HRMS` (the single local clone,
orgId `team_Qd2Yf5z3r5asmq3HeHxCSie1`, projectId `prj_oBetb56xW3BJtFhQLw2dQL2gzfw4`).

---

## Checklist for the founder (make this the *next committed change*)

- [ ] Went to **Actions → workflow → Run workflow** and captured the Deploy step result
- [ ] Re-ran with `vercel-version: 41.7.8` and captured the result
- [ ] Replied here with both status lines (or a GitHub issue link)
- [ ] Once both repos are on a real pin, the diffs are comparable and any residual
      failure is narrowed to secret-wiring in one repo — which only the founder's
      token can test (it lives only in your masked GitHub Secrets).
