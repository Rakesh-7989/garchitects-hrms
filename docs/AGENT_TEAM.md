# AGENT_TEAM.md — G-Architects HRMS Product Crew (standing AI-agent company)

> The standing, versioned operating structure for running this product end-to-end with AI
> agents. Every future session instantiates the same trained roster from here + `agents/*.md`.
> This is the single source of truth for **who** works on the product when a task arrives.

---

## 1. Model

A Program Manager (the orchestrating agent) breaks each task into a squad of **specialist
agents**, each instantiated from its role file in `agents/*.md`. An agent's "training" is its
role definition + the project operating manual (`AGENTS.md`); both live in the repo, so the
team persists across sessions and providers. Agents work in **parallel on non-overlapping
scopes**, land artifacts on disk, and the Program Manager aggregates → triages → fixes →
verifies → ships.

There is no human in the loop per line of work. The human appears only at the **decision
gate** (§4).

## 2. Roster

| # | Agent (role file) | Division | Mission | Key training (AGENTS §) |
|---|-------------------|----------|---------|------------------------|
| 1 | Schema Architect (`agents/schema-architect.md`) | Architecture | 3-layer schema parity, migrations, FK/index hygiene, DATE handling | §5 |
| 2 | API Engineer (`agents/api-engineer.md`) | Backend | Routes, RBAC guards, services, TOCTOU-safe mutations, audit logging | §5–§6 |
| 3 | UI Engineer (`agents/ui-engineer.md`) | Frontend | Static pages, `auth.js` helpers, role-nav parity, PWA, response-shape consumption | §7–§8 |
| 4 | QA Engineer (`agents/qa-engineer.md`) | Quality | Hermetic harnesses, QA Commander stages, RBAC matrix, DB invariants, coverage | §11 |
| 5 | Security Auditor (`agents/security-auditor.md`) | Quality | Guard coverage, leak-free errors, admin-self-service blocks, limiters, secrets | §5, §7 |
| 6 | Release Engineer (`agents/release-engineer.md`) | Operations | Atomic commits, deploy/Vercel, crons, post-deploy verification, PWA manifest | §9–§10 |
| 7 | Knowledge Keeper (`agents/knowledge-keeper.md`) | Operations | AGENTS.md §11 currency, FEATURE_*.md records, lessons learned | §11 |

## 3. Operating model

1. **Task intake** — Program Manager restates the ask in one line, checks scope (§0 rule).
2. **Squad assembly** — one task = one squad; roles instantiated from `agents/*.md` with the
   specific deliverable injected. Parallel, non-overlapping scopes.
3. **Work** — agents read/write only in their scope, land artifacts on disk
   (`qa/audit-*.md`, `docs/`, code), never fabricate findings, mark unverifiable items
   `SUSPECTED` with the check needed.
4. **Triage** — Program Manager merges reports + deterministic baselines (QA Commander
   hermetic 50/50, live smoke) into a severity×status table.
5. **Fix + verify** — confirmed bugs fixed per SDLC; every fix verified by the hermetic
   harness before commit, so `master` never ships broken.
6. **Ship** — atomic commit → push to `master` (auto-deploys to Vercel) → post-deploy live
   verification.
7. **Learn** — Knowledge Keeper records shipped state + lessons in AGENTS.md §11 and
   `docs/FEATURE_*.md`.

## 4. Decision gates (the only human steps)

- **Destructive ops** — DB drop/rewrite, force-push, prod rollback: pause, present, proceed
  only on confirm.
- **Prod writes / deploy-authorization changes** — any action that mutates the live DB or
  changes how deploys happen: pause for confirm.
- **Scope changes** — moving work onto another project or expanding a signed-off task beyond
  its blast radius: pause.
- Everything else — reading, probing, building, fixing, verifying, QA-ing, committing,
  pushing — is autonomous agent work.

## 5. Sprint log

- **Sprint 1 (2026-10-09) — Full-system audit squad.** Agents: Wiring & Bootstrap,
  Schema & Data Layer, API↔UI Contract & QA Coverage, Security & Error Hygiene.
  Baselines: live smoke 12/12 green; hermetic regression 50/50 green (118 checks + 160 RBAC
  probes, zero leftovers). Findings in `qa/audit-*.md`; triage + fixes tracked in the
  Program Manager's session output.