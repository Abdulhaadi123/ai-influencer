-- ═════════════════════════════════════════════════════════════════════════════
-- 0002 — store each generated result once
-- ═════════════════════════════════════════════════════════════════════════════
--
-- A KIE result can be collected by the screen that started the job, by the
-- Queue tab's Save button, or by the worker. Before this, each of them copied
-- the bytes into S3 again and added another gallery entry.
--
-- The collectors now check for an existing copy first (backend/api/_lib/
-- results.js). This index closes the remaining gap — two collectors running at
-- the same moment: the second insert fails, and the collector that lost deletes
-- its own object and adopts the stored one.
--
-- Uploads carry no source_url and are not affected.
--
-- If the index cannot be created because duplicates already exist, find them
-- with:
--
--   select user_id, source_url, count(*) from public.assets
--   where source_url is not null group by 1, 2 having count(*) > 1;

create unique index if not exists assets_user_source_url_key
  on public.assets (user_id, source_url)
  where source_url is not null;

-- The worker sweeps finished jobs nobody collected (see server/worker.js).
create index if not exists jobs_uncollected_idx
  on public.generation_jobs (updated_at)
  where state = 'success' and asset_id is null;
