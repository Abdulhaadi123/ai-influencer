-- ═════════════════════════════════════════════════════════════════════════════
-- AI Influencer Studio — initial schema
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Replaces the app's former local-only storage (localStorage on web,
-- expo-sqlite on native) with a multi-tenant Postgres schema.
--
-- THE CENTRAL RULE: every row belongs to exactly one user, and Row Level
-- Security enforces it in the database rather than in application code. Even a
-- compromised client holding a valid JWT can only ever read or write its own
-- rows, because Postgres itself filters on auth.uid(). Application-side checks
-- are a convenience; this is the actual boundary.
--
-- Binary media never lives here. Files go to S3 and the `assets` table holds
-- the key plus its owner, so authorisation for a file is a database question.
-- Presigned URLs are minted on demand and never stored — they expire.

-- pgcrypto supplies gen_random_uuid(). Supabase enables it by default; the
-- guard keeps this migration runnable against a bare Postgres too.
create extension if not exists "pgcrypto";


-- ─────────────────────────────────────────────────────────────────────────────
-- Shared helpers
-- ─────────────────────────────────────────────────────────────────────────────

-- Keeps updated_at honest without every writer having to remember it.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- profiles — one row per auth user
-- ─────────────────────────────────────────────────────────────────────────────
--
-- auth.users is managed by Supabase Auth and should not be written to directly.
-- This is the application-owned mirror: display name, avatar, anything the
-- product wants to know about a person that Auth has no business storing.

create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text,
  display_name  text,
  avatar_key    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles: read own"
  on public.profiles for select
  using (auth.uid() = id);

create policy "profiles: update own"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Deliberately NO insert policy for clients: rows are created by the trigger
-- below, running as the definer. A client cannot manufacture a profile for
-- someone else because it cannot insert at all.

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();


-- Create the profile the moment Auth creates the user, so the rest of the app
-- can assume it exists. SECURITY DEFINER because the inserting session is the
-- auth service, not the new user.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ─────────────────────────────────────────────────────────────────────────────
-- assets — every file in S3, and who owns it
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The app used to store a URL wherever an image was needed: first a KIE result
-- URL (which expires within 24 hours), later a file:// path on the device
-- (which is invisible to every other device and dies with the install).
--
-- Now a file is a row. The row records the S3 key and the owner; the bytes live
-- in a private bucket that has no public read path at all. Handing someone a
-- file means minting a short-lived presigned URL after checking this table —
-- so "can this user see this image" is answered by RLS, not by URL secrecy.

create type public.asset_kind as enum ('image', 'video', 'audio');
create type public.asset_origin as enum ('generated', 'upload');

create table if not exists public.assets (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  -- Nullable: a reference image picked during the create wizard exists before
  -- the influencer it will belong to.
  influencer_id uuid,
  s3_key        text not null unique,
  kind          public.asset_kind not null,
  origin        public.asset_origin not null default 'generated',
  content_type  text,
  byte_size     bigint,
  width         integer,
  height        integer,
  -- Where it came from, for debugging and for re-running a generation.
  source_url    text,
  created_at    timestamptz not null default now()
);

create index if not exists assets_user_idx on public.assets(user_id, created_at desc);
create index if not exists assets_influencer_idx on public.assets(influencer_id);

alter table public.assets enable row level security;

create policy "assets: read own"   on public.assets for select using (auth.uid() = user_id);
create policy "assets: insert own" on public.assets for insert with check (auth.uid() = user_id);
create policy "assets: update own" on public.assets for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "assets: delete own" on public.assets for delete using (auth.uid() = user_id);


-- ─────────────────────────────────────────────────────────────────────────────
-- influencers
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Field names mirror the shape the app already used (see core/newInfluencer.js)
-- so the mapping layer stays mechanical. Image fields are asset references
-- rather than URLs — that is the whole point of the assets table.

