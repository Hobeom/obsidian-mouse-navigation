# Optional Diagonal Gestures Implementation Plan

**Goal:** Add opt-in, configurable straight diagonal gestures to the Modern engine, using Mouse Gesture Events defaults.

**Architecture:** Preserve the existing recognizer path when the option is off. Add four diagonal directions and a direction-aware recognition path when enabled, retaining cardinal two-step gestures and rejecting mixed diagonal sequences. Reuse existing actions, settings persistence, overlays, and command selectors.

**Tech Stack:** TypeScript, Obsidian API, esbuild, Node test runner.

---

## Requirements and defaults

- `enableDiagonalGestures`: false for new and upgraded installations; Modern engine only.
- Recognizer option: `enableDiagonals?: boolean`, supplied per gesture so settings changes apply without restart.
- Direction keys: `up-right`, `down-left`, `down-right`, `up-left`.
- Defaults: up-right = `refresh-app`, down-left = `reopen-closed-tab`, down-right = `navigate-forward`, up-left = `navigate-back`.
- Source: https://chromewebstore.google.com/detail/mouse-gesture-events/ogjdgjefnddnjhkibmblgiofbjdgnahc (verified 2026-10-13).
- Browser page refresh maps to the existing Obsidian app reload action; disclose that difference in settings and README.
- Existing cardinal bindings remain unchanged. Each diagonal supports all existing action choices, including none and custom command IDs.
- Initial scope supports straight diagonals only, not diagonal multi-step combinations.

## Task 1: Recognition and direction types

**Files:** `types/gesture.ts`, `gesture/recognizer.ts`, new `tests/recognizer.test.mjs`.

1. Add failing trajectory tests for four diagonals, thresholds, angular boundaries/noise, long cardinal legs and turns, reversals, mixed diagonals, cancellation, and option-off compatibility.
2. Run `node --test tests/recognizer.test.mjs` to verify the new cases fail before implementation.
3. Extend the direction union and implement opt-in classification with robust anchors and bounded direction changes.
4. Run the focused tests until they pass; preserve the old recognition path with the option off.

## Task 2: Settings, defaults, labels, and documentation

**Files:** `main.ts`, `locales/en.ts`, `locales/ko.ts`, `README.md`.

1. Persist the default-off flag and rebuild the recognizer using it at gesture start.
2. Add diagonal defaults, overlay metadata, and selectors shown only while Modern diagonals are enabled.
3. Show the Modern-only toggle; preserve selections when toggling or switching engines and rerender settings after changes.
4. Translate names/descriptions and document defaults, app-reload semantics, and scope.

## Task 3: Integration and validation

**Files:** `tests/interaction.test.mjs`.

1. Extend the existing mocked Obsidian harness only as needed to verify command calls, stored settings, and settings controls.
2. Test four defaults through real mouse handlers, custom/none mappings, opt-out/legacy behavior, saved migration, toggles, overlays, two-step regression, and stale-state/menu behavior.
3. Run `npm test`, `npm run build`, and ESLint on touched TypeScript files.
4. Independently review the diff for recognition and UI regressions; repair confirmed findings and rerun affected checks.
5. Deliver the tested worktree and built plugin. Publishing a release is outside this implementation request.

## Validation completed

- `npm test`: 55 passed (43 interaction/settings tests and 12 recognizer tests).
- `npm run build`: passed; built `main.js` in the worktree.
- ESLint on all touched TypeScript sources and `git diff --check`: passed.
- Independent review: no actionable findings; opt-out behavior compared against the prior recognizer and noisy straight trajectories checked.
- `npm audit --omit=dev --audit-level=moderate`: zero findings. Full audit reports nine existing high-severity development-dependency findings; dependencies were not changed.
- Verification used automated trajectories and mocked Obsidian/browser APIs; real mouse input inside Obsidian was not exercised in this change.
- No release published. Version remains at the base branch's 1.1.4.
