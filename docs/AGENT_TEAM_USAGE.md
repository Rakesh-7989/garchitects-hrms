# Agent Team Usage Guide (G-Architects HRMS)

This repo ships with a **standing AI-agent company**: `docs/AGENT_TEAM.md` + 7 specialist role files in `agents/*.md`. Use them whenever work is non-trivial.

## When to use the agent team
- **Non-trivial task**: multi-file change (routes + guards + UI), new feature, schema change, audit/fix sweep, or QA harness work.
- **Trivial edit**: one-line tweak, comment fix, CSS spacing — direct edit is fine.
- Follow AGENTS.md §2 for non-trivial work (deep-dive → plan → implement → verify → document → commit).

## How to engage (recommended workflow)
1. **State the task** in Telugu-roman or English. The orchestrating agent (you) restates it in one line and checks scope (§0).
2. **Assemble squad**: map the task to roles (e.g. schema change → Schema Architect + API Engineer + QA; UI→UI Engineer; security sweep→Security Auditor; release→Release Engineer; docs→Knowledge Keeper). Run in parallel on non-overlapping scopes.
3. **Land artifacts** on disk: code + `qa/audit-*.md` or `docs/FEATURE_*.md` updates. No human per-line.
4. **Triage + fix + verify**: use `npm run qa` hermetic (56/56) + syntax checks (`node --check`, inline-JS). 
5. **Ship**: atomic commit + push to `master` (auto-deploy). Verify live if needed.
6. **Learn**: update AGENTS.md §11 + relevant FEATURE doc.

## Quick role mapping
- **Schema** (`schema-architect.md`): three-layer parity, migrations, self-heal.
- **API** (`api-engineer.md`): routes, guards, TOCTOU, audit, pgErrorResponse, error hygiene.
- **UI** (`ui-engineer.md`): static HTML/CSS/JS, auth.js helpers, nav parity, PWA cache bump.
- **QA** (`qa-engineer.md`): QA Commander, RBAC matrix, hermetic harnesses, leftovers zero.
- **Security** (`security-auditor.md`): guard coverage, leak-free errors, limiters, cron secrets.
- **Release** (`release-engineer.md`): atomic commits, Vercel, crons, post-deploy smoke, PWA.
- **Knowledge** (`knowledge-keeper.md`): AGENTS.md §11, FEATURE docs, lessons learned.

## Decision gates (human only)
Destructive ops, prod writes/rollback, deploy auth changes, scope changes (§4 in AGENT_TEAM.md). Everything else is autonomous.

## Current baseline
Hermetic QA: 56/56 green. All harnesses present. Error hygiene strengthened recently.
