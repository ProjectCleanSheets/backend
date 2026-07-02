-- Users table: one row per Google account, keyed to the verified google_id.
-- Token columns hold AES-256-GCM ciphertext produced by lib/crypto.ts.
create table if not exists public.users (
  google_id text primary key,
  sheet_id text,
  column_mapping jsonb,
  bank_access_token text,
  bank_refresh_token text,
  google_refresh_token text,
  bank_token_expiry timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- RLS on with no policies: only the backend (service role, bypasses RLS) can
-- access this table. Per-user isolation is enforced in backend code.
alter table public.users enable row level security;
