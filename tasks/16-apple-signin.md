# 16 — Sign in with Apple (backend: provider-agnostic identity)

- **Branch:** `feature/apple-signin`
- **Depends on:** 01 (auth foundation + users table). **Precedes** [17 — Google Sheets callback binding](17-google-consent-binding.md) and [18 — Delete account & data](18-account-deletion.md) — 17 closes an account-linking hole this task reopens (removing the login==Sheets-account check), and 18 builds on the identity model this task establishes.
- **Story points:** 8
- **Backend portion only** — the iOS "Sign in with Apple" button and its wiring
  are separate app work, tracked in the app project.

> **App Store Review Guideline 4.8 (Login Services):** an app that offers a
> third-party/social login (Google) must also offer a login option that limits
> data to name+email, lets the user keep their email private, and does no
> tracking. **Sign in with Apple** satisfies this. This task adds the backend
> half: verifying Apple identity tokens and making user identity
> provider-agnostic.

## The core change

Today the backend fuses two things that must become separate:
- **Login identity** = the Google account (the `users` primary key is
  `google_id`; `getVerifiedUser` only verifies Google ID tokens).
- **Google Sheets access** = a Google refresh token from a *separate* consent.

Apple login means a user's identity is no longer a Google account. So identity
must become provider-agnostic, and "which Google account holds your sheet" must
be decoupled from "how you logged in."

## Scope

- **Verify Apple identity tokens** in `lib/auth.ts` alongside Google: fetch
  Apple's public keys (`https://appleid.apple.com/auth/keys`), verify the JWT
  signature, `iss === https://appleid.apple.com`, `aud ===` the app's Apple
  client/services id (new env var), and expiry. `getVerifiedUser` accepts a
  Google **or** Apple bearer token and returns one stable internal identity.
- **Identity model migration** (new SQL migration): replace the `google_id`
  primary key with a provider-agnostic identity — e.g. internal `user_id` (uuid)
  PK plus a unique `(auth_provider, provider_subject)`. Keep
  `google_refresh_token` / `bank_*` columns. **Migrate existing Google users
  without data loss** (their current `google_id` becomes
  `(provider='google', subject=google_id)`). New table grants: `service_role`
  only (schema rule in CLAUDE.md).
- **Decouple the Google Sheets connection from login** in `api/auth/google.ts`:
  the Sheets-consent callback currently requires the consenting Google `sub` to
  equal the login `googleId`. Change it to *bind the granted Google account to
  the currently-verified user* (of any provider), rather than requiring equality.
- **Update every query that filters on `google_id`** to the new identity key.
  `getVerifiedUser` is the single choke point, which contains the blast radius,
  but `saveflow.ts`, `sheets.ts`, `transactions`, `config`, `bank` all resolve
  the user and must use the new key.
- `openapi.json` / docs: the `Authorization: Bearer` may now be a Google **or**
  Apple token.

## Testing note

`/api/docs` mints only **Google** tokens (its Sign-in-with-Google button), so the
Apple path can't be exercised there directly — plan a test path that supplies a
real Apple identity token (from the app, or a small signing harness), and keep
verifying the Google path via `/api/docs` for regression.

## Acceptance criteria

- [ ] A request bearing a valid Apple identity token is authenticated and mapped
      to a stable internal user across requests.
- [ ] An Apple-authenticated user can connect Google Sheets and use every sheet
      feature (structure, budget, save, undo, new category).
- [ ] Existing Google-authenticated users keep working after the migration — no
      data loss; stored tokens/config intact; Google login still verifies.
- [ ] Per-user isolation still enforced on the new identity key; no cross-user
      reads/writes.
- [ ] Invalid/expired/wrong-audience Apple tokens are rejected (like Google).
- [ ] `openapi.json` updated.

## Agent kickoff prompt

> Read CLAUDE.md first (Security Requirements — ID token verification, identity
> from the verified token only, per-user isolation). Implement
> `tasks/16-apple-signin.md`: verify Apple identity tokens in `lib/auth.ts`,
> migrate the users table to a provider-agnostic identity without losing existing
> Google users, decouple the Google Sheets consent from the login account, and
> update all identity-keyed queries. Keep the Google path working. Update
> `openapi.json`. Do not exceed scope; the iOS side is tracked separately.
