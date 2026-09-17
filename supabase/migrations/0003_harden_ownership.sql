-- ═════════════════════════════════════════════════════════════════════════════
-- 0003 — close the gaps a signed-in client could write through
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Row Level Security decides WHICH rows a user may touch. It does not decide
-- which COLUMNS, and it does not know that some writes must go through the API
-- so storage stays consistent. Every client holds the anon key and its own JWT,
-- so anything below was reachable with a hand-written request, no app needed.


-- ── Realtime: stop broadcasting deleted rows ─────────────────────────────────
--
-- Supabase does not apply RLS to DELETE events. 0001 originally set replica
-- identity FULL, which put the entire old row — result link, labels, task id —
-- into every DELETE event, visible to any subscriber on the table. At the
-- default only the primary key is sent. Idempotent: harmless on a database
-- that never had FULL.

alter table public.generation_jobs replica identity default;


-- ── assets: the server writes rows; the client may only link them ────────────
--
-- Before this, a client could:
--   • UPDATE byte_size to a negative number, making the storage quota endless;
--   • DELETE its asset rows directly, so stored bytes stopped counting against
--     the quota while the objects stayed in the bucket;
--   • INSERT rows the storage layer never created.
--
-- Rows are created by the API (upload-url, ingest) and removed by it (storage,
-- generations, influencers and account delete) using the service role, which
-- these grants do not affect. The one client write left is attaching a file to
-- an influencer after the create wizard saves (core/data/assets.js
-- linkToInfluencer), and it may only name an influencer the caller owns.

revoke insert, update, delete on public.assets from anon, authenticated;
grant update (influencer_id) on public.assets to authenticated;

drop policy if exists "assets: insert own" on public.assets;
drop policy if exists "assets: delete own" on public.assets;
drop policy if exists "assets: update own" on public.assets;

create policy "assets: link own"
  on public.assets for update
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and (
      influencer_id is null
      or exists (
        select 1 from public.influencers i
        where i.id = influencer_id and i.user_id = auth.uid()
      )
    )
  );


-- ── influencers: deleted only through the API ────────────────────────────────
--
-- A direct DELETE cascades the asset rows but cannot reach S3, leaving every
-- file the influencer owned in the bucket, uncounted and undeletable.
-- /api/influencers/delete sweeps the objects first.

revoke delete on public.influencers from anon, authenticated;
drop policy if exists "influencers: delete own" on public.influencers;


-- ── generations: one gallery entry per file ──────────────────────────────────
--
-- The screen that generated a result and the worker can both file it at the
-- same moment; each checked for an existing entry and both inserted. Duplicates
-- are removed first, keeping the earliest — the file itself is untouched.

delete from public.generations g
using public.generations keep
where g.asset_id = keep.asset_id
  and (g.created_at, g.id) > (keep.created_at, keep.id);

create unique index if not exists generations_asset_key
  on public.generations (asset_id);
