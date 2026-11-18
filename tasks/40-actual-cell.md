# 40 — One Actual-cell read-modify-write

- **Status:** Done 2026-11-18. From task 30 finding #4 (`tasks/30-code-health-review-findings.md`), accepted 2026-11-17.
- **Size:** 1 pt.

## Why
`save.ts` (`locateActualCell`) and `category.ts` each do the same two-column read, "blank counts as 0" and rounding. 32 and 35 would add a third copy.

## Scope
Move "find the category row and its current Actual" and "add an amount to it" into `lib/saveflow.ts`; both endpoints call it. Behaviour and responses unchanged. Tests for the new helper.

## Order
After 39, **before 32**.

## Done note
- New in `lib/saveflow.ts`: `readSectionColumns` (category and Actual columns in one batchGet), `currentActualAt` (blank counts as 0), `locateActualCell` (moved from `save.ts`) and `addToActual` (round, then write; undo passes a negative amount). Save, undo and new category all use them.
- Same Google calls, ranges, messages and responses as before. `save.ts` 208 → 159 lines, `category.ts` 195 → 191.
- Tests: 6 new (62 in total), using `test/fixtures/fakesheets.ts`, a stand-in Sheets client that records writes. They cover row lookup, the Income/Cash flow trap, CATEGORY_NOT_FOUND, the rounded write, and an exact undo.
- `budget.ts` still does its own multi-column read. That is a different shape (every mapped column at once), so it was left alone.
