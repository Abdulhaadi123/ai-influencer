-- ═════════════════════════════════════════════════════════════════════════════
-- AI Influencer Studio — schema
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Plain PostgreSQL (16), run by backend/db/migrate.js when the API starts.
--
-- THE CENTRAL RULE: every row belongs to exactly one user, and only the backend
-- reads or writes this database. The app never connects to it — it calls the
-- API, which takes the user id from a verified session and puts it into every
-- query. There is no Row Level Security here because there is no untrusted
-- client connecting; the port is not reachable from outside the server.
--
-- Binary media never lives here. Files are in S3; `assets` holds each key and
-- its owner, so "may this user see this file" is a query, not a guess.

-- ─────────────────────────────────────────────────────────────────────────────
-- Shared helpers
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- users
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Passwords are stored only as Argon2id hashes (backend/api/_lib/passwords.js).
-- Emails are stored lower-cased by the API; the unique index is on lower(email)
-- as well, so a differently-cased duplicate cannot slip in another way.

create table users (
  id                  uuid primary key default gen_random_uuid(),
  email               text not null,
  password_hash       text not null,
  display_name        text,
  email_confirmed_at  timestamptz,
  password_changed_at timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index users_email_key on users (lower(email));

create trigger users_set_updated_at
  before update on users
  for each row execute function set_updated_at();


-- ─────────────────────────────────────────────────────────────────────────────
-- sessions — one row per signed-in device
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Tokens are random and high-entropy, so they are stored as SHA-256 hashes: a
-- leaked database does not contain a single usable token.
--
--   access token   short-lived; sent with every API call
--   refresh token  long-lived; exchanged for a new pair, and rotated each time
--
-- `previous_refresh_hash` catches a stolen refresh token being replayed after
-- the real app has already rotated it (see api/_lib/sessions.js). Deleting a
-- row is signing that device out, immediately — nothing keeps working until an
-- expiry the way a stateless token would.

create table sessions (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references users(id) on delete cascade,
  access_hash           text not null unique,
  access_expires_at     timestamptz not null,
  refresh_hash          text not null unique,
  previous_refresh_hash text,
  refresh_expires_at    timestamptz not null,
  rotated_at            timestamptz not null default now(),
  user_agent            text,
  created_at            timestamptz not null default now(),
  last_used_at          timestamptz not null default now()
);

create index sessions_user_idx on sessions (user_id);
create index sessions_previous_refresh_idx on sessions (previous_refresh_hash) where previous_refresh_hash is not null;


-- ─────────────────────────────────────────────────────────────────────────────
-- email_tokens — the one-time links in confirmation and reset emails
-- ─────────────────────────────────────────────────────────────────────────────

create table email_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  purpose     text not null check (purpose in ('confirm_email', 'reset_password')),
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index email_tokens_user_idx on email_tokens (user_id, purpose);


-- ─────────────────────────────────────────────────────────────────────────────
-- assets — every file in S3, and who owns it
-- ─────────────────────────────────────────────────────────────────────────────

create type asset_kind as enum ('image', 'video', 'audio');
create type asset_origin as enum ('generated', 'upload');

create table assets (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  -- Nullable: a reference picked in the create wizard exists before its influencer.
  influencer_id uuid,
  s3_key        text not null unique,
  kind          asset_kind not null,
  origin        asset_origin not null default 'generated',
  content_type  text,
  byte_size     bigint,
  width         integer,
  height        integer,
  -- The generator URL a result was copied from.
  source_url    text,
  created_at    timestamptz not null default now()
);

create index assets_user_idx on assets (user_id, created_at desc);
create index assets_influencer_idx on assets (influencer_id);

-- One stored copy per generator result. The API, the Queue tab and the worker
-- can all collect the same result; the loser of a race adopts the winner's copy
-- (api/_lib/results.js).
create unique index assets_user_source_url_key
  on assets (user_id, source_url)
  where source_url is not null;


-- ─────────────────────────────────────────────────────────────────────────────
-- influencers
-- ─────────────────────────────────────────────────────────────────────────────

create table influencers (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references users(id) on delete cascade,

  name                  text not null default '',
  gender                text,
  age                   text,
  type                  text not null default 'Influencer',

  niche                 text default '',
  niches                text[] not null default '{}',
  niche_custom          text default '',
  backstory             text default '',
  intro_extrovert       integer not null default 50,
  physical_desc         text default '',
  vibe_words            text[] not null default '{}',

  main_asset_id         uuid references assets(id) on delete set null,
  prompt                text default '',
  reference_asset_id    uuid references assets(id) on delete set null,
  copy_attributes       text[] not null default '{}',

  character_sheet_asset_id uuid references assets(id) on delete set null,
  closeup1_asset_id        uuid references assets(id) on delete set null,
  closeup2_asset_id        uuid references assets(id) on delete set null,

  audience              text default '',
  clothing_style        text default '',
  hobbies               text default '',
  location              text default '',
  palette               text[] not null default '{}',
  voice                 text default '',
  dream_brands          text default '',
  content_pillars       text[] not null default '{}',

  -- [{ id, name, asset_id }]
  wardrobe_slots        jsonb not null default '[]'::jsonb,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index influencers_user_idx on influencers (user_id, created_at desc);

create trigger influencers_set_updated_at
  before update on influencers
  for each row execute function set_updated_at();

alter table assets
  add constraint assets_influencer_fk
  foreign key (influencer_id) references influencers(id) on delete cascade;


-- ─────────────────────────────────────────────────────────────────────────────
-- generations — the gallery
-- ─────────────────────────────────────────────────────────────────────────────

create table generations (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  influencer_id uuid references influencers(id) on delete cascade,
  asset_id      uuid not null references assets(id) on delete cascade,
  kind          asset_kind not null,
  label         text not null default 'Generation',
  created_at    timestamptz not null default now()
);

create index generations_user_idx on generations (user_id, created_at desc);
create index generations_influencer_idx on generations (influencer_id, created_at desc);

-- One gallery entry per file, whichever collector files it first.
create unique index generations_asset_key on generations (asset_id);


-- ─────────────────────────────────────────────────────────────────────────────
-- generation_jobs — the queue
-- ─────────────────────────────────────────────────────────────────────────────
--
-- KIE has no endpoint that lists tasks, so this row is the only way back to a
-- result that was paid for. `state` uses KIE's own words (waiting / queuing /
-- generating / success / fail).

create table generation_jobs (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  influencer_id  uuid references influencers(id) on delete cascade,

  kie_task_id    text not null,
  kind           asset_kind not null default 'image',
  label          text not null default 'Generation',
  model          text,

  state          text not null default 'waiting',
  -- The expiring generator URL, kept only until the result is in S3.
  result_url     text,
  -- Set once the result is in S3. Null means "not collected yet".
  asset_id       uuid references assets(id) on delete set null,
  fail_msg       text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  completed_at   timestamptz,

  unique (user_id, kie_task_id)
);

create index jobs_user_idx on generation_jobs (user_id, created_at desc);
-- The app asks "what changed since I last looked" instead of receiving pushes.
create index jobs_user_updated_idx on generation_jobs (user_id, updated_at);
create index jobs_active_idx
  on generation_jobs (user_id)
  where state in ('waiting', 'queuing', 'generating');
create index jobs_uncollected_idx
  on generation_jobs (updated_at)
  where state = 'success' and asset_id is null;

create trigger jobs_set_updated_at
  before update on generation_jobs
  for each row execute function set_updated_at();


-- ─────────────────────────────────────────────────────────────────────────────
-- studio_settings and creation_params — small per-influencer JSON documents
-- ─────────────────────────────────────────────────────────────────────────────

create table studio_settings (
  user_id       uuid not null references users(id) on delete cascade,
  influencer_id uuid not null references influencers(id) on delete cascade,
  settings      jsonb not null default '{}'::jsonb,
  updated_at    timestamptz not null default now(),
  primary key (user_id, influencer_id)
);

create trigger studio_settings_set_updated_at
  before update on studio_settings
  for each row execute function set_updated_at();

-- What an influencer was generated from, so "Regenerate" makes the same person.
create table creation_params (
  user_id       uuid not null references users(id) on delete cascade,
  influencer_id uuid not null references influencers(id) on delete cascade,
  params        jsonb not null default '{}'::jsonb,
  updated_at    timestamptz not null default now(),
  primary key (user_id, influencer_id)
);

create trigger creation_params_set_updated_at
  before update on creation_params
  for each row execute function set_updated_at();