create table if not exists public.influencers (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,

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

  -- The generated look, and the prompt that produced it.
  main_asset_id         uuid references public.assets(id) on delete set null,
  prompt                text default '',
  reference_asset_id    uuid references public.assets(id) on delete set null,
  copy_attributes       text[] not null default '{}',

  -- Identity reference sheets. Video generation reads all three.
  character_sheet_asset_id uuid references public.assets(id) on delete set null,
  closeup1_asset_id        uuid references public.assets(id) on delete set null,
  closeup2_asset_id        uuid references public.assets(id) on delete set null,

  audience              text default '',
  clothing_style        text default '',
  hobbies               text default '',
  location              text default '',
  palette               text[] not null default '{}',
  voice                 text default '',
  dream_brands          text default '',
  content_pillars       text[] not null default '{}',

  -- [{ id, name, asset_id }] — a small fixed list, not worth its own table.
  wardrobe_slots        jsonb not null default '[]'::jsonb,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists influencers_user_idx on public.influencers(user_id, created_at desc);

alter table public.influencers enable row level security;

create policy "influencers: read own"   on public.influencers for select using (auth.uid() = user_id);
create policy "influencers: insert own" on public.influencers for insert with check (auth.uid() = user_id);
create policy "influencers: update own" on public.influencers for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "influencers: delete own" on public.influencers for delete using (auth.uid() = user_id);

create trigger influencers_set_updated_at
  before update on public.influencers
  for each row execute function public.set_updated_at();

-- Deferred so the two tables can reference each other.
alter table public.assets
  add constraint assets_influencer_fk
  foreign key (influencer_id) references public.influencers(id) on delete cascade;


-- ─────────────────────────────────────────────────────────────────────────────
-- generations — the gallery
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Formerly `influencer.generationHistory`, an array embedded in the record.
-- Embedding meant rewriting the whole influencer to append one clip, and made
-- "show me everything I have generated" impossible to query.

create table if not exists public.generations (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  influencer_id uuid references public.influencers(id) on delete cascade,
  asset_id      uuid not null references public.assets(id) on delete cascade,
  kind          public.asset_kind not null,
  label         text not null default 'Generation',
  created_at    timestamptz not null default now()
);

create index if not exists generations_user_idx on public.generations(user_id, created_at desc);
create index if not exists generations_influencer_idx on public.generations(influencer_id, created_at desc);

alter table public.generations enable row level security;

create policy "generations: read own"   on public.generations for select using (auth.uid() = user_id);
create policy "generations: insert own" on public.generations for insert with check (auth.uid() = user_id);
create policy "generations: update own" on public.generations for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "generations: delete own" on public.generations for delete using (auth.uid() = user_id);


-- ─────────────────────────────────────────────────────────────────────────────
-- generation_jobs — the queue
-- ─────────────────────────────────────────────────────────────────────────────
--
-- KIE is asynchronous and slow, and its result URLs expire in 24 hours. The
-- taskId is the only durable handle, so it has to outlive the screen, the app
-- process, and now the device: moving the queue server-side means a job started
-- on a phone can be collected from a laptop.
--
-- `state` mirrors KIE's own vocabulary (waiting / queuing / generating /
-- success / fail) so nothing is lost in translation.

create table if not exists public.generation_jobs (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  influencer_id  uuid references public.influencers(id) on delete cascade,

  kie_task_id    text not null,
  kind           public.asset_kind not null default 'image',
  label          text not null default 'Generation',
  model          text,

  state          text not null default 'waiting',
  -- The expiring KIE URL, kept only until the bytes are copied into S3.
  result_url     text,
  -- Set once the result is safely in S3. Null means "not collected yet".
  asset_id       uuid references public.assets(id) on delete set null,
  fail_msg       text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  completed_at   timestamptz,

  -- One row per KIE task per user; makes registration idempotent on retry.
  unique (user_id, kie_task_id)
);

create index if not exists jobs_user_idx on public.generation_jobs(user_id, created_at desc);
create index if not exists jobs_active_idx
  on public.generation_jobs(user_id)
  where state in ('waiting', 'queuing', 'generating');

alter table public.generation_jobs enable row level security;

create policy "jobs: read own"   on public.generation_jobs for select using (auth.uid() = user_id);
create policy "jobs: insert own" on public.generation_jobs for insert with check (auth.uid() = user_id);
create policy "jobs: update own" on public.generation_jobs for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "jobs: delete own" on public.generation_jobs for delete using (auth.uid() = user_id);

create trigger jobs_set_updated_at
  before update on public.generation_jobs
  for each row execute function public.set_updated_at();


