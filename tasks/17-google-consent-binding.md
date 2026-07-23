# 17 — Google Sheets callback: bind consent to the authenticated caller

- **Branch:** `feature/google-consent-binding`
- **Depends on:** 03 (Google Sheets consent), 15 (established the handle/finalize
  pattern for the bank flow — reuse it), 16 (introduced the regression; see below).
  **Precedes** [18 — Delete account & data](18-account-deletion.md) — if this adds
  a pending-grants table, deletion must sweep it, so build this first.
- **Story points:** 3
- **Requires a coordinated iOS app change** — like task 15, this is not backend-only.

> Reopened by task 16. The Google Sheets consent callback used to check that the
> Google account granting Sheets access equalled the login account
> (`ticket.getPayload()?.sub === googleId`). Task 16 **removed** that check on
> purpose — with Sign in with Apple, a user logs in with Apple but connects a
> *different* Google account for their sheet, so equality can no longer hold. That
> removal was correct for the feature, but it also removed the guard that
> incidentally blocked the account-linking attack. This task closes the hole the
> same way task 15 did for the bank flow.

## The vulnerability (account-linking / authorization-code injection CSRF)

`api/auth/google.ts` `handleCallback` now stores the exchanged Google **refresh
token** (full read/write to that Google account's spreadsheets) under whatever
internal `user_id` the signed `state` carries, with **no check that the account
which completed the Google consent is the caller who will hold it**. The callback
is a browser redirect from Google — there is no Bearer-verified user at that
point, only the `state`, which is bound to whoever *started* the flow.

Exploit: an attacker signs in (Google or Apple), calls
`GET /api/auth/google?action=start`, and gets a consent URL whose `state` is
HMAC-bound to the **attacker's** `user_id`. They phish the victim with it. The
victim signs into *their own* Google account and grants Sheets scope; Google
redirects to `/auth/google/callback?code=<victim>&state=<attacker>`. The backend
validates the state (attacker id), exchanges the victim's code into a refresh
token for the victim's Google account, and writes `google_refresh_token` onto the
**attacker's** row. The attacker then calls `GET /api/sheet/*` under their own
valid identity token and reads/writes the **victim's** spreadsheet.

This is the exact shape of the task 09 bank finding (task 15), now on the Google
side. Medium: the attack is phishing-dependent — the victim must open the
attacker's link, sign into Google, and actively approve Sheets access.

## Scope

Mirror task 15: move the credential persistence out of the browser redirect and
behind an authenticated step, so the refresh token can only ever land on the row
of the Bearer-verified caller — never on the identity a `state` claims.

1. `GET /auth/google/callback` — exchange the code, but instead of writing to
   `users.google_refresh_token`, mint a short-lived (≤2 min) single-use **handle**
   mapping to the encrypted refresh token server-side. Redirect to
   `cleansheets://oauth/google?status=success&handle=<handle>` (deny path
   unchanged). Prefer to **generalise the task-15 `bank_pending_sessions`
   mechanism** rather than copy it — e.g. a shared `oauth_pending_grants` table,
   or a second table with the same shape (`handle`, encrypted payload,
   `initiator_user_id`, `expires_at`). Pick the simpler option and note why.
2. New `POST /api/auth/google/finalize` — auth-gated (`getVerifiedUser`), body
   `{ handle }`. Looks up the pending grant, and only if
   `initiator_user_id === verified caller` stores `google_refresh_token` under the
   verified caller's `user_id`, then consumes (deletes) the handle. A victim who
   completed consent from an attacker's link would finalise under their own
   identity (or the handle just expires) — the token can never reach the
   attacker's row.
3. iOS app: after `ASWebAuthenticationSession` returns the `handle`, call
   `POST /api/auth/google/finalize` with the user's identity token. (File
   separately in the app repo; link it here.)
4. `openapi.json`: document `POST /api/auth/google/finalize` and the changed
   callback redirect (Swagger is the manual test tool).
5. Any new/changed table must `grant all privileges ... to service_role` only
   (schema rule in CLAUDE.md). If `bank_pending_sessions` is generalised, keep the
   task-15 bank flow working.

## Acceptance criteria

- [ ] A Google consent completed against a `state` bound to a *different* user
      never results in that user holding `google_refresh_token` — verify by
      reproducing the attack pre-fix (token lands on initiator row) and confirming
      post-fix it lands only via the authenticated finalize call.
- [ ] Google Sheets features (structure, budget, save, undo, new category) still
      work end-to-end after the two-step connect — verified live via `/api/docs`.
- [ ] Handle is single-use and time-bounded; a replayed or expired handle is
      rejected; only the initiator may finalise it.
- [ ] The bank connect flow (task 15) still works if its table/helper was reused.
- [ ] New endpoint + redirect change reflected in `openapi.json`.
- [ ] Any new table granted only to `service_role`.

## Agent kickoff prompt

> Read CLAUDE.md first. Implement `tasks/17-google-consent-binding.md`: close the
> Google-Sheets-consent account-binding hole reopened by task 16, using the same
> handle/finalize pattern task 15 applied to the bank flow — move
> `google_refresh_token` persistence behind an authenticated
> `POST /api/auth/google/finalize` keyed to the Bearer-verified caller, with a
> short-lived single-use handle handed back through the deep link. Prefer
> generalising `bank_pending_sessions` over duplicating it, and keep the bank flow
> working. Update `openapi.json`. Do not exceed scope; the iOS change is tracked
> separately.
