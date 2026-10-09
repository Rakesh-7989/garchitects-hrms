# Redesign Phase 1: Design System Foundation (Proposed)

**Status:** PLANNED (Propose-First)  
**Risk:** Low  
**Approach:** Incremental, backward compatible, QA-gated (must keep 56/56 green)

## 1. Objective
Establish a minimal, reusable design system (CSS tokens + shared component patterns) without breaking existing behavior. Vanilla HTML/CSS/JS (no bundler) — preserve clean URLs and PWA.

## 2. Rationale
- Inconsistencies across admin/manager/employee portals
- Repeated utility classes, spacing/colors drift
- Easier maintenance + future phases safe
- Keep existing tests/harnesses green (56/56)

## 3. Scope (In-Scope)
- **CSS tokens**: public/css (theme vars: colors, spacing, radius, shadows, typography)
- **Shared patterns**: common UI (buttons/cards/inputs/badges/toasts/tables/modals)
- **Portal consistency**: public/pages/* (non-structural class cleanups)
- **No logic changes**: routes/guards untouched (behavior preserved)

## 4. Out of Scope (Phase 1)
- Route restructuring, DB/schema, API contracts (Phase 2), full UX rewrite (Phase 3)

## 5. Blast Radius
- Static assets only (CSS/HTML). Server (routes/services) unchanged.
- No auth/guard changes. RBAC matrix unchanged.
- Backward compatible (additive CSS vars, optional class cleanup).

## 6. Proposed Changes (Additive, Safe)

### 6.1 CSS Tokens (public/css)
- Extend existing CSS custom properties for spacing (4pt scale), radius, surface/elevation, semantic colors (success/warn/danger/info)
- Keep existing values as fallbacks where needed
- Dark/light parity

### 6.2 Component Classes (shared)
- `.btn`, `.btn-primary/secondary/ghost/danger`, `.card`, `.badge`, `.input`, `.table`, `.toast`, `.modal` utility classes (optional adoption, no forced migration)
- Avoid breaking existing inline class usage

### 6.3 HTML Consistency
- Minor class normalization across portals (readability), no structural changes
- Preserve inline JS blocks (syntax-clean per check-inline-js)

## 7. Verification Plan
- Syntax: `node --check` (no server changes expected)
- Inline JS: `node scripts/check-inline-js.cjs` on HTML pages
- QA: `npm run qa` hermetic → **must remain 56/56 passed, 0 failed**
- RBAC/invariants unchanged
- Visual smoke (manual) on portals, no functional regressions

## 8. Rollback
Trivial (revert CSS/HTML hunks). No DB/migrations.

## 9. Acceptance Criteria
- QA 56/56 green
- No behavior changes (forms/flows same)
- Additive only, no breaking class removals forced
- Clean tree, atomic commit

**Next:** Implement minimal token additions + adopt selectively. No forced mass replacement in Phase 1.