-- ─────────────────────────────────────────────────────────────────────────────
-- studio_settings — the video studio's remembered form state, per influencer
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.studio_settings (
  user_id       uuid not null references auth.users(id) on delete cascade,
  influencer_id uuid not null references public.influencers(id) on delete cascade,
  settings      jsonb not null default '{}'::jsonb,
  updated_at    timestamptz not null default now(),
  primary key (user_id, influencer_id)
);

alter table public.studio_settings enable row level security;

create policy "studio_settings: read own"   on public.studio_settings for select using (auth.uid() = user_id);
create policy "studio_settings: insert own" on public.studio_settings for insert with check (auth.uid() = user_id);
create policy "studio_settings: update own" on public.studio_settings for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "studio_settings: delete own" on public.studio_settings for delete using (auth.uid() = user_id);

create trigger studio_settings_set_updated_at
  before update on public.studio_settings
  for each row execute function public.set_updated_at();


-- ─────────────────────────────────────────────────────────────────────────────
-- creation_params — what an influencer was originally generated from
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Read back when regenerating a main image so the result is still the same
-- person. The model id is deliberately NOT stored: which model runs is decided
-- at call time, so persisting it would pin an influencer to whatever happened
-- to be current the day it was made.

create table if not exists public.creation_params (
  user_id       uuid not null references auth.users(id) on delete cascade,
  influencer_id uuid not null references public.influencers(id) on delete cascade,
  params        jsonb not null default '{}'::jsonb,
  updated_at    timestamptz not null default now(),
  primary key (user_id, influencer_id)
);

alter table public.creation_params enable row level security;

create policy "creation_params: read own"   on public.creation_params for select using (auth.uid() = user_id);
create policy "creation_params: insert own" on public.creation_params for insert with check (auth.uid() = user_id);
create policy "creation_params: update own" on public.creation_params for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "creation_params: delete own" on public.creation_params for delete using (auth.uid() = user_id);

create trigger creation_params_set_updated_at
  before update on public.creation_params
  for each row execute function public.set_updated_at();


-- ─────────────────────────────────────────────────────────────────────────────
-- brand_deals
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.brand_deals (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  influencer_id  uuid references public.influencers(id) on delete cascade,
  brand          text not null default '',
  category       text default '',
  status         text default 'Unposted',
  image_asset_id uuid references public.assets(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists brand_deals_user_idx on public.brand_deals(user_id, created_at desc);

alter table public.brand_deals enable row level security;

create policy "brand_deals: read own"   on public.brand_deals for select using (auth.uid() = user_id);
create policy "brand_deals: insert own" on public.brand_deals for insert with check (auth.uid() = user_id);
create policy "brand_deals: update own" on public.brand_deals for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "brand_deals: delete own" on public.brand_deals for delete using (auth.uid() = user_id);

create trigger brand_deals_set_updated_at
  before update on public.brand_deals
  for each row execute function public.set_updated_at();


-- ─────────────────────────────────────────────────────────────────────────────
-- Storage accounting
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Lets the backend enforce a per-user quota before minting an upload URL,
-- which is the only point where a client can cause us to store bytes.

create or replace function public.user_storage_bytes(p_user_id uuid)
returns bigint
language sql
stable
security definer set search_path = public
as $$
  select coalesce(sum(byte_size), 0)::bigint
  from public.assets
  where user_id = p_user_id;
$$;

revoke all on function public.user_storage_bytes(uuid) from public;
grant execute on function public.user_storage_bytes(uuid) to authenticated, service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- Realtime
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The queue badge and the Queue tab listen to `generation_jobs` over Realtime
-- instead of polling. That only works if the table is published, so it is done
-- here rather than left as a dashboard toggle someone has to remember.
--
-- The replica identity is deliberately left at its default. Row Level Security
-- gates INSERT and UPDATE events, but Supabase does not apply it to DELETE
-- events — Postgres cannot check access to a row that no longer exists. With
-- `replica identity full` a DELETE event carries the whole old row, so any
-- subscriber would receive other users' deleted jobs, result links included.
-- At the default it carries only the primary key. See migration 0003.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'generation_jobs'
  ) then
    alter publication supabase_realtime add table public.generation_jobs;
  end if;
end
$$;
