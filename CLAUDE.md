# CleanSheets Backend — Agent Instructions

## What This Is
TypeScript backend deployed on Vercel (free tier). Serves as the bridge between the CleanSheets iOS app, Google Sheets API, Enable Banking PSD2 API, and Supabase database.

## Task Board
`TASKS.md` is the single source of truth for what to work on. Each task has a file in
`tasks/` defining its branch, scope, and acceptance criteria — **never exceed the scope
of the assigned task file**.

The board MUST be kept up to date as the project grows:
- Move a task to In Progress when starting it, to Done when its branch is merged.
- Any newly discovered work gets a task file in `tasks/` and a Backlog entry (with
  Fibonacci story points) BEFORE implementation starts. No untracked work.

## Cross-Repo Ledger
Work the **app** needs from this backend (and vice versa) is tracked in
`../CROSS_REPO_LEDGER.md` — a shared file at the project root, outside both git
repos, that both agents read and write directly. It is separate from `TASKS.md`
(this repo's own board) and from `openapi.json` (the API contract).

At the **start of every session, read that file.** If it has an `OPEN` entry
directed `→ backend`, you own it: file it on this board (`TASKS.md` + a `tasks/`
file) and mark it `ACCEPTED`, or do it now if small. When you finish, set the
entry `DONE`, note anything the app side must then do (re-copy the contract, etc.),
and move it to the Log. When *you* need something from the app repo, add an entry
there before proceeding. Full protocol is in the file's header.

## Git Workflow
The owner reviews every change before it enters git history:
- **Never commit or push yourself.** Create the task's branch, implement on it, and
  leave ALL changes uncommitted in the working tree — the owner reviews the diff,
  then commits and pushes himself. This includes TASKS.md board edits and doc changes.
- Only commit/push when explicitly told to in the current session.

## Project Structure
```
backend/
├── api/
│   ├── auth/
│   │   ├── session.ts         — sign in (identity token → session) + refresh
│   │   ├── google.ts          — setup state + Google Sheets consent + callback
│   │   └── bank.ts            — Enable Banking connect + callback + status
│   ├── sheet/
│   │   ├── structure.ts       — read sheet tabs and category rows
│   │   ├── save.ts            — write transaction to sheet + _log tab
│   │   ├── category.ts        — create new category row
│   │   └── budget.ts          — budget overview data
│   ├── transactions/
│   │   └── index.ts           — fetch transactions from Enable Banking
│   ├── user/
│   │   └── config.ts          — get/post user config from Supabase
│   └── docs.ts                — Swagger UI (serves openapi.json)
├── lib/
│   ├── auth.ts                — request authentication + identity-token sign in
│   ├── session.ts             — backend access/refresh token mint, verify, rotate
│   ├── supabase.ts            — Supabase client singleton
│   ├── sheets.ts              — Google Sheets API helper
│   ├── enablebanking.ts       — Enable Banking API helper
│   └── crypto.ts              — token encryption/decryption
├── supabase/migrations/       — SQL migrations
├── tasks/                     — task board task files (see TASKS.md)
├── openapi.json               — OpenAPI spec, rendered at /api/docs
├── TASKS.md                   — task board
├── tsconfig.json
└── package.json
```

## Responsibilities
1. Google OAuth — sign in, token exchange, refresh token management
2. Enable Banking OAuth — bank connection consent flow, token management
3. Google Sheets API — read current Actual cell value, add amount, write back, write to `_log` tab
4. Supabase — store and retrieve user config (sheet ID, column mapping, encrypted tokens)

Free tier enforcement is NOT implemented in this release. Skip it entirely.

## Tech Stack
- Language: TypeScript (all code, including `api/` functions — Vercel compiles `.ts` natively)
- Runtime: Node.js on Vercel serverless functions
- Database: Supabase (PostgreSQL)
- Bank data: Enable Banking (PSD2)
- Sheet access: Google Sheets API v4
- Auth: Sign in with Google or Apple (identity-token verification on every request)

## Authentication
Two token kinds, and the distinction matters (task 19):

- **Identity token** — a Google ID token or Apple identity token from the device's
  native sign-in. Accepted by **exactly one** endpoint, `POST /api/auth/session`,
  which verifies it (with Google, or against Apple's JWKS), maps the verified
  `(provider, subject)` to a stable internal `user_id`, provisions the row on
  first sign-in, and exchanges it for a session.
- **Access token** — the backend's own short-lived (1 h) HS256 token, carried as
  `Authorization: Bearer <access_token>` on **every other request** and verified
  locally by `getVerifiedUser` (`lib/auth.ts`). Paired with a long-lived,
  single-use refresh token (`POST /api/auth/session/refresh`) so the app renews a
  session without a fresh identity token — Apple's expire in ~10 minutes and
  cannot be refreshed on-device.

Never trust the user ID from the request body: identity always comes from the
verified token.

## Security Requirements
This backend handles financial data. Every task must satisfy these; task 09 audits them
before production use.

- **ID token verification**: identity is provider-agnostic (task 16). At sign-in
  (`POST /api/auth/session` → `signInWithIdentityToken`) the bearer token is a Google ID
  token (verified via google-auth-library, `aud === GOOGLE_CLIENT_ID`) or an Apple
  identity token (RS256 against Apple's JWKS, `iss === https://appleid.apple.com`,
  `aud === APPLE_CLIENT_ID`); both check signature and expiry, and map to a stable
  internal `user_id`. User identity comes ONLY from the verified token — never from
  request body/query.
- **Session tokens** (task 19): every other endpoint authenticates with the backend's own
  access token via `getVerifiedUser` — HS256 over a key derived from `ENCRYPTION_KEY`
  (HKDF, its own `info`), header pinned by construction so no `alg` is ever read from the
  token, and issuer/type/expiry/`sub` all checked. Refresh tokens are 32 random bytes,
  stored ONLY as a SHA-256 hash in `user_sessions`, and single-use: each refresh consumes
  the presented token and issues a new pair. Never log either token.
- **Token encryption**: AES-256-GCM (authenticated encryption) with a random IV per
  value, key from `ENCRYPTION_KEY`. Never CBC/ECB.
- **Supabase access**: the backend uses `SUPABASE_SERVICE_ROLE_KEY` (RLS is enabled, so
  the anon key cannot access tables). The service role bypasses RLS — per-user isolation
  is enforced in code: every query filters by the verified caller's internal `user_id`
  (`users.id`, from `getVerifiedUser`).
- **OAuth CSRF**: both Google and Enable Banking consent flows use a `state` parameter
  bound to the user, validated on callback.
- **Ownership**: every read/write (transactions, saves, undo, config) operates only on
  rows and sheets belonging to the verified caller's internal `user_id`.
- **Input validation**: validate every request body/query with zod; reject with
  `INVALID_REQUEST`. Bound amounts to sane numeric ranges.
- **No secret leakage**: never log tokens, PEM keys, or sheet contents. Error responses
  expose only the structured `code`/`message` — no stack traces.
- **Deferred**: rate limiting is not in MVP (Vercel free tier); revisit before public
  launch.

## Google Sheets Logic
The iOS app sends `{ section: "Expenses", category: "Groceries", amount: 195.32, transactionId: "abc123" }`. The backend is responsible for:
1. Finding the current month tab (named e.g. "July")
2. Scanning column F to find the row where section + category match
3. Reading the current Actual value from column H
4. Adding the transaction amount
5. Writing the new total back to column H
6. Writing a deduplication entry to the `_log` tab

The iOS app never sends cell references. All sheet navigation happens in the backend.

**Pending transactions (product decision 2026-07-11):** `GET /api/transactions`
includes reserved/pending bank transactions (marked `status: "pending"`) so users
can categorize a purchase instantly, while they still remember it. Accepted
trade-offs: the saved amount may drift from the finally booked amount, and (rarely)
a booked transaction reappears under a new id. Reconciliation is deferred to V2 —
see `tasks/04-transactions.md` for details. Do not change this behavior without a
new product decision.

## Sheet Column Mapping
Default columns (user-configurable, stored in Supabase):
- Column F — category names
- Column G — Budget
- Column H — Actual (read-modify-write target)
- Column I — Left (formula, never written to)

## Error Responses
Always return structured errors. Every error response must include a `code` field:
```json
{ "code": "SHEET_WRITE_FAILED", "message": "Human readable description" }
```

Error codes:
- `SHEET_WRITE_FAILED` — Google Sheets write failed
- `SHEET_NOT_FOUND` — tab or sheet not accessible
- `BANK_TOKEN_EXPIRED` — Enable Banking consent expired, user must reconnect
- `GOOGLE_TOKEN_EXPIRED` — missing/invalid/expired access token (or, at sign-in, a
  rejected identity token); the app refreshes the session and retries
- `SESSION_EXPIRED` — refresh token unknown, expired or already used; the session is
  over and the user must sign in again. Only `POST /api/auth/session/refresh` returns it
- `SUPABASE_ERROR` — database read/write failed
- `CATEGORY_NOT_FOUND` — section+category lookup returned no matching row
- `INVALID_REQUEST` — malformed or missing required fields

## Environment Variables
Set in Vercel dashboard. Never hardcode secrets.

```
SUPABASE_URL                   — production project on Vercel; the cleansheets-dev project in local .env
SUPABASE_SERVICE_ROLE_KEY      — server-side only; RLS is enabled, anon key cannot access tables
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI            — optional; defaults to production callback, set to localhost in Development
APPLE_CLIENT_ID                — Sign in with Apple audience: the app's Apple client id (iOS bundle id, or Services ID for web). Apple identity tokens are accepted only when `aud` matches. Required for Apple login (task 16)
ENABLE_BANKING_APP_ID
ENABLE_BANKING_PRIVATE_KEY     — full PEM contents as a single env var
ENABLE_BANKING_ENV             — "sandbox" or "production"
ENABLE_BANKING_REDIRECT_URI    — optional; defaults to production callback, set to localhost in Development
ENABLE_BANKING_CONSENT_DAYS    — optional, DEV ONLY: consent validity in days (float, (0, 180]; default 90). Short values (e.g. 0.01 ≈ 15 min) let the BANK_TOKEN_EXPIRED path be tested for real. Never set in production (Vercel)
ENCRYPTION_KEY                 — AES-256-GCM key for encrypting tokens in Supabase
```

Switching from sandbox to production is purely an `ENABLE_BANKING_ENV` change. No code changes required.

## Token Encryption
Before implementing, research current best practices for encrypting OAuth tokens stored in Supabase with Node.js on Vercel. Use AES-256-GCM with `ENCRYPTION_KEY` env var (see Security Requirements). The crypto helper lives in `lib/crypto.ts`.

## Supabase Schema
The project has "automatically expose new tables" disabled: every new table's
migration MUST explicitly `grant all privileges on table ... to service_role`
(and never to anon/authenticated).

Users table keyed to a provider-agnostic internal identity (task 16). Stores:
- `id` (uuid, primary key) — the stable internal user id every query filters on
- `auth_provider` + `provider_subject` — unique together; the login identity
  (`google`/`apple` and that provider's `sub`). A pre-Apple Google user migrates to
  `(google, <old google_id>)` with no data loss.
- `sheet_id` — Google Sheet ID
- `column_mapping` — JSON object per section (e.g. `{ "Expenses": { "category_col": "F", "actual_col": "H" } }`)
- `bank_access_token` — encrypted
- `bank_refresh_token` — encrypted
- `bank_token_expiry`
- `google_refresh_token` — encrypted; the Google Sheets consent, decoupled from login
  (an Apple-login user connects a Google account here; it need not match any login)
- `created_at`, `updated_at`

`user_sessions` holds the backend sessions (task 19): `token_hash` (SHA-256 of the
refresh token — the token itself is never stored), `user_id`, `expires_at`,
`created_at`. Rows are consumed on refresh and deleted with the account.

## Coding Principles
- Simple and readable over clever
- Each `api/` file handles one feature area — no cross-importing between api files
- Shared logic goes in `lib/` only
- Sandbox vs production controlled by env var, never by code branching on feature names
- No over-engineering — if it's not needed for the current feature, don't build it
- No free tier enforcement logic in this release
- Every added or changed endpoint MUST be reflected in `openapi.json` (rendered at
  `/api/docs`) in the same branch — the Swagger page is the primary manual test tool

## Key Files to Read First
Before making changes, always read:
- `TASKS.md` and your assigned task file in `tasks/` — scope and acceptance criteria
- `lib/auth.ts` + `lib/session.ts` — understand the two-token auth model
- `lib/supabase.ts` — understand the client setup
- `lib/sheets.ts` — understand how sheet navigation works
- `lib/enablebanking.ts` — understand the API auth pattern

## External Documentation
- Enable Banking App ID: `aa4b88a1-8b11-4065-881c-44a4435887e0`
- Enable Banking sandbox redirect: `https://backend-beryl-phi-32.vercel.app/auth/bank/callback`
- Google OAuth redirect: `https://backend-beryl-phi-32.vercel.app/auth/google/callback`
- Vercel URL: `https://backend-beryl-phi-32.vercel.app`
- Supabase URL (production): `https://hywunivmwlzaopocrkub.supabase.co` — used by the Vercel deployment ONLY
- Supabase URL (dev): `https://iwpsheuwrxatxnpgzhbk.supabase.co` (`cleansheets-dev`) — local dev talks to this one via `.env`/`.env.local`; both projects run the same migrations from `supabase/migrations/`
- Product spec: `/Users/kris/Documents/Projects/CleanSheets/Specs/SheetSync ProductSpec.docx`
- UI designs: `/Users/kris/Documents/Projects/CleanSheets/Designs/`
