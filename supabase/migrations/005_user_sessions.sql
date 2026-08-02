-- Backend session tokens (task 19). Until now every authenticated request carried
-- the raw provider identity token (Google ID token / Apple identity token) and the
-- backend re-verified it per request. Apple identity tokens expire in ~10 minutes
-- and cannot be refreshed on-device, so that model logs Sign-in-with-Apple users
-- out constantly. The identity token is now verified once, at sign-in
-- (POST /api/auth/session), in exchange for a backend-issued pair: a short-lived
-- stateless access token (HS256, signed with a key derived from ENCRYPTION_KEY —
-- nothing stored here) and a long-lived refresh token, which is what this table
-- holds.
--
-- Only the SHA-256 *hash* of a refresh token is stored: a database leak then
-- yields no usable credential. The token itself is 32 random bytes and lives only
-- in the app's keychain. Refresh tokens are single-use — POST
-- /api/auth/session/refresh deletes the presented row and issues a new one
-- (rotation), the same consume-on-use discipline as the task 15/17 OAuth handles.
create table if not exists public.user_sessions (
  token_hash text primary key,             -- SHA-256(refresh token), hex — never the token itself
  user_id uuid not null,                   -- owner (users.id); every session is scoped to one internal user
  expires_at timestamptz not null,         -- refresh-token expiry (~60 days); rotation issues a fresh window
  created_at timestamptz not null default now()
);

-- Account deletion (task 18) and rotation both delete by user_id / token_hash;
-- the PK covers the latter, this covers the former.
create index if not exists user_sessions_user_id_idx on public.user_sessions (user_id);

-- RLS on with no policies: only the backend (service role, bypasses RLS) can touch
-- this table, exactly like public.users and the pending-grant tables. Expired rows
-- are harmless (expiry is checked on read) and are cleared by rotation, sign-in
-- churn, or account deletion.
alter table public.user_sessions enable row level security;

-- "automatically expose new tables" is disabled, so privileges are explicit.
-- Only service_role — anon/authenticated get nothing.
grant all privileges on table public.user_sessions to service_role;
