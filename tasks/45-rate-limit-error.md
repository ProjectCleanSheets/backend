# 45 — Google rate limit reported as "sheet not found"

**Branch:** `bug/45-rate-limit-error` · **Points:** 1

## Problem
`toSheetsError` in `lib/sheets.ts` maps every Google failure it doesn't recognise to the
caller's fallback. A 429 (the Sheets read quota, 60 reads per minute per user) therefore
reaches the app as `SHEET_NOT_FOUND "Could not read the spreadsheet"`, which tells the
user their sheet is gone when they only need to wait a minute. Seen 2026-11-25 during
task 32's live run, which made many reads in a row; a single row edit stays well under
the quota.

## Scope
- Map a 429 from Google to an existing code with a message that says to try again
  shortly, without inventing a new code (see CLAUDE.md, Error responses).
- A committed test for the mapping.

## Out of scope
Retrying or backing off inside the backend.
