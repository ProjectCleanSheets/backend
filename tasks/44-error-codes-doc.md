# 44 — Document what each error code really covers

- **Status:** Backlog. From task 30 finding #6 (`tasks/30-code-health-review-findings.md`), accepted 2026-11-17.
- **Size:** 1 pt.

## Why
`SUPABASE_ERROR` also means Enable Banking outages and server config errors; `GOOGLE_TOKEN_EXPIRED` means any missing/invalid backend session; `INVALID_REQUEST` is returned with 400, 403, 404 and 409.

## Scope
Documentation only: describe each code's real uses in `openapi.json` and the Error Responses section of `CLAUDE.md`. No code renamed (that would be a contract change in both repos; revisit before a public launch). Tell the app via the ledger if its `SaveFailure` mapping (app 63) should change.
