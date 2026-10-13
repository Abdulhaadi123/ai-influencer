-- ═════════════════════════════════════════════════════════════════════════════
-- 005 — credits: what an account has bought, spent, and been refunded
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Users buy packs of credits (a consumable in-app purchase, reported by RevenueCat),
-- and every generation spends the model's price. Like KIE's own wallet: prepaid,
-- charged on success, and credits never expire.
--
-- Three tables:
--
--   credit_ledger   one row per change to a balance. A balance is never stored; it is
--                   the sum of an account's rows, so it cannot drift from its history.
--   billing_events  every RevenueCat webhook we received, by RevenueCat's own event id
--                   (retries reuse it), so a delivery that arrives twice is credited once.
--   credit_packs    which store product gives how many credits.
--
-- This applies to a live database as it stands: nothing existing is touched, and
-- nothing is enforced until BILLING_ENFORCED=true (api/_lib/billing.js).


-- ─────────────────────────────────────────────────────────────────────────────
-- credit_ledger
-- ─────────────────────────────────────────────────────────────────────────────
--
--   purchase   +  a pack was bought (ref purchase:<store transaction id>)
--   grant      +  an admin gave credits (support, a reviewer's test account)
--   adjust     ±  an admin corrected a balance
--   spend      -  a generation was started; the price is taken up front, so two
--                 requests at once cannot both spend the same credits
--   refund     +  the generation failed (KIE refused it, or never finished), so
--                 its spend is given back (ref refund:<spend row id>)
--   clawback   -  a purchase was refunded by the store; the pack's credits are taken
--                 back (the balance may go below zero, which blocks spending until
--                 it is positive again)
--
-- `ref` is the idempotency key: inserting the same ref twice is a no-op, which is
-- what makes a retried webhook, a repeated sync and a worker sweep all safe.

create table credit_ledger (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references users(id) on delete cascade,
  kind         text not null,
  delta        numeric(14, 3) not null,
  ref          text unique,
  kie_task_id  text,
  model        text,
  note         text,
  created_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now(),

  constraint credit_ledger_kind_check check (kind in ('purchase', 'grant', 'adjust', 'spend', 'refund', 'clawback')),
  constraint credit_ledger_sign_check check (
    (kind in ('purchase', 'grant', 'refund') and delta > 0)
    or (kind in ('spend', 'clawback') and delta < 0)
    or (kind = 'adjust' and delta <> 0)
  )
);

-- An account's history, newest first — and its balance.
create index credit_ledger_user_idx on credit_ledger (user_id, id desc);
-- "Was this task paid for?" — asked when a job fails.
create index credit_ledger_task_idx on credit_ledger (user_id, kie_task_id) where kie_task_id is not null;
-- A spend whose request never reached KIE (the answer was lost): the worker gives it back.
create index credit_ledger_unsettled_idx on credit_ledger (created_at) where kind = 'spend' and kie_task_id is null;


-- ─────────────────────────────────────────────────────────────────────────────
-- billing_events
-- ─────────────────────────────────────────────────────────────────────────────
--
-- What was done with each delivery, so a missing credit can be traced:
--   credited      credits were added
--   clawed_back   credits were taken back after a refund
--   ignored       a kind of event (or a product) that is not ours to act on
--   unmatched     no account of ours matches the purchaser — look into it by hand
--   duplicate     the same store transaction arrived again under another event id
--   sandbox_off   a test purchase while sandbox purchases are switched off
--   test          RevenueCat's "send test event"

create table billing_events (
  id              text primary key,
  user_id         uuid references users(id) on delete set null,
  type            text not null,
  product_id      text,
  environment     text,
  transaction_id  text,
  outcome         text not null,
  credits         numeric(14, 3),
  details         jsonb not null default '{}'::jsonb,
  received_at     timestamptz not null default now()
);

create index billing_events_received_idx on billing_events (received_at desc);
create index billing_events_user_idx on billing_events (user_id, received_at desc) where user_id is not null;


-- ─────────────────────────────────────────────────────────────────────────────
-- credit_packs
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The product ids are the ones created in RevenueCat's Test Store. Real prices live
-- in the stores, not here; this only says how many credits a product is worth.
-- A product that is not listed (or is disabled) is never credited.

create table credit_packs (
  product_id  text primary key,
  credits     numeric(14, 3) not null,
  label       text,
  enabled     boolean not null default true,
  updated_at  timestamptz not null default now(),

  constraint credit_packs_credits_check check (credits > 0)
);

create trigger credit_packs_set_updated_at
  before update on credit_packs
  for each row execute function set_updated_at();

insert into credit_packs (product_id, credits, label) values
  ('credits_500',  500,  '500 credits'),
  ('credits_1500', 1500, '1,500 credits'),
  ('credits_5000', 5000, '5,000 credits');
