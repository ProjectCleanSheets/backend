# 39 — One home for sheet-layout reading

- **Status:** Backlog. From task 30 finding #2 (`tasks/30-code-health-review-findings.md`), accepted 2026-11-17.
- **Size:** 3 pts.

## Why
Onboarding (`detectSections` in `api/sheet/structure.ts`) and saves/budget (`scanSection` in `lib/sheets.ts`) read the same layout with separate rules and separate cell helpers. Task 14's fix reached only one of them. `lib/sheets.ts` mixes Google API calls with this parsing.

## Scope
- New `lib/sheetlayout.ts`: `scanSection`, `findCategoryRow`, `detectSections` and its helpers, `cellText`/`numberOrNull`, `columnLetter`/`columnIndex`.
- `lib/sheets.ts` keeps auth and API wrappers only. `structure.ts` keeps the handler.
- Behaviour unchanged: task 38's tests pass before and after. Do **not** merge the two algorithms here; list their differences in the task file for 32 to decide.

## Order
After 38, **before 32**.
