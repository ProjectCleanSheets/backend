# 42 — Two small naming fixes

- **Status:** Backlog. From task 30 finding #7 (`tasks/30-code-health-review-findings.md`), accepted 2026-11-17.
- **Size:** 1 pt.

## Scope
- Rename `signIn()` in `api/auth/google.ts` to what it does (the setup-state call). The route stays: it is the contract.
- The production host `backend-beryl-phi-32.vercel.app` is a redirect default in both `google.ts` and `lib/enablebanking.ts`; put it in one constant in `lib/constants.ts`.

## Order
With 41.
