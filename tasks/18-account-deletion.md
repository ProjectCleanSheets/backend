# 18 — Delete account & data (App Store requirement)

- **Branch:** `feature/account-deletion`
- **Depends on:** 01 (users table), [16 — Sign in with Apple](16-apple-signin.md)
  (provider-agnostic identity), and [17 — Google Sheets callback binding](17-google-consent-binding.md)
  (may add a pending-grants table this endpoint must also sweep). See sequencing note.
- **Story points:** 3

> **App Store Review Guideline 5.1.1(v):** any app that supports account creation
> must let the user **initiate account and data deletion from inside the app**.
> The backend currently has no way to delete a user — this adds it. Hard blocker
> for App Store submission.

## Scope

- New **authenticated** endpoint that deletes the verified caller's account and
  all backend-stored data. Suggested: `DELETE /api/user/account` in a new
  `api/user/account.ts` (one feature area per file — don't fold it into
  `config.ts`). Route via `vercel.json` if the method/path needs it.
- Delete, for the verified caller only (never from body/query — identity comes
  from `getVerifiedUser`):
  - their `public.users` row,
  - any `public.bank_pending_sessions` rows they initiated,
  - any Google pending-grant rows they initiated, if task 17 added such a table
    (or the generalised pending-grants table, whatever shape 17 chose).
- **Best-effort** revoke of external grants before deleting the row (failures are
  logged, non-fatal — deletion must still succeed):
  - Google refresh token → `POST https://oauth2.googleapis.com/revoke`.
  - Enable Banking session → if we add a `DELETE /sessions/{id}` helper to
    `lib/enablebanking.ts`; otherwise the session simply lapses at `valid_until`.
- **Do NOT touch the user's Google Sheet** — it's their own document (including
  the `_log` tab). We only remove the data *we* store. Note this explicitly in
  the response/docs so it's a deliberate product decision, not an oversight.
- Idempotent: deleting when already gone returns a clean result, not a 500.
- `openapi.json`: document the endpoint (rendered at `/api/docs`).

## Sequencing note

Do [16 — Sign in with Apple](16-apple-signin.md) and
[17 — Google Sheets callback binding](17-google-consent-binding.md) **first**. 16
replaces the `google_id` primary key with the provider-agnostic identity this
endpoint deletes against, and 17 may introduce a pending-grants table this endpoint
must also sweep — building both first means the delete is written once against the
final schema, not reworked afterwards.

## Acceptance criteria

- [ ] Authenticated delete removes the caller's `users` row and their
      `bank_pending_sessions` rows (and any Google pending-grant rows from task 17)
      — verified gone in the DB.
- [ ] Google refresh token and bank session revocation attempted best-effort;
      a revocation failure is logged but does not fail the deletion.
- [ ] Only the caller's own data is affected (ownership enforced on the verified
      identity); no other user's rows change.
- [ ] Idempotent / safe when the account is already deleted.
- [ ] The user's spreadsheet content is left untouched.
- [ ] `openapi.json` updated; verified live via `/api/docs`.

## Agent kickoff prompt

> Read CLAUDE.md first (esp. Security Requirements — ownership + identity from the
> verified token only). Implement `tasks/18-account-deletion.md`: an authenticated
> endpoint that deletes the verified caller's `users` row and their
> `bank_pending_sessions` (and any Google pending-grant rows from task 17),
> best-effort-revokes their Google + bank grants, and
> leaves their spreadsheet untouched. Update `openapi.json`. Do not exceed scope.
