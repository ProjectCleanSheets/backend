# CleanSheets Backend — Agent Instructions

## What This Is
Node.js backend deployed on Vercel (free tier). Serves as the bridge between the CleanSheets iOS app, Google Sheets API, Enable Banking PSD2 API, and Supabase database.

## Project Structure
```
backend/
├── api/
│   ├── auth/
│   │   ├── google.js          — Google OAuth sign in + callback
│   │   └── bank.js            — Enable Banking connect + callback
│   ├── sheet/
│   │   ├── structure.js       — read sheet tabs and category rows
│   │   └── save.js            — write transaction to sheet + _log tab
│   ├── transactions/
│   │   └── index.js           — fetch transactions from Enable Banking
│   └── user/
│       └── config.js          — get/post user config from Supabase
├── lib/
│   ├── supabase.js            — Supabase client singleton
│   ├── sheets.js              — Google Sheets API helper
│   ├── enablebanking.js       — Enable Banking API helper
│   └── crypto.js              — token encryption/decryption
└── package.json
```

## Responsibilities
1. Google OAuth — sign in, token exchange, refresh token management
2. Enable Banking OAuth — bank connection consent flow, token management
3. Google Sheets API — read current Actual cell value, add amount, write back, write to `_log` tab
4. Supabase — store and retrieve user config (sheet ID, column mapping, encrypted tokens)

Free tier enforcement is NOT implemented in this release. Skip it entirely.

## Tech Stack
- Runtime: Node.js on Vercel serverless functions
- Database: Supabase (PostgreSQL)
- Bank data: Enable Banking (PSD2)
- Sheet access: Google Sheets API v4
- Auth: Google Sign-In (ID token verification on every request)

## Authentication
Every request from the iOS app includes `Authorization: Bearer <google_id_token>` in the header. The backend verifies this token with Google on each request to identify the user. Never trust the user ID from the request body.

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
SUPABASE_ANON_KEY
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
ENABLE_BANKING_APP_ID
ENABLE_BANKING_PRIVATE_KEY     — full PEM contents as a single env var
ENABLE_BANKING_ENV             — "sandbox" or "production"
ENCRYPTION_KEY                 — AES-256 key for encrypting tokens in Supabase
```

Switching from sandbox to production is purely an `ENABLE_BANKING_ENV` change. No code changes required.

## Token Encryption
Before implementing, research current best practices for encrypting OAuth tokens stored in Supabase with Node.js on Vercel. Use AES-256 with `ENCRYPTION_KEY` env var. The crypto helper lives in `lib/crypto.js`.

## Supabase Schema
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

## Key Files to Read First
Before making changes, always read:
- `lib/supabase.js` — understand the client setup
- `lib/sheets.js` — understand how sheet navigation works
- `lib/enablebanking.js` — understand the API auth pattern

## External Documentation
- Enable Banking App ID: `aa4b88a1-8b11-4065-881c-44a4435887e0`
- Enable Banking sandbox redirect: `https://backend-beryl-phi-32.vercel.app/auth/bank/callback`
- Google OAuth redirect: `https://backend-beryl-phi-32.vercel.app/auth/google/callback`
- Vercel URL: `https://backend-beryl-phi-32.vercel.app`
- Supabase URL: `https://hywunivmwlzaopocrkub.supabase.co`
- Product spec: `/Users/kris/Documents/Projects/CleanSheets/Specs/SheetSync ProductSpec.docx`
- UI designs: `/Users/kris/Documents/Projects/CleanSheets/Designs/`
