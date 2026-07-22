# 15 — Bank callback: bind consent to the authenticated caller

- **Branch:** `feature/bank-callback-binding`
- **Depends on:** 02 (bank connect), 09 (found this)
- **Story points:** 3
- **Requires coordinated iOS app change** — this is not a backend-only fix.

> Raised by the task 09 security review as a confirmed Medium finding (bank
> transaction data disclosure). This is the one **unresolved** finding gating
> `ENABLE_BANKING_ENV=production`: do not flip to production until this is Done
> or the owner explicitly accepts the residual risk.

## The vulnerability (account-linking / authorization-code injection CSRF)

`api/auth/bank.ts` `handleCallback` stores the exchanged Enable Banking session
under whatever `google_id` the `state` parameter carries, with **no check that
the account which completed the bank consent is the one that started the flow**.

The Google callback defends against exactly this at `api/auth/google.ts:127-133`
(`ticket.getPayload()?.sub === googleId`), but Enable Banking's `/sessions`
exchange returns no identity token (`lib/enablebanking.ts:196-201` — only
`session_id` + `valid_until`), so the bank callback has no equivalent guard and
trusts the attacker-controllable `state`. `exchangeCode` also passes only the
`code`, never the `state`, so there is no code↔state binding.

Exploit: an attacker signs in with their own Google account, calls
`GET /api/auth/bank` (choosing the victim's likely bank) and gets a consent URL
whose `state` is HMAC-bound to the **attacker's** `google_id`. They phish the
victim with it. The victim completes real SCA/MitID; Enable Banking redirects to
`/auth/bank/callback?code=<victim>&state=<attacker>`. The backend validates the
state (attacker id), exchanges the victim's code into a session that grants
access to the victim's accounts, and writes `bank_access_token` onto the
**attacker's** row. The attacker then calls `GET /api/transactions` under their
own valid Google ID token and reads the victim's account list and transactions
(`api/transactions/index.ts:109`).

## Scope

Move the credential persistence out of the browser redirect and behind an
authenticated step, so the session can only ever land on the row of the
Bearer-verified caller — never on the identity a `state` claims.

1. `GET /auth/bank/callback` — exchange the code, but instead of writing to
   Supabase, mint a short-lived (≤2 min) single-use **handle** (random opaque
   token) that maps to the exchanged session server-side (new
   `bank_pending_sessions` table, or an encrypted self-contained handle — pick
   the simpler one and note why). Redirect to
   `cleansheets://oauth/bank?status=success&handle=<handle>` (deny path
   unchanged).
2. New `POST /api/auth/bank/finalize` — auth-gated (`getVerifiedUser`), body
   `{ handle }`. Looks up the pending session, stores
   `bank_access_token`/`bank_token_expiry` under the **verified caller's**
   `googleId`, consumes (deletes) the handle. A victim completing consent from
   an attacker link would finalize under their own identity, or the handle
   simply expires unused — the session can never reach the attacker's row.
3. iOS app: after `ASWebAuthenticationSession` returns the `handle`, call
   `POST /api/auth/bank/finalize` with the user's Google ID token. (Filed
   separately in the app repo; link it here.)
4. `openapi.json`: document `POST /api/auth/bank/finalize` and the changed
   callback redirect (Swagger is the manual test tool).
5. If a `bank_pending_sessions` table is added, its migration must
   `grant all privileges ... to service_role` only (schema rule in CLAUDE.md).

## Acceptance criteria

- [ ] A consent completed against a `state` bound to a *different* user never
      results in that user holding the session — verify by reproducing the
      attack pre-fix (session lands on initiator row) and confirming post-fix it
      lands only via the authenticated finalize call.
- [ ] `GET /api/transactions` still works end-to-end after the two-step connect
      (verified live via /api/docs against the sandbox Mock ASPSP).
- [ ] Handle is single-use and time-bounded; a replayed or expired handle is
      rejected.
- [ ] New endpoint + redirect change reflected in `openapi.json`.
- [ ] Any new table granted only to `service_role`.

## Agent kickoff prompt

> Read CLAUDE.md first. Implement `tasks/15-bank-callback-binding.md`: close the
> bank-callback account-binding finding from task 09 by moving Enable Banking
> session persistence behind an authenticated `POST /api/auth/bank/finalize`
> step keyed to the Bearer-verified caller, with a short-lived single-use handle
> handed back through the deep link. Update openapi.json. Do not exceed the task
> scope; the iOS-side change is tracked separately.
