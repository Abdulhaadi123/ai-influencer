-- ─────────────────────────────────────────────────────────────────────────────
-- 012 — Signing in with Google (and, later, Apple)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- An account made with Google has no password: its owner proved who they are to Google, not to us.
-- So `users.password_hash` may be empty, and a new table says which outside account belongs to which user.
--
--   auth_identities   one row per (provider, subject): the provider's own stable id for the person.
--                     A Google account's `sub` never changes; its email can (a Workspace address is
--                     renamed), so the account is found by `sub` first and by email only to join an
--                     existing account the first time (api/auth/oauth.js).
--
-- An empty password_hash can never be matched: verifyPassword (api/_lib/passwords.js) answers false for
-- it, after the same slow work as for a wrong password. Such an account sets a password through the
-- usual "forgot password" email if it ever wants one.
-- Deleting the user deletes its identities.

alter table users alter column password_hash drop not null;

create table auth_identities (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  provider     text not null check (provider in ('google', 'apple')),
  -- The provider's own id for the person (Google: the token's `sub`).
  subject      text not null,
  -- The address the provider gave the last time they signed in. For the admin panel's eyes: it can
  -- differ from users.email, which is the address the account was made with.
  email        text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  unique (provider, subject)
);

create index auth_identities_user_idx on auth_identities (user_id);
