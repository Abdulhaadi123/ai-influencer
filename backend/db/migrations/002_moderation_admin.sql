-- ═════════════════════════════════════════════════════════════════════════════
-- 002 — content moderation, the admin panel, and what generation costs
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Four additions, one migration, because they share tables:
--
--   • users get a role (who may administer) and a status (who may use the app);
--   • assets remember whether their content was checked, and what it found;
--   • moderation_events record every refusal and every item held for review;
--   • generation_jobs remember what KIE charged for them (`creditsConsumed`).
--
-- Plus two small admin tables: an audit log of what admins did, and the model
-- price list the admin edits.
--
-- Every column added to an existing table is nullable or has a default, so this
-- applies to a live database without rewriting a row by hand, and the previous
-- release keeps working against it while a deploy rolls out.


-- ─────────────────────────────────────────────────────────────────────────────
-- users — role and status
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `role` is read from this row on every request (sessions are checked against
-- the database each time), so demoting an admin or suspending a user takes
-- effect on their very next call.
--
-- Nobody becomes an admin through the API. The first one is set by ADMIN_EMAILS
-- at server start or by SQL; after that an admin can promote another.

alter table users
  add column role             text not null default 'user',
  add column status           text not null default 'active',
  add column suspended_at     timestamptz,
  add column suspended_reason text,
  add constraint users_role_check   check (role in ('user', 'admin')),
  add constraint users_status_check check (status in ('active', 'suspended'));

create index users_suspended_idx on users (suspended_at) where status = 'suspended';


-- ─────────────────────────────────────────────────────────────────────────────
-- assets — has this file been looked at?
-- ─────────────────────────────────────────────────────────────────────────────
--
--   unchecked  never checked. Every row that existed before this migration, and
--              every new file until the first thing needs to use it.
--   clear      checked and allowed (a file held for human review is also clear:
--              the event says why, and a person decides)
--   blocked    checked and refused. Never handed out, never used as a reference,
--              never filed in a gallery.
--
-- A file is checked when it is first used as a reference or when a generated
-- result is stored — whichever comes first — and the answer is kept, so each
-- file is classified once.

alter table assets
  add column moderation_status text not null default 'unchecked',
  add column moderated_at      timestamptz,
  add constraint assets_moderation_status_check check (moderation_status in ('unchecked', 'clear', 'blocked'));

-- The worker re-checks results it could not check the first time (the checker
-- was unreachable). Partial, so it stays tiny however large the table grows.
create index assets_unchecked_idx on assets (created_at) where moderation_status = 'unchecked';


-- ─────────────────────────────────────────────────────────────────────────────
-- generation_jobs — what KIE charged
-- ─────────────────────────────────────────────────────────────────────────────
--
-- KIE reports `creditsConsumed` (0 for a task that failed) when a task settles —
-- in `recordInfo` and in the callback. Null means KIE did not say, which is not
-- the same as free. (`costTime` is deliberately not kept: its unit is not
-- documented, and nothing here needs it.)

alter table generation_jobs
  add column kie_credits numeric(12, 3);

create index jobs_settled_idx on generation_jobs (completed_at desc) where state in ('success', 'fail');


-- ─────────────────────────────────────────────────────────────────────────────
-- moderation_events — every refusal, and everything held for a human
-- ─────────────────────────────────────────────────────────────────────────────
--
-- source   what was checked
--            prompt         the text sent with a generation request
--            prompt_assist  text sent to the suggestion endpoint
--            image / video  a file the user uploaded
--            output         something the generator produced
--            report         a person flagged a result themselves
-- action   what we did
--            blocked        the request or file was refused
--            review         let through, but a person should look
-- status   open until an admin decides: dismissed (the checker was wrong) or
--          confirmed (it was right)
--
-- Scores are stored; the content of an image never is. A prompt keeps a short
-- excerpt so a reviewer can see what was refused — it is deleted with the
-- account like everything else the user owns.

create table moderation_events (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,

  source       text not null,
  action       text not null,
  categories   text[] not null default '{}',
  scores       jsonb not null default '{}'::jsonb,
  excerpt      text,

  asset_id     uuid references assets(id) on delete set null,
  kie_task_id  text,
  model        text,

  status       text not null default 'open',
  reviewed_by  uuid references users(id) on delete set null,
  reviewed_at  timestamptz,
  review_note  text,

  created_at   timestamptz not null default now(),

  constraint moderation_events_source_check
    check (source in ('prompt', 'prompt_assist', 'image', 'video', 'output', 'report')),
  constraint moderation_events_action_check check (action in ('blocked', 'review')),
  constraint moderation_events_status_check check (status in ('open', 'dismissed', 'confirmed'))
);

-- What an admin works through, newest first.
create index moderation_events_open_idx on moderation_events (created_at desc) where status = 'open';
-- Strikes: one user's recent refusals.
create index moderation_events_user_idx on moderation_events (user_id, created_at desc);
create index moderation_events_asset_idx on moderation_events (asset_id) where asset_id is not null;


-- ─────────────────────────────────────────────────────────────────────────────
-- admin_audit_log — what admins did
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The admin's email is copied in, so the record survives the admin's account
-- being deleted. Append-only by convention: no endpoint updates or deletes here.

create table admin_audit_log (
  id           bigint generated always as identity primary key,
  admin_id     uuid references users(id) on delete set null,
  admin_email  text not null,
  action       text not null,
  target_type  text,
  target_id    text,
  details      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index admin_audit_created_idx on admin_audit_log (created_at desc);


-- ─────────────────────────────────────────────────────────────────────────────
-- model_prices — the price list the admin edits
-- ─────────────────────────────────────────────────────────────────────────────
--
-- One row per KIE model id. `credits` is what a use of the model costs a user,
-- in the app's own credits, measured per `unit`. The list is also a switch:
-- `enabled = false` refuses the model at the generation proxy.
--
-- A model with NO row is allowed and unpriced. That is deliberate — an empty
-- table must not stop every generation on the day this ships — and the admin
-- page lists models that are being used without a row so none is forgotten.

create table model_prices (
  model       text primary key,
  label       text,
  unit        text not null default 'per_video',
  credits     numeric(12, 3) not null default 0,
  enabled     boolean not null default true,
  note        text,
  updated_by  uuid references users(id) on delete set null,
  updated_at  timestamptz not null default now(),

  constraint model_prices_unit_check check (unit in ('per_second', 'per_video', 'per_image')),
  constraint model_prices_credits_check check (credits >= 0)
);

create trigger model_prices_set_updated_at
  before update on model_prices
  for each row execute function set_updated_at();
