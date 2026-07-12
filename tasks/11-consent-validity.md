# 11 — Configurable consent validity (dev testing)

- **Branch:** `feature/consent-validity`
- **Depends on:** 02
- **Story points:** 1

## Why

`BANK_TOKEN_EXPIRED` (consent expired → user must reconnect) has never fired
end-to-end: consents are hardcoded to 90 days, and mutating `bank_token_expiry`
in the DB to simulate expiry is not a real test. A short-lived consent in dev
lets the whole expiry path be exercised for real: fetch works → consent lapses
→ fetch returns `BANK_TOKEN_EXPIRED` → reconnect flow heals it.

## Scope

- `lib/enablebanking.ts`: replace the `CONSENT_VALIDITY_DAYS = 90` constant with
  an optional `ENABLE_BANKING_CONSENT_DAYS` env var (float, so `0.01` ≈ 15 min),
  defaulting to 90. Bound it to (0, 180] — banks cap at 180 days under the SCA RTS.
- `.env.example` + CLAUDE.md env var list: document it as dev-only; production
  (Vercel) must NOT set it.

## Out of scope

- Any change to session storage, refresh semantics, or error mapping.

## Acceptance criteria

- [ ] Unset env var → behavior identical to today (90 days).
- [ ] With `ENABLE_BANKING_CONSENT_DAYS=0.01` in dev: connect bank, fetch
      transactions successfully, wait ~15 min, fetch again returns
      `BANK_TOKEN_EXPIRED`; reconnecting restores fetching.
- [ ] `tsc --noEmit` passes.

## Agent kickoff prompt

> You are building the CleanSheets backend. Read CLAUDE.md before starting.
> Implement task `tasks/11-consent-validity.md` exactly as scoped. When done,
> update TASKS.md.
