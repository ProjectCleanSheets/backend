# 41 — Shared handler plumbing and error classes

- **Status:** Backlog. From task 30 finding #3 (`tasks/30-code-health-review-findings.md`), accepted 2026-11-17.
- **Size:** 2 pts.

## Why
The `getVerifiedUser` → 401 block is copied 10×, `SheetsError` → status 5×, and `SaveFlowError`/`TransactionsError` are one class under two names.

## Scope
- `lib/errors.ts`: one `ApiError(status, code, message)` replacing both classes, and `sendFailure(res, err, label, fallbackMessage)` mapping `ApiError`, `SheetsError`, `EnableBankingError` and logging the rest (message only).
- A small helper for the auth check if it stays readable.
- Every response (status, code, message) stays byte-identical; verify the main endpoints against Preview before merging.
- Rides along: task 42.
