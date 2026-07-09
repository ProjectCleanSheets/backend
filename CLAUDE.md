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

## Project Structure
```
backend/
├── api/
│   ├── auth/
│   │   ├── google.ts          — Google OAuth sign in + callback
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
- Auth: Google Sign-In (ID token verification on every request)

## Authentication
Every request from the iOS app includes `Authorization: Bearer <google_id_token>` in the header. The backend verifies this token with Google on each request to identify the user. Never trust the user ID from the request body.

## Security Requirements
This backend handles financial data. Every task must satisfy these; task 09 audits them
before production use.

- **ID token verification**: verify signature via google-auth-library AND check audience
  (`aud === GOOGLE_CLIENT_ID`) and expiry. User identity comes ONLY from the verified
  token — never from request body/query.
- **Token encryption**: AES-256-GCM (authenticated encryption) with a random IV per
  value, key from `ENCRYPTION_KEY`. Never CBC/ECB.
- **Supabase access**: the backend uses `SUPABASE_SERVICE_ROLE_KEY` (RLS is enabled, so
  the anon key cannot access tables). The service role bypasses RLS — per-user isolation
  is enforced in code: every query filters by the verified caller's `google_id`.
- **OAuth CSRF**: both Google and Enable Banking consent flows use a `state` parameter
  bound to the user, validated on callback.
- **Ownership**: every read/write (transactions, saves, undo, config) operates only on
  rows and sheets belonging to the verified caller's `google_id`.
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
- `GOOGLE_TOKEN_EXPIRED` — Google auth token expired, user must re-sign in
- `SUPABASE_ERROR` — database read/write failed
- `CATEGORY_NOT_FOUND` — section+category lookup returned no matching row
- `INVALID_REQUEST` — malformed or missing required fields

## Environment Variables
Set in Vercel dashboard. Never hardcode secrets.

```
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY      — server-side only; RLS is enabled, anon key cannot access tables
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI            — optional; defaults to production callback, set to localhost in Development
ENABLE_BANKING_APP_ID
ENABLE_BANKING_PRIVATE_KEY     — full PEM contents as a single env var
ENABLE_BANKING_ENV             — "sandbox" or "production"
ENABLE_BANKING_REDIRECT_URI    — optional; defaults to production callback, set to localhost in Development
ENCRYPTION_KEY                 — AES-256-GCM key for encrypting tokens in Supabase
```

Switching from sandbox to production is purely an `ENABLE_BANKING_ENV` change. No code changes required.

## Token Encryption
Before implementing, research current best practices for encrypting OAuth tokens stored in Supabase with Node.js on Vercel. Use AES-256-GCM with `ENCRYPTION_KEY` env var (see Security Requirements). The crypto helper lives in `lib/crypto.ts`.

## Supabase Schema
The project has "automatically expose new tables" disabled: every new table's
migration MUST explicitly `grant all privileges on table ... to service_role`
(and never to anon/authenticated).

Users table keyed to Google ID. Stores:
- `google_id` (primary key)
- `sheet_id` — Google Sheet ID
- `column_mapping` — JSON object per section (e.g. `{ "Expenses": { "category_col": "F", "actual_col": "H" } }`)
- `bank_access_token` — encrypted
- `bank_refresh_token` — encrypted
- `bank_token_expiry`
- `google_refresh_token` — encrypted
- `created_at`, `updated_at`

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
- `lib/supabase.ts` — understand the client setup
- `lib/sheets.ts` — understand how sheet navigation works
- `lib/enablebanking.ts` — understand the API auth pattern

## External Documentation
- Enable Banking App ID: `aa4b88a1-8b11-4065-881c-44a4435887e0`
- Enable Banking sandbox redirect: `https://backend-beryl-phi-32.vercel.app/auth/bank/callback`
- Google OAuth redirect: `https://backend-beryl-phi-32.vercel.app/auth/google/callback`
- Vercel URL: `https://backend-beryl-phi-32.vercel.app`
- Supabase URL: `https://hywunivmwlzaopocrkub.supabase.co`
- Product spec: `/Users/kris/Documents/Projects/CleanSheets/Specs/SheetSync ProductSpec.docx`
- UI designs: `/Users/kris/Documents/Projects/CleanSheets/Designs/`
