# 39 — One home for sheet-layout reading

- **Status:** Done 2026-11-18. From task 30 finding #2 (`tasks/30-code-health-review-findings.md`), accepted 2026-11-17.
- **Size:** 3 pts.

## Why
Onboarding (`detectSections` in `api/sheet/structure.ts`) and saves/budget (`scanSection` in `lib/sheets.ts`) read the same layout with separate rules and separate cell helpers. Task 14's fix reached only one of them. `lib/sheets.ts` mixes Google API calls with this parsing.

## Scope
- New `lib/sheetlayout.ts`: `scanSection`, `findCategoryRow`, `detectSections` and its helpers, `cellText`/`numberOrNull`, `columnLetter`/`columnIndex`.
- `lib/sheets.ts` keeps auth and API wrappers only. `structure.ts` keeps the handler.
- Behaviour unchanged: task 38's tests pass before and after. Do **not** merge the two algorithms here; list their differences in the task file for 32 to decide.

## Order
After 38, **before 32**.

## Done note
- New `lib/sheetlayout.ts` (357 lines): `cellText`, `numberOrNull`, `columnLetter`/`columnIndex`, `scanSection`/`findCategoryRow`, and `detectSections` with its helpers. Pure; it imports only constants and the `CellValue` type.
- `lib/sheets.ts` is 401 → 283 lines (auth and API calls only). `api/sheet/structure.ts` is 291 → 60 (the handler only).
- The duplicate `numberOrNull` in `budget.ts` and `cellText` in `structure.ts` are gone. The one in `logtab.ts` is renamed `logCellText` because it means something else: it turns numeric ids into text.
- A pure move. All 56 tests from task 38 pass unchanged (only the import path changed), and `typecheck` passes.
- **Harder:** `sheetlayout.ts` is over the ~300-line `lib/` limit because it holds both readers. That is deliberate until 32 decides which rules win; the three differences are listed in `38-tests.md`. If 32 keeps both, split onboarding's reader into its own module.
