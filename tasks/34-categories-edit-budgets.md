# 34 — Categories editor: budgets (backend)

- **Status:** Backlog (approved 2026-11-11). From `../../TESTING-1.0.md` #12. After task 33.
  Pairs with app task 58 (ledger CR-10).
- **Size:** 2 pts.

## Scope
- **Set a budget:** write one category's budget cell on a given tab.
- **Move budget:** take an amount from one category and add it to another in **one request**,
  both cells written in one `batchUpdate` so they can't half-apply.
- A budget cell that holds a **formula** is never overwritten: refuse with a clear message
  naming the cell.
- Moves are undoable the same way saves are (a reversible record).

## Done when
Set and move work on the current month, formula budget cells are refused, a move can be
undone, and `openapi.json` is updated.
