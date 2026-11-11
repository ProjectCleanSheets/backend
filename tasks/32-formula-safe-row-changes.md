# 32 — Formula-safe row changes

- **Status:** Backlog (approved 2026-11-11). From `../../TESTING-1.0.md` #5 and #12.
- **Size:** 5 pts · backend. **Comes first:** tasks 33–35 all go through this.

## Why
The owner's sheet depends on its formulas (section totals, Left, cash-flow and summary
boxes). Copying a month and then adding or removing categories by hand has broken them
before: a row added at the edge of a `SUM` range is silently left out, and ranges had
to be extended by hand. The owner's requirement: **the app must never lose or break a
formula, and the owner must never have to fix one.**

How Sheets behaves: inserting or deleting a row *inside* a range adjusts the range
automatically. Inserting at the edge (e.g. directly above a Total) does not. Today the
backend never inserts; it writes a new category into an empty row above the Total
(`POST /api/sheet/category`), which has the same edge problem if that row is outside the
Total's range.

## Scope
One shared module (e.g. `lib/sheetedit.ts`) that every structural change goes through:
1. **Snapshot:** read every formula on the tab (`valueRenderOption=FORMULA`) before changing anything.
2. **Change safely:** add a category as a real inserted row *inside* its section
   (`insertDimension` between the first and last category rows, so Sheets extends ranges);
   remove one as a real deleted row (`deleteDimension`). No more writing into "free rows".
3. **Verify:** re-read the formulas and check that every formula that aggregated the section
   before still covers exactly its category rows (the new one included, the removed one excluded),
   and that no formula now returns an error (`#REF!`, `#VALUE!`).
4. **Undo on failure:** if verification fails, reverse the change (delete the inserted row /
   restore the deleted row and its values) and return a structured error naming the cell
   and formula. The tab must never be left half-changed.
5. **Dry run:** the same code can run without writing and return what *would* change.

`POST /api/sheet/category` moves onto this path.

## Done when
- Fixture tests on a copy of the owner's real layout (side-by-side boxes, Cash flow box,
  merged titles): adding a category as the first, middle and last row of a section keeps
  every total correct; removing the first, middle and last does too.
- A deliberately unsafe case (a formula the check can't account for) is refused and
  leaves the tab unchanged.
- Verified live against a **copy** of the owner's sheet, never the real one.
