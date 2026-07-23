-- Task 16 — provider-agnostic identity.
-- The users table was keyed to the Google login (google_id primary key). Sign in
-- with Apple means a user's login identity is no longer a Google account, so the
-- key becomes a provider-agnostic surrogate uuid plus a unique
-- (auth_provider, provider_subject). "Which Google account holds your sheet" is
-- now decoupled from login: google_refresh_token stays, but it no longer doubles
-- as the identity. Existing Google users migrate in place with no data loss —
-- their google_id becomes (provider='google', subject=google_id).

-- 1. New identity columns (nullable first so existing rows can be backfilled).
alter table public.users add column if not exists id uuid not null default gen_random_uuid();
alter table public.users add column if not exists auth_provider text;
alter table public.users add column if not exists provider_subject text;

-- 2. Backfill existing rows: every current user logged in with Google, and their
--    google_id is the Google `sub`.
update public.users
  set auth_provider = 'google', provider_subject = google_id
  where auth_provider is null;

-- 3. Enforce the identity columns now that they are populated.
alter table public.users alter column auth_provider set not null;
alter table public.users alter column provider_subject set not null;

-- 4. Swap the primary key from google_id to the surrogate id, make
--    (auth_provider, provider_subject) the unique natural key, and drop google_id
--    (a Google-login sub and an Apple-login sub can no longer be assumed equal to
--    the Google account that granted Sheets access, so the old column is retired).
alter table public.users drop constraint if exists users_pkey;
alter table public.users add primary key (id);
alter table public.users add constraint users_auth_identity_key unique (auth_provider, provider_subject);
alter table public.users drop column google_id;

-- 5. The bank pending-session initiator (task 15) referenced the initiator's
--    google_id; it now references the internal user id. Pending handles are
--    ephemeral (~2 min TTL) and rare, so clearing any in-flight rows before the
--    type change is safe and avoids casting a Google sub to a uuid.
delete from public.bank_pending_sessions;
alter table public.bank_pending_sessions drop column initiator_google_id;
alter table public.bank_pending_sessions add column initiator_user_id uuid not null;

-- Table-level grants already cover the new/renamed columns (service_role only);
-- altering columns does not change privileges, so no re-grant is needed.
