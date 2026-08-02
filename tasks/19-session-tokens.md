# 19 — Backend session tokens (access + refresh)

- **Branch:** `feature/session-tokens`
- **Depends on:** 16 (provider-agnostic identity — `getVerifiedUser` maps a verified
  `(provider, subject)` to the internal `user_id`), 17 & 18 (the endpoints whose auth
  this changes).
- **Story points:** 5
- **Source:** `../CROSS_REPO_LEDGER.md` → **CR-01** (app → backend). Blocks app task
  **05 — Auth foundation** (and transitively app 08, 09, 20).
- **Requires a coordinated iOS app change** — the app must re-copy `openapi.json` +
  `APP_INTEGRATION.md` and hold a backend-issued token pair instead of sending the
  raw identity token.

## Why

Today every authenticated request carries the raw **identity token** (Google ID
token or Apple identity token) and `lib/auth.ts` verifies it per request. That
model cannot work for Sign in with Apple: **Apple identity tokens expire in ~10
minutes and cannot be refreshed on-device**, so an Apple-login user would be
logged out every few minutes. Google ID tokens (~1 h) merely hide the problem.

The fix is the standard one: verify the identity token **once**, at sign-in, and
hand the app a backend-issued **access token** (short-lived) + **refresh token**
(long-lived, revocable). Every other endpoint then verifies the backend's own
token — no provider round-trip, no provider expiry semantics leaking into the app.

## Scope

1. **`lib/session.ts` (new)** — the token mechanism:
   - **Access token:** compact HS256 JWT, signed with a key derived from
     `ENCRYPTION_KEY` via HKDF (same pattern as the OAuth `state` key — **no new
     env var**). Claims: `iss`, `typ: "access"`, `sub` = internal `users.id`,
     `provider`, `iat`, `exp`. Verification is self-contained (no DB round-trip)
     and hard-pins `alg: HS256`.
   - **Refresh token:** opaque, 32 random bytes (base64url). Stored **hashed**
     (SHA-256) — never in plaintext — in a new `user_sessions` table, with the
     owning `user_id` and an expiry. **Rotated on every use** (single-use, like the
     task 15/17 handles): the presented token is deleted and a fresh pair issued.
2. **`api/auth/session.ts` (new)** — provider-agnostic, one file for the session
   feature area:
   - `POST /api/auth/session` — the **exchange**. `Authorization: Bearer
     <identity_token>` (Google or Apple). Verifies it, provisions the user row on
     first sight, returns `{ accessToken, refreshToken, expiresIn, userId, provider }`.
     This is the **only** endpoint that accepts an identity token.
   - `POST /api/auth/session/refresh` — body `{ refreshToken }`, **no** bearer
     (the refresh token is the credential). Returns a fresh pair in the same shape.
     Invalid / expired / already-used token, or a deleted account → **401
     `SESSION_EXPIRED`** (new error code) → the app must run a full sign-in.
     Routed via a `vercel.json` rewrite, matching the existing `finalize`/`status`
     pattern.
3. **`lib/auth.ts`** — split identity verification from request authentication:
   `getVerifiedUser` (imported by every `api/` file, signature unchanged) now
   verifies the **access token** only; the Google/Apple verifiers move behind
   `verifyIdentityToken`, used by the exchange endpoint. `AuthedUser` loses
   `subject`/`email` (see the two notes below).
4. **`supabase/migrations/005_user_sessions.sql`** — `user_sessions`
   (`token_hash` PK, `user_id`, `expires_at`, `created_at`), RLS on, `grant all
   privileges … to service_role` only, index on `user_id`.
