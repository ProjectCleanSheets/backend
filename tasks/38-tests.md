# 38 — Committed tests for the pure sheet and bank logic

- **Status:** Done 2026-11-18. From task 30 finding #1 (`tasks/30-code-health-review-findings.md`), accepted 2026-11-17.
- **Size:** 2 pts.

## Why
Every task so far tested with throwaway stubs and deleted them. Tasks 32–35 change rows in the owner's live sheet, and nothing records today's behaviour.

## Scope
- `node --test` (Node runs `.ts` directly; no new dependency) and an `npm test` script.
- Tests for `scanSection`/`findCategoryRow`, `detectSections`, `parseLogRows`/`buildLogMatcher`, `resolveColumns`, `computeBankStatus`, `toQueueTransaction`, `toWholeSecondISO`.
- Fixtures copied from the real sheet layout (no personal amounts needed: shape only), including the Cash flow "Income" summary-row trap.
- Where `detectSections` and `scanSection` disagree on the same fixture, pin today's answer and note it for task 39.
- Fix the "exported for tests" comments so they are true.

## Done when
`npm test` and `npm run typecheck` pass locally; no runtime code changed.

## Done note
- `npm test` runs `node --import tsx --test 'test/**/*.test.ts'`. Node can't resolve this repo's extensionless imports by itself, so `tsx` (already installed through `@vercel/node`) is now a pinned devDependency rather than "no new dependency" as planned. `tsconfig.json` type-checks `test/` too.
- 56 tests in four files: `sheetlayout` (scanSection, findCategoryRow, detectSections, column letters), `saveflow` (log parsing and dedup matcher, resolveColumns, findMonthTab, roundAmount, budget overview), `bank` (bank status, queue mapping, whole-second timestamps), `crypto` (AES-GCM round trip and tamper, OAuth state).
- Fixture `test/fixtures/dashboard.ts`: the dashboard's shape with made-up values, including the Cash flow "Income" summary-row trap, a merged banner, a "Due" column and two stacked boxes.
- Mutation check: changing `HEADER_GAP_ROWS` from 4 to 2 fails a test.
- Only runtime change: `fetchUncategorized` is no longer exported (nothing used it). The "exported for tests" comments now name the test file.

**Where the two layout readers differ (for 39 and 32)**, pinned in `detectSections vs scanSection differences`:
1. A blank row between the Budget/Actual header and the first category: onboarding (`detectSections`) sees no categories, while saves (`scanSection`) find them (up to 4 blank rows allowed).
2. A summary box like Cash flow is listed by onboarding as its own section, and saves rely on the mapping plus the value-column check to skip it.
3. Boxes end differently: onboarding stops at the next header pair or detected title in the same columns, while saves stop at any *mapped* section name.
