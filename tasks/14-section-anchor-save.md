# 14 — Save flow: anchor section scan on true box titles

- **Branch:** `feature/section-anchor-save`
- **Depends on:** 07
- **Story points:** 2

## Why

Found during task 07 end-to-end testing (2026-07-18): the Cash flow summary
box repeats section names as row labels (its "Income" line, with numbers
beside it). `scanSection` anchors on the first category-column cell equal to
the section name, so "Income" anchored on the summary row and returned the
Cash flow lines below it as categories. Task 07 fixed this for the budget
endpoint by passing the section's Actual column into `scanSection` (a title
row never has a number in its own value column; a summary row always does).

The save flow has the same latent flaw: `api/sheet/save.ts` and
`api/sheet/category.ts` scan with only the category column. Saving to
"Income" (or any section whose name doubles as a summary-row label) would
anchor on the wrong box — worst case a save writes into a Cash flow summary
cell. Currently only Expenses/Bills saves have been exercised, so nothing
has been corrupted, but this must land before production use (task 09 gate).

## Scope

- `api/sheet/save.ts` (`locateActualCell`) and `api/sheet/category.ts`: read
  the section's category AND Actual columns in one `readRanges` (batchGet)
  call and pass the Actual column into `findCategoryRow` / `scanSection` as
  the title disambiguator (the optional parameter added in task 07).
- `lib/sheets.ts` `findCategoryRow`: accept and forward the optional
  `valueColumn` parameter.

## Out of scope

- Any behavior change for layouts without name collisions; response
  contracts; openapi.json (no API surface changes).

## Acceptance criteria

- [ ] Saving/creating/undoing against a section whose name also appears as a
      summary-box row label anchors on the real box (fixture mirroring the
      real sheet: Cash flow rows "Income"/"Invest"/"Bills & Expenses").
- [ ] Regression: on layouts without collisions, old and new
      `findCategoryRow` agree (comparison test like task 06's fuzz).
- [ ] `tsc --noEmit` passes.

## Agent kickoff prompt

> You are building the CleanSheets backend. Read CLAUDE.md before starting —
> especially Security Requirements and Task Board. Tasks 01–07 are built;
> task 07's `scanSection` already supports an optional `valueColumn`
> disambiguator and `lib/sheets.ts` has `readRanges` (batchGet). Implement
> task `tasks/14-section-anchor-save.md` exactly as scoped. When done, update
> TASKS.md.
