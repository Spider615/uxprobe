# UX coverage expansion implementation plan

> **For agentic workers:** Use subagent-driven-development for isolated modules and sequential independent review; the parent owns shared integration. Use test-driven-development for behavioral changes.

**Goal:** Implement every approved UX audit area and surface coverage limitations instead of silently returning a clean report.

**Architecture:** Extend the existing Playwright checker with focused modules and bounded declarative workflow replay. Preserve sandbox isolation, existing finding fields and CLI behavior, and add explicit coverage data and diagnostic severity.

**Tech Stack:** Node.js 22+, ESM, Playwright 1.60, axe-core, node:test.

---

## Task 1: Coverage, request classification and discovery (parent)

Files: `src/coverage.mjs`, `src/browser.mjs`, `src/discover.mjs`, `src/config.mjs`, `test/core.test.mjs`.

- [x] Add failing tests for distinct `/?tab=x`, `/#/settings`, broken linked pages, GraphQL read POST versus mutations, invalid config and checked/skipped/error coverage.
- [x] Run `node --test test/core.test.mjs` and confirm missing behavior.
- [x] Implement bounded configuration and URL/request helpers, retaining optional defaults.
- [x] Rerun the focused tests and inspect malformed URL, redirects, invalid limits and isolation cases.

Expected public contract:
```js
export function createCoverage() { /* checked/skipped/error records */ }
export function isRead(req) { /* local GET/HEAD or explicit GraphQL query */ }
export async function discover(ctx, base, seeds, max, options = {}) { /* paths incl search/hash */ }
```

## Task 2: Keyboard, accessibility and mobile (delegated module)

Files: `src/checks/keyboard.mjs`, `src/checks/mobile.mjs`, `src/checks/static.mjs`, `test/keyboard.test.mjs`.

- [x] Add failing browser fixtures for inaccessible controls, modal keyboard behavior, lost focus, hidden focus, contrast and narrow/short viewport obstruction; include healthy controls.
- [x] Implement `keyboardChecks(page, options = {})` and `mobileChecks(page, options = {})`, both returning finding arrays and restoring temporary viewport changes.
- [x] Expand axe checks and return `probe-error` when analysis fails.
- [x] Run the focused browser tests, then spec review and code review.

## Task 3: Form constraints and submission recovery (delegated module)

Files: `src/checks/forms.mjs`, `src/checks/recovery.mjs`, `test/forms.test.mjs`.

- [x] Add failing fixtures for invalid inputs, missing feedback, field error association, failed write false success, cleared values, disabled retry and successful recovery.
- [x] Implement `formChecks(ctx, url, { shoot, reset, markDirty, ... })` and `recoveryChecks(ctx, url, options)` with request-time write tracking, finite waits and healthy controls.
- [x] Run injected 401/403/422/429/500/offline/timeout cases and verify real fixture data is untouched.
- [x] Run spec review and code review.

## Task 4: State exploration, navigation, components and explicit workflows (parent)

Files: `src/explore.mjs`, `src/scenarios.mjs`, `src/checks/navigation.mjs`, `src/checks/components.mjs`, `src/checks/interactions.mjs`, `test/workflows.test.mjs`.

- [x] Add failing tests for nested dialogs, dropdown/tab interaction, query/hash back/forward, deep-link failures, missing/empty downloads, upload rejection and pagination expectations.
- [x] Implement replayable action chains and declarative scenario validation/assertions, bounding states/actions/depth and reporting caps.
- [x] Respect skipClick/readOnly for every action route and reset state after all writes.
- [x] Run checks on reached states, not only the initial page; include mobile interactions.
- [x] Run focused tests including cancelled/failed actions and healthy controls.

## Task 5: Performance and read-failure coverage (parent)

Files: `src/checks/performance.mjs`, `src/checks/conditions.mjs`, `test/performance.test.mjs`, `test/conditions.test.mjs`.

- [x] Add failing fixtures for delayed rendering, layout shift, long interaction tasks, partial endpoint failure and POST GraphQL query perturbation.
- [x] Implement browser performance observers and configurable diagnostic thresholds; do not claim field INP.
- [x] Extend condition transforms to detail objects and read-only GraphQL POST; inject endpoint-specific status/transport faults with meaningful recovery checks.
- [x] Run healthy controls alongside each injected-fault fixture.

## Task 6: Runner, reports, regression scoring and documentation (parent)

Files: `src/run.mjs`, `src/report.mjs`, `package.json`, `README.md`, `skill/SKILL.md`, `test/score.mjs`, `test/integration.test.mjs`.

- [x] Add failing report/runner tests for checked/skipped/error coverage, read-only, mobile execution, family exceptions and score failures.
- [x] Integrate all families and show confidence/severity, total scanned pages, coverage and real-device limitations in JSON and HTML.
- [x] Include accessibility in benchmark scoring, make failures exit nonzero, document changed semantics and configuration examples.
- [x] Run `node --test --test-concurrency=1 test/*.test.mjs`, the complete minefield benchmark, syntax checks and diff checks.
- [x] Perform independent spec review then code-quality review; fix material issues and rerun affected tests.
- [x] Deliver exact results with remaining environmental limits; integrate into `main` as explicitly requested by the user.

## Execution record

Implemented on local branch `codex/ux-coverage`. Shared integration and the remaining modules were completed by the parent after the initial delegation service failure; independent spec and code-quality reviews subsequently completed. The user subsequently requested committing and pushing the implementation to `main`.

Pre-commit validation completed with all 80 full-suite cases passing, syntax checks and diff checks. Earlier validation included the complete 25-case compatibility benchmark and a successful two-page rerun after fixing two fixture list semantics errors. See `docs/ux-coverage-validation.md` for exact scope, logs and remaining limits.
