# 43 — Comment and CLAUDE.md sweep

- **Status:** Backlog. From task 30 finding #5 (`tasks/30-code-health-review-findings.md`), accepted 2026-11-17.
- **Size:** 2 pts.

## Why
48 history references (`task NN`, `CR-NN`, `spec §7b`, dates) in `api/` and `lib/`; essay comments (`lib/time.ts`: 30 lines for 5); stale texts.

## Scope
- Apply task 31's comment rule: the *why* in present tense, no task numbers or dates.
- Fix: `transactions/index.ts` "pending shown instantly" (Danske sends none); the two "sign in via POST /api/auth/google" messages (sign-in is `POST /api/auth/session`).
- `CLAUDE.md`: complete Project Structure (all `lib/` files, `api/user/account.ts`); remove "likely the cause of TESTING #3" (task 29 ruled it out).

## Order
After 31.
