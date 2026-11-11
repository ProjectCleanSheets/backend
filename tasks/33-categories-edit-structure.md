# 33 — Categories editor: rename, add, remove (backend)

- **Status:** Backlog (approved 2026-11-11). From `../../TESTING-1.0.md` #12. **After task 32.**
  Pairs with app task 57 (ledger CR-10).
- **Size:** 3 pts.

## Scope
Endpoints that work on **any month tab** (a `tab` parameter, English month name as today):
- **Rename** a category: writes the name cell only. Refused if the name already exists in that section.
- **Add** a category (with optional budget): through task 32's safe insert.
- **Remove** a category: through task 32's safe delete. Refused if the category has a
  non-zero actual this month, unless the request explicitly confirms.
Every change returns the dry-run summary first if asked (`dryRun: true`). Update `openapi.json`.

## Done when
All three work on the current and a future month tab, every change leaves formulas intact
(task 32's checks), and errors use the existing codes.
