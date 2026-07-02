# 03 — Google Sheet connection & structure reading

- **Branch:** `feature/sheet-setup`
- **Depends on:** 01 (independent of 02 — may be built in parallel)
- **Story points:** 8

## Scope

- `lib/sheets.ts` — Google Sheets API v4 helper:
  - Authenticate with the user's stored Google OAuth tokens (from Supabase, decrypted
    via `lib/crypto.ts`)
  - Handle token refresh automatically; surface `GOOGLE_TOKEN_EXPIRED` when re-auth needed
  - List all tabs in a spreadsheet
  - Read a column range from a given tab
  - Write a value to a specific cell
- `api/sheet/structure.ts`:
  - `GET /api/sheet/structure?sheetId` — return list of tab names
  - `GET /api/sheet/structure?sheetId&tab` — scan tab, return detected sections,
    categories, and column positions

The iOS app uses this to let the user confirm the auto-detected column mapping.
The backend does all scanning — the app just displays what it gets back.

## Out of scope

- Writing transaction amounts (task 05), budget aggregation (task 07)

## Acceptance criteria

- [ ] Structure detection finds sections (Expenses, Bills, Income, Save & Invest),
      their categories, and the category/Budget/Actual column positions on the real
      sheet layout (default F/G/H/I per CLAUDE.md).
- [ ] Only the authenticated user's stored tokens are used; sheetId access failures
      return `SHEET_NOT_FOUND`.
- [ ] Endpoints auth-gated; query params validated with zod (`INVALID_REQUEST`).
- [ ] Sheet contents never logged.
- [ ] `tsc --noEmit` passes.

## Agent kickoff prompt

> You are building the CleanSheets backend. Read CLAUDE.md before starting — especially
> the Security Requirements and Task Board sections. Tasks 01–02 are already built.
> Implement task `tasks/03-sheet-setup.md` exactly as scoped. When done, update TASKS.md.
