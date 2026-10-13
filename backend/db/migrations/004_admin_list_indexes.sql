-- ═════════════════════════════════════════════════════════════════════════════
-- 004 — the admin panel's two default lists read their newest rows from an index
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Both lists open on "newest first", and neither table had an index that starts
-- with the date: every index here begins with user_id (an account's own rows,
-- which is what the app asks for). So the admin panel read and sorted the WHOLE
-- table to show 25 rows. Measured on a copy of the real schema holding 206,000
-- jobs and 20,000 accounts:
--
--     jobs list,  newest 25    331 ms  ->  0.2 ms
--     users list, newest 25     29 ms  ->  0.6 ms
--
-- and the cost of the "before" grows with every row added. (`id` is in both so the
-- order is total and a page boundary never repeats or skips a row.)
--
-- Plain CREATE INDEX: it takes a brief write lock on a table this size in
-- milliseconds. On a table that has grown large, build them with CREATE INDEX
-- CONCURRENTLY by hand first; `if not exists` then makes this a no-op.

create index if not exists users_created_idx on users (created_at desc, id);
create index if not exists jobs_created_idx on generation_jobs (created_at desc, id);
