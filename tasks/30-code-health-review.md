# 30 — Code-health review (backend)

- **Status:** Backlog. From `../../TESTING-1.0.md` #15. Pairs with app task 55.
- **Size:** 3 pts. **Review only — no refactoring in this task.**

## Why
The owner has not read the code and relies on agents keeping it understandable. Before
Phase 2 builds on it, find where it is becoming a liability.

## Starting points (measured 2026-11-11)
Largest files: `lib/sheets.ts` (401 lines), `api/auth/bank.ts` (348), `lib/auth.ts` (327),
`api/sheet/structure.ts` (291). Also check: duplicated logic between `api/` files, comment
quality, history references in comments, and dead code.

## Output
`tasks/30-code-health-review-findings.md`: a ranked list (worst first) of what to split,
simplify, delete or re-comment, each with the file, the problem, the proposed change and a
size. Each accepted item becomes its own Backlog task.

## Done when
The findings file exists, the owner has reviewed it, and the accepted items are on the board.
