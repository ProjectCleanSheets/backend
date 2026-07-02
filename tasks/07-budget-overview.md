# 07 — Budget overview

- **Branch:** `feature/budget-overview`
- **Depends on:** 03
- **Story points:** 2

## Scope

- `api/sheet/budget.ts` — `GET /api/sheet/budget?tab=July`:
  - Read the full sheet tab using `lib/sheets.ts`
  - For each section and category return Budget and Actual values
  - Return total spent and total budget across all expense sections
  - `tab` defaults to the current month if not provided
  - Return structure: sections array, each with a categories array — maps to the iOS
    budget overview screen (per-category progress bars)

## Out of scope

- Per-category transaction drill-down (V2), writing anything

## Acceptance criteria

- [ ] Response contains sections → categories with `budget`, `actual` and section +
      grand totals.
- [ ] Unknown tab returns `SHEET_NOT_FOUND`.
- [ ] Endpoint auth-gated; query validated with zod; structured errors per CLAUDE.md.
- [ ] `tsc --noEmit` passes.

## Agent kickoff prompt

> You are building the CleanSheets backend. Read CLAUDE.md before starting — especially
> the Security Requirements and Task Board sections. Tasks 01–06 are already built;
> this is a read-only endpoint over `lib/sheets.ts`. Implement task
> `tasks/07-budget-overview.md` exactly as scoped. When done, update TASKS.md.
