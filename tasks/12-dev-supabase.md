# 12 — Separate dev Supabase project

- **Branch:** none (no code changes expected) — config + docs only
- **Depends on:** nothing; do BEFORE task 05 (it writes heavily during testing)
- **Story points:** 2

## Why

Local dev currently talks to the **production** Supabase project
(`hywunivmwlzaopocrkub`). All task 01–04 testing wrote real rows there. Before
task 05 starts read-modify-writing sheets and logs during tests, dev must point
at a throwaway database.

## Steps (mostly dashboard work by the owner; agent verifies)

1. In the Supabase dashboard (supabase.com/dashboard) → **New project** →
   name `cleansheets-dev`, same region as prod, generate a DB password (store it
   in the password manager; the backend never uses it directly).
2. Project **SQL Editor** → paste and run `supabase/migrations/001_users.sql`
   verbatim (it already grants only `service_role`; RLS on, no policies).
3. Project **Settings → Data API**: confirm "automatically expose new tables" /
   table exposure settings match production (tables NOT auto-exposed).
4. Project **Settings → API keys**: copy the project URL and the `service_role`
   key.
5. In `backend/.env` AND `backend/.env.local`: replace `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY` with the dev project's values. Do NOT touch the
   Vercel dashboard env vars — production keeps the prod project.
6. `ENCRYPTION_KEY` may stay the same (simplest) — tokens in the dev DB will be
   freshly written anyway.
7. Re-run both consent flows locally against the dev DB (user rows do not carry
   over): sign in via Swagger, `GET /api/auth/google?action=start` for Sheets
   consent, `GET /api/auth/bank` for the sandbox bank, then re-save config via
   `POST /api/user/config` (sheetId + columnMapping).
8. Update CLAUDE.md (Environment Variables section + External Documentation):
   local dev uses `cleansheets-dev`, production uses `hywunivmwlzaopocrkub`.
   Update the board's Deferred note (remove it — done).

## Acceptance criteria

- [ ] Local `GET /api/transactions` round-trips against the dev project
      (verify via Supabase dashboard: the dev `users` row updates, prod row's
      `updated_at` stays untouched).
- [ ] Production deployment still points at the prod project.
- [ ] CLAUDE.md documents which project is which; no keys committed to git.
