# UX coverage expansion

The user approved implementing all gaps identified in the source audit. Preserve the local-only, deterministic, sandboxed design and the existing CLI. Work on `codex/ux-coverage` in the newly cloned checkout; no publication or remote push is part of this request.

## Behavior

1. Keyboard: traverse with Tab, check actual reachability and focus visibility, inspect modal entry/trapping/Escape/return, and validate keyboard operation of declared ARIA widgets.
2. Forms: exercise native declared constraints (required, type, length, range, pattern), detect missing feedback and invalid writes, associate custom errors with fields, and preserve entered values after failed submissions. Do not invent business requirements for optional inputs.
3. Recovery: inject failed writes, offline/timeouts, 401/403/422/429/500; detect false success, missing failure feedback, stuck controls, data loss, and broken retries. Distinguish read-only GraphQL POST operations from mutations. Test partial read failures without failing unrelated endpoints.
4. Navigation: retain query/hash routes during discovery, check reachable links and deep-link reloads, exercise back/forward and configurable state/scroll/draft expectations. Expected resets and autosave policies must be configurable rather than universal failures.
5. Mobile: perform real interactions at mobile widths, add compact and landscape profiles, and simulate a reduced visible viewport after focusing input. Clearly label this as viewport simulation, not physical soft-keyboard or real-device verification.
6. Accessibility: expand axe WCAG checks including contrast, verify dynamic status semantics, and report check errors explicitly. Automated results are not a conformance certification.
7. Components/files: inspect expanded menus, dialogs and tabs; native/custom selection controls, configurable pagination/infinite-scroll scenarios, upload rejection/retry scenarios, download failures and empty files. Support replayable, bounded configured workflows for application-specific expectations.
8. Performance: collect layout shifts, LCP, long tasks, and interaction timing from browser observers. Report lab diagnostics and thresholds separately from deterministic functional errors; do not label short synthetic runs as field INP or device performance.

## Architecture

- Keep findings as `{ rule, cat, msg, shot?, vp?, page?, severity?, confidence? }`; existing consumers remain compatible.
- `src/coverage.mjs` records checked/skipped/error with reasons. Exceptions never count as successful checks. Caps and unsupported protocols appear in coverage.
- `src/discover.mjs` canonicalizes full local URLs while folding ID path segments; query/hash are retained and broken linked pages remain observable.
- `src/explore.mjs` replays short action chains from a fresh page, runs checks on reached states and follows newly revealed controls. Bound depth/states/actions, respect `skipClick`, mark every write at request time, close pages before resetting sandbox data.
- `src/checks/keyboard.mjs`, `forms.mjs`, `recovery.mjs`, `navigation.mjs`, `components.mjs`, `performance.mjs`, `mobile.mjs` own separate check domains.
- `src/scenarios.mjs` runs explicit Playwright-like actions and assertions through a deliberately small declarative configuration; no arbitrary executable code. Scenarios run inside the same local-only sandbox with write tracking/reset.
- `src/run.mjs` orchestrates each family per viewport, separates discovery from assertions, propagates coverage, and always performs sandbox cleanup.
- `src/report.mjs` shows functional findings, performance warnings, coverage and limitations without treating a skipped/error check as clean.

## Configuration

All additions are optional. Defaults run general checks. Extend config with `viewports`, `checks`, `limits`, `performance`, and `scenarios`. Explicit scenarios support goto/click/fill/press/select/check/upload/scroll/back/forward/reload/wait and visible/hidden/text/value/url/count/download assertions. Scenario failures are findings with the failed step; unsupported or invalid configuration fails early rather than being ignored. `readOnly` disables all action-based checks and scenarios and records that fact.

## Validation

- Use Node 22 and the installed Chrome binary in this environment.
- Keep the original 25-mine fixed/unfixed benchmark and healthy control pages; count accessibility findings rather than silently filtering them out.
- Add focused Node tests backed by an ephemeral local HTTP fixture server and real browser pages for each new family, including healthy counterparts and coverage errors.
- Test query/hash discovery, GraphQL read classification, state exploration, caps and read-only behavior, and declarative scenario validation.
- Verify the original fixture data remains unchanged and no new external requests are permitted.
- Report exact tested counts and any unavailable browser/device capabilities.

## Accepted limits

Physical keyboard, assistive-technology announcements, genuine mobile soft keyboards, browser engines not installed locally, field Web Vitals, and product-specific workflows cannot be proven by this run. Record them as unverified/conditional; provide configuration hooks and tests for the parts that can be exercised locally. Do not claim universal UX completeness or use absence of DOM changes alone to infer business success/failure.
