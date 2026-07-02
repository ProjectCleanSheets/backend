# 02 — Enable Banking connection

- **Branch:** `feature/bank-connect`
- **Depends on:** 01
- **Story points:** 8

## Scope

- `lib/enablebanking.ts` — Enable Banking API helper:
  - Load the private key PEM from `ENABLE_BANKING_PRIVATE_KEY` env var
  - Sign requests as JWTs using App ID `aa4b88a1-8b11-4065-881c-44a4435887e0`
  - Initiate an auth session (returns redirect URL for MitID)
  - Exchange the auth code for access + refresh tokens after callback
  - Handle token refresh
- `api/auth/bank.ts`:
  - `GET /api/auth/bank` — create Enable Banking auth session, return redirect URL
  - `GET /api/auth/bank/callback` — receive auth code, exchange tokens, encrypt with
    `lib/crypto.ts`, store in Supabase (incl. `bank_token_expiry`), redirect to app

## Out of scope

- Fetching transactions (task 04), bank status endpoint (task 08)

## Acceptance criteria

- [ ] Environment (sandbox/production) controlled solely by `ENABLE_BANKING_ENV` —
      no code branching on feature names.
- [ ] Consent flow carries a `state` parameter bound to the user, validated on
      callback (CSRF protection) — tokens are stored only for the user who initiated.
- [ ] Tokens encrypted (AES-256-GCM via `lib/crypto.ts`) before storage; never logged.
- [ ] PEM key never logged or echoed in errors.
- [ ] Endpoints auth-gated (verified Google ID token); structured errors per CLAUDE.md
      (`BANK_TOKEN_EXPIRED` where relevant).
- [ ] `tsc --noEmit` passes.

## Agent kickoff prompt

> You are building the CleanSheets backend. Read CLAUDE.md before starting — especially
> the Security Requirements and Task Board sections. Task 01 (scaffold + auth) is
> already built; reuse `lib/crypto.ts` and `lib/supabase.ts`. Implement task
> `tasks/02-bank-connect.md` exactly as scoped. App ID, redirect URI, and env vars are
> in CLAUDE.md. When done, update TASKS.md.
