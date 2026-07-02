# 01 — Scaffold & auth foundation

- **Branch:** `feature/scaffold-auth`
- **Depends on:** nothing (first task)
- **Story points:** 5

## Scope

- TypeScript toolchain: `tsconfig.json`, `typescript`, `@types/node` — all code in this
  project is TypeScript (`.ts`), including Vercel functions in `api/`
- `package.json` with all dependencies needed across the entire project (install
  everything upfront: google-auth-library, googleapis, @supabase/supabase-js, node-jose,
  zod, dotenv, typescript, @types/node)
- `lib/supabase.ts` — Supabase client singleton using `SUPABASE_SERVICE_ROLE_KEY`
  (RLS is enabled on the project, so the anon key cannot access the users table;
  per-user isolation is enforced in code via the verified google_id)
- `lib/crypto.ts` — token encryption/decryption: AES-256-**GCM** (authenticated
  encryption), random IV per value, auth tag stored with ciphertext, key from
  `ENCRYPTION_KEY` env var. Never CBC/ECB. Research current best practice for Node.js
  on Vercel before implementing.
- `api/auth/google.ts` — Google OAuth: verify ID token, upsert user row; the OAuth
  callback must perform the code exchange and capture + store (encrypted) the
  **google_refresh_token with Sheets scope** (`https://www.googleapis.com/auth/spreadsheets`)
  — task 03 has no Sheets API credentials without it
- `api/user/config.ts` — GET and POST user config (`sheet_id`, `column_mapping`), auth-gated
- `supabase/migrations/001_users.sql` — users table schema per CLAUDE.md

## Users table schema

- `google_id` — primary key (text)
- `sheet_id` — text, nullable
- `column_mapping` — jsonb, nullable
- `bank_access_token`, `bank_refresh_token`, `google_refresh_token` — text, nullable, encrypted
- `bank_token_expiry` — timestamptz, nullable
- `created_at`, `updated_at` — timestamptz, default now()

## Out of scope

- Enable Banking (task 02), Sheets API helper (task 03), free-tier enforcement (never)

## Acceptance criteria

- [ ] Every endpoint verifies the Google ID token from the `Authorization` header:
      signature via google-auth-library, **audience === GOOGLE_CLIENT_ID**, expiry.
      User identity comes only from the verified token — never from body/query.
- [ ] Google OAuth flow uses a `state` parameter validated on callback (CSRF protection).
- [ ] Refresh token with Sheets scope is captured on OAuth callback, encrypted via
      `lib/crypto.ts`, and stored in Supabase.
- [ ] `lib/crypto.ts` round-trips (encrypt → decrypt) and rejects tampered ciphertext.
- [ ] All request bodies/queries validated with zod; invalid input returns `INVALID_REQUEST`.
- [ ] Structured errors with `code` field per CLAUDE.md; no stack traces or tokens in
      responses or logs.
- [ ] `tsc --noEmit` passes.

## Agent kickoff prompt

> You are building the CleanSheets backend. Read CLAUDE.md before starting — especially
> the Security Requirements and Task Board sections. Implement task
> `tasks/01-scaffold-auth.md` exactly as scoped; do not build anything from later tasks.
> Credentials and env vars are documented in CLAUDE.md and
> `/Users/kris/Documents/Projects/CleanSheets/Credentials/CREDENTIALS.md` — never
> hardcode them. When done, update TASKS.md.
