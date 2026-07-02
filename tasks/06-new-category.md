# 06 — New category

- **Branch:** `feature/new-category`
- **Depends on:** 05
- **Story points:** 3

> Source: Product Spec US-03 AC-3 (the "+ New Category" button in the categorize flow).
> This task is **not** in the Backend Features doc — it was missed there; the iOS app's
> MVP categorize screen requires it.

## Scope

- `api/sheet/category.ts` — `POST /api/sheet/category`:
  - Body: `{ section, name, budget?, transactionId?, amount? }`
  - Insert a new category row at the end of the given section in the current month tab
    (category name in the category column, optional budget in the Budget column)
  - If `transactionId` + `amount` are provided, categorize that transaction to the new
    category in the same request (reuse the save logic/ordering from task 05)
  - Return the new row position and, if saved, the new Actual value

## Out of scope

- Renaming/reordering categories (iOS Settings uses re-scan; no backend endpoint in MVP)

## Acceptance criteria

- [ ] Row inserted within the correct section without disturbing other sections or the
      dashboard layout; Left column formula untouched.
- [ ] Combined create+categorize follows task 05's `_log`-first ordering and dedup.
- [ ] Body validated with zod; `INVALID_REQUEST` on bad input; `SHEET_NOT_FOUND` /
      `SHEET_WRITE_FAILED` per CLAUDE.md.
- [ ] Endpoint auth-gated; ownership enforced via verified google_id.
- [ ] `tsc --noEmit` passes.

## Agent kickoff prompt

> You are building the CleanSheets backend. Read CLAUDE.md before starting — especially
> the Security Requirements and Task Board sections. Tasks 01–05 are already built;
> reuse the save logic from `api/sheet/save.ts` via shared helpers in `lib/` (no
> cross-importing between api files). Implement task `tasks/06-new-category.md` exactly
> as scoped. When done, update TASKS.md.
