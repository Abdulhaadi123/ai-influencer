-- ═════════════════════════════════════════════════════════════════════════════
-- 011 — a small preview for every image and video
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The gallery drew each square from the full file: a 2K PNG of several megabytes for a square a few
-- hundred pixels wide, and for a video a real player that loaded part of the clip to show one still
-- frame. Opening a gallery cost tens of megabytes of mobile data before anything could be tapped.
--
-- Now the server keeps a small JPEG beside each image and video (api/_lib/thumbnails.js): the picture
-- scaled to 512 pixels wide, or a frame from the start of the clip. The app draws the squares from it
-- and fetches the full file only when one is opened.
--
--   thumb_key         the preview's object key, beside the file's own and under the same user's
--                     prefix; null until it exists
--   thumb_checked_at  when making it was last tried. Set on success and on a file that cannot have
--                     one (unreadable, not an image or video), so neither is tried again; left null
--                     when the attempt failed for a reason that may pass (no ffmpeg, storage down),
--                     so the worker tries again later
--
-- Both nullable and without a default, so this applies to a live table in an instant and the previous
-- release keeps working against it. Existing files get their previews from the worker, newest first
-- (server/worker.js, sweepThumbnails).

alter table assets add column thumb_key text;
alter table assets add column thumb_checked_at timestamptz;

-- What the worker's sweep reads: files still waiting for a preview, newest first.
create index assets_thumb_todo_idx on assets (created_at desc)
  where thumb_key is null and thumb_checked_at is null and kind in ('image', 'video');
