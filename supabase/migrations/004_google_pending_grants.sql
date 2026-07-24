-- Pending Google Sheets grants (task 17): the Google-consent counterpart of
-- bank_pending_sessions (migration 002). Task 16 dropped the old check that the
-- Google account granting Sheets access equalled the login account (an Apple-login
-- user connects a different Google account), which had incidentally blocked an
-- account-linking attack: the callback stored the exchanged refresh token under
-- whatever user the (attacker-controllable) OAuth `state` named.
--
-- Now the Google browser callback parks the exchanged refresh token here behind a
-- one-time `handle` instead of writing it onto a users row, and
-- POST /api/auth/google/finalize moves it onto the *verified* caller's row — so a
-- consent completed against someone else's flow can never attach Google Sheets
-- access to a stranger's account. Shares lib/pendinggrants.ts with the bank flow.
--
-- Its own table (not a column on bank_pending_sessions): the Google grant has no
-- valid_until (Google refresh tokens don't carry a consent expiry the way an
-- Enable Banking session does), so each table holds only the columns its flow
-- needs rather than a shared table with a nullable discriminator.
create table if not exists public.google_pending_grants (
  handle text primary key,                 -- opaque one-time token (base64url of 32 random bytes)
  refresh_ciphertext text not null,        -- AES-256-GCM(google refresh token) via lib/crypto.ts — same format as users.google_refresh_token
  initiator_user_id uuid not null,         -- who STARTED the flow (from the verified state); only this account may finalize
  expires_at timestamptz not null,         -- handle TTL (~2 min); a handle past this is rejected
  created_at timestamptz not null default now()
);

-- RLS on with no policies: only the backend (service role, bypasses RLS) can touch
-- this table, exactly like public.users and bank_pending_sessions. Handles are
-- consumed (deleted) on finalize; abandoned rows are harmless (expiry is checked
-- on read) and rare.
alter table public.google_pending_grants enable row level security;

-- "automatically expose new tables" is disabled, so privileges are explicit.
-- Only service_role — anon/authenticated get nothing.
grant all privileges on table public.google_pending_grants to service_role;
