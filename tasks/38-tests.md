# 38 — Committed tests for the pure sheet and bank logic

- **Status:** Backlog. From task 30 finding #1 (`tasks/30-code-health-review-findings.md`), accepted 2026-11-17.
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