5. **`api/user/account.ts`** — account deletion must also sweep `user_sessions`
   (a deleted account's sessions must die with it).
6. **`api/docs.ts`** — the Swagger page's "Sign in with Google" button must now
   exchange the ID token for an access token and attach *that* to Try-it-out
   requests (`/api/docs` is the primary manual test tool; it must keep working
   with one click).
7. **Contract:** `openapi.json` (two security schemes: identity token on the
   exchange, access token everywhere else) + `APP_INTEGRATION.md` §4, and
   `CLAUDE.md` (Authentication, Security Requirements, error codes, structure,
   schema). Flag for re-copy into `app/BackendContract/`.

## Decisions

- **Access-token TTL 1 h, refresh-token TTL 60 days (sliding).** Rotation gives
  each new refresh token a fresh 60 days, so an actively used session never
  expires; an untouched one dies in 60 days.
- **Identity tokens are rejected everywhere except the exchange.** Accepting both
  would keep the broken model alive; there are no shipped app users to break.
- **Access tokens are stateless** (no per-request DB lookup — a net saving, since
  the old model did a provider verify *and* a DB select on every request). The
  trade-off: an access token stays valid until its `exp` (≤ 1 h) even after account
  deletion. Harmless — deletion removes every row the token could reach, and a
  re-registration gets a brand-new uuid, so the `sub` is never reused.
- **Refresh-token reuse detection is out of scope.** Rotation invalidates a stolen
  token as soon as either party uses it (the loser gets logged out); detecting
  *which* party was the thief needs a consumed-token history. Noted as a possible
  follow-up, not built.
- **`login_hint` on the Google consent URL is dropped.** With per-request access
  tokens the login e-mail is no longer available, and since task 16 the login
  account is deliberately decoupled from the Google account that owns the sheet —
  hinting an Apple private-relay address at Google's chooser would be wrong. No
  PII is carried in tokens or session rows as a result.
- **Sign-out / explicit revoke endpoint is out of scope** (not in CR-01). The app
  signs out by dropping its stored pair; `DELETE /api/user/account` revokes
  server-side. If the app needs a real remote logout, file a new ledger entry.

## Acceptance criteria

Verified 2026-08-02 by three harnesses (kept in the session scratchpad, not the
repo): a pure-crypto one over `verifyAccessToken`, a database one against
`cleansheets-dev`, and a live one over HTTP against `vercel dev`.

- [x] `POST /api/auth/session/refresh` returns a fresh pair; the **old refresh
      token is dead** (replay → 401 `SESSION_EXPIRED`); unknown → 401; expired →
      401 and the row is consumed anyway; the rotated access token works on a
      normal endpoint. Bad body → 400, oversized token → 400.
- [x] Every existing authenticated endpoint accepts the access token as Bearer.
      Live: 200 from `POST /api/auth/google`, `?action=start`, `GET /api/auth/bank`,
      `/api/auth/bank/status`, `/api/user/config`; past-auth structured errors from
      `/api/sheet/structure` (400), `/api/sheet/budget` (404 `SHEET_NOT_FOUND`),
      `/api/transactions` (401 `BANK_TOKEN_EXPIRED` — a *bank* consent code, not an
      auth rejection); 400 `INVALID_REQUEST` (never 401) from `/api/sheet/save`,
      its DELETE, `/api/sheet/category`, `POST /api/user/config`.
- [x] A raw identity token is **rejected (401)** on a normal endpoint — live with
      a real RS256-signed Apple-shaped token, and in the crypto harness.
- [x] Tampered token (flipped character, and a swapped `sub` carrying the original
      signature), wrong-key token, expired token (1 s / exactly-now / a day) all
      rejected; `alg` confusion impossible — `none` (signed and unsigned), HS512,
      RS256 and even a reordered header are rejected because the header is
      compared against one constant. A token signed with the **OAuth-state HKDF
      key** is also rejected, confirming key separation. 35/35 crypto cases.
- [x] `user_sessions` rows are hashed-only (asserted: the plaintext token appears
      nowhere in the stored row), expire ~60 days out, are granted to
      `service_role` only (a service-role select succeeds where the anon key gets
      `42501`), and are deleted by `DELETE /api/user/account` — live: two sessions
      on one user, delete → 0 rows and the *other device's* refresh token → 401.
- [x] `openapi.json`, `APP_INTEGRATION.md`, `CLAUDE.md` updated; migration 005
      applied to **both dev and prod** by the owner (verified directly).
- [x] `tsc --noEmit` green.
- [x] **Owner sign-in on `/api/docs` (2026-08-02)** — the one path no automated
      check can reach. A real Google identity token went through the page's
      automatic exchange; the dev database then showed a freshly provisioned
      `users` row (`c0f6365c…`, `google`, sub `106445…`, `sheet_id: null`) and one
      `user_sessions` row for it expiring 2026-10-01 — i.e. first-sign-in
      provisioning **and** identity token → session pair, over HTTP, with a
      genuine provider token. An *invalid* Google identity token → 401 was already
      verified live.

## Notes for the owner

- **`APPLE_CLIENT_ID` is not set in the local `.env`**, so Apple sign-in cannot be
  exercised locally at all: `verifyAppleToken` throws on the missing env var and
  the exchange answers 500 (correct — a misconfiguration is not a bad token).
  Pre-existing since task 16, which likewise deferred true Apple E2E to the iOS
  button. Set it in Vercel before Apple login ships.
- The dev `users` table has been **empty since task 18's live deletion test**, so
  there is no sheet/bank-configured dev user. Nothing here depends on one, but
  re-running the task 03/04/07 data paths needs a fresh sign-in + reconnect first.
- The board's older notes say migrations 002→004 are "prod pending" — they are
  **applied to prod now** (verified 2026-08-02), along with 005.

## Agent kickoff prompt

> Read CLAUDE.md and `../CROSS_REPO_LEDGER.md` (CR-01) first. Implement
> `tasks/19-session-tokens.md`: verify the Google/Apple identity token once at
> sign-in (`POST /api/auth/session`), mint a short-lived HS256 access token plus a
> hashed, rotating refresh token (`user_sessions`, migration 005), add
> `POST /api/auth/session/refresh`, and make `getVerifiedUser` verify the access
> token so every existing endpoint accepts it unchanged. Update `api/docs.ts` to
> exchange automatically, plus `openapi.json`, `APP_INTEGRATION.md` and CLAUDE.md.
> Do not exceed scope; the iOS change is tracked in the app repo.
