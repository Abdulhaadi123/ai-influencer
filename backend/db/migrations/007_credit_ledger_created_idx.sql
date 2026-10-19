-- ═════════════════════════════════════════════════════════════════════════════
-- 007 — the Credits page reads the ledger by date, so the ledger gets a date index
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Every index on credit_ledger begins with user_id (an account's own history, which is what
-- the app asks for) or is partial (the unsettled-spend sweep). The admin Credits page asks
-- the other question — "what was bought and spent in the last N days, across everyone" — and
-- without an index that starts with the date it reads the WHOLE ledger to answer it. That is
-- fine for a few thousand rows and slower with every purchase and every generation after.
--
-- Plain CREATE INDEX: on a ledger this young it takes milliseconds. On one that has grown
-- large, build it with CREATE INDEX CONCURRENTLY by hand first; `if not exists` then makes
-- this a no-op (the same note as 004).

create index if not exists credit_ledger_created_idx on credit_ledger (created_at desc, id desc);
