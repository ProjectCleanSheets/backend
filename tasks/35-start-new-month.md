# 35 — Start a new month (backend)

- **Status:** Backlog (approved 2026-11-11). From `../../TESTING-1.0.md` #5. **After task 32.**
  Pairs with app task 59 (ledger CR-10).
- **Size:** 3 pts.

## Scope (owner's choice: option A — copy first, then edit)
`POST /api/sheet/month` with `dryRun` support:
1. Find the **latest month tab** and duplicate it (`duplicateSheet`). Name the copy with the
   current English month name. Refuse if that name already exists.
2. **Empty plain numbers** in every mapped section's actual column. Never touch formulas.
3. **Roll month references forward inside the new tab:** a formula pointing at a month tab
   moves one month on (`='September'!H40` in October becomes `='October'!H40` in November).
4. **Other tabs** that reference month tabs (e.g. a yearly summary): detect formulas that
   would need the new month and return the exact proposed change. Apply it only when the
   app sends the owner's approval.
5. If any formula can't be understood well enough to roll forward, **don't create the
   month**: return the cell and the reason. Delete the copy if it was already made.
6. The response (and the dry run) is a summary: copied from which tab, amounts cleared,
   formulas kept, references rolled forward, proposed changes to other tabs.

## Done when
Against a copy of the owner's sheet: November is created from October with every formula
intact, carry-over references rolled forward, plain actuals empty, and the summary matches
what happened. A sheet with an unreadable formula is refused with nothing left behind.
