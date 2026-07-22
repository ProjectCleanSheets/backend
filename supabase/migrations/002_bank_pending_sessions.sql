-- Pending bank sessions (task 15): the Enable Banking browser callback exchanges
-- the auth code and parks the resulting session here behind a one-time `handle`,
-- instead of writing it straight onto a users row keyed by the (attacker-
-- controllable) OAuth `state`. The iOS app then calls POST /api/auth/bank/finalize
-- with the handle and its own Google ID token, and only then is the session moved
-- onto the *verified* caller's row. This closes the account-linking finding from
-- the task 09 security review: a consent completed against someone else's flow can
-- never attach to a stranger's account.
create table if not exists public.bank_pending_sessions (
  handle text primary key,                 -- opaque one-time token (base64url of 32 random bytes)
  session_ciphertext text not null,        -- AES-256-GCM(session_id) via lib/crypto.ts — same format as users.bank_access_token
  valid_until timestamptz not null,        -- bank consent expiry to store on finalize
  initiator_google_id text not null,       -- who STARTED the flow (from the verified state); only this account may finalize
  expires_at timestamptz not null,         -- handle TTL (~2 min); a handle past this is rejected
  created_at timestamptz not null default now()
);

-- RLS on with no policies: only the backend (service role, bypasses RLS) can
-- touch this table, exactly like public.users. Handles are consumed (deleted) on
-- finalize; abandoned rows are harmless (expiry is checked on read) and rare.
alter table public.bank_pending_sessions enable row level security;

-- "automatically expose new tables" is disabled, so privileges are explicit.
-- Only service_role — anon/authenticated get nothing.
grant all privileges on table public.bank_pending_sessions to service_role;
