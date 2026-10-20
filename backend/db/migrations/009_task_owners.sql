-- ═════════════════════════════════════════════════════════════════════════════
-- 009 — a generation task belongs to the account that started it
-- ═════════════════════════════════════════════════════════════════════════════
--
-- KIE has one API key for the whole studio, so it will tell anyone who asks — through that key — how
-- any task of any account is doing and where its result is. Until now nothing tied a task id to the
-- account that made it: a second account that learned the id could register it as its own job, ask for
-- its status, and have the server copy the result (someone else's paid image or video) into ITS storage.
-- A task id is hard to guess, but a secret that is only protected by being hard to guess is one leak
-- from a problem; the server knows who started each task and now says so.
--
-- The proxy writes a row the moment KIE accepts a createTask (api/kie.js). Registering, syncing and
-- looking up a task refuse anyone but its owner. A task with no row (one started before this migration
-- that nothing could be backfilled for) behaves as it always did.
--
-- The backfill takes the owner from what already says who started a task: the credit spend made for it,
-- else the first account to register it.

create table task_owners (
  kie_task_id  text primary key,
  user_id      uuid not null references users(id) on delete cascade,
  created_at   timestamptz not null default now()
);

create index task_owners_user_idx on task_owners (user_id);

insert into task_owners (kie_task_id, user_id, created_at)
select distinct on (kie_task_id) kie_task_id, user_id, created_at
  from credit_ledger
 where kind = 'spend' and kie_task_id is not null
 order by kie_task_id, created_at asc
on conflict (kie_task_id) do nothing;

insert into task_owners (kie_task_id, user_id, created_at)
select distinct on (kie_task_id) kie_task_id, user_id, created_at
  from generation_jobs
 order by kie_task_id, created_at asc
on conflict (kie_task_id) do nothing;
