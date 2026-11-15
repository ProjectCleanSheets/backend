# 36 — Don't ask for the extra bank approval for old history

- **Status:** Done 2026-11-15. From Enable Banking's October 2026 changelog (core 0.16.9, 2026-11-05).
- **Size:** 1 pt.

## Why
Enable Banking added `access.transactions_extended_history` to `POST /auth`. It
**defaults to `true`**: where a bank needs a second consent or SCA for history older
than 90 days, the user is sent through it during connect. Banks that do this today
include the CBI Globe Italian banks, Swedbank, LHV, Luminor, Artea and Šiaulių bankas.
Danske is not on the list.

The queue only fetches 30 days (`FETCH_WINDOW_DAYS` in `api/transactions/index.ts`),
so the extra approval would add friction for nothing once other banks are connected.
With `false`, the full history is still returned where the bank gives it without SCA.

## Scope
- In `startAuthSession` (`lib/enablebanking.ts`), send
  `access: { valid_until, transactions_extended_history: false }`.
- Test that the `/auth` body carries the field.
- Check once against the Mock ASPSP (sandbox) that connect still works.

## Done when
`/auth` requests carry `transactions_extended_history: false`, tests pass, and a
sandbox connect round-trips.

## Done
`startAuthSession` sends `transactions_extended_history: false`. Verified 2026-11-15:
stubbed `fetch` shows the `/auth` body as
`{"valid_until":"<whole seconds>Z","transactions_extended_history":false}`; a live
`POST /auth` was accepted by the sandbox (Mock ASPSP) and by production for Danske Bank
(auth started only, nothing authorised). `tsc` green. Takes effect on the next bank
connect; the existing consent is untouched.
