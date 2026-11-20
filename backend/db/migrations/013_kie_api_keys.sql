-- ═════════════════════════════════════════════════════════════════════════════
-- 013 — more than one KIE API key
-- ═════════════════════════════════════════════════════════════════════════════
--
-- KIE limits how many generations one account may start per ten seconds and how many may run at once.
-- With one key, that limit is the studio's ceiling: past it KIE answers 429 and people see failures.
-- This table is the pool the server draws from, one key per new request, round-robin
-- (api/_lib/kieKeys.js). Keys are added, paused and removed in the admin panel.
--
-- • The server's own KIE_API_KEY keeps working with no setup. It is the one row with source = 'env':
--   that row holds no secret — the value stays in the environment, as it always has — and exists so the
--   key takes its turn, can be paused and shows its use like any other.
-- • A key added in the panel is stored SEALED (AES-256-GCM, api/_lib/keyVault.js) with a secret that lives
--   only in the server's environment (KEY_VAULT_SECRET). A copy of the database alone holds no usable key.
-- • KIE only answers about a task for the key that started it, so task_owners remembers which key that was.
--   A task with no key recorded (everything before this migration) was started with the server's own key.
-- • Each KIE account has its own "Webhook HMAC key". A key from another account carries that account's,
--   so a callback it signs can be checked (api/kie-callback.js).

create table kie_api_keys (
  id              uuid primary key default gen_random_uuid(),
  source          text not null check (source in ('env', 'panel')),
  label           text not null,
  key_enc         text,                       -- the sealed API key; null for the server's own
  webhook_enc     text,                       -- the sealed webhook HMAC key of this key's KIE account (optional)
  key_hint        text,                       -- '…ab12': enough to tell two keys apart, never enough to use one
  fingerprint     text unique,                -- sha-256 of the key: the same key is not added twice
  enabled         boolean not null default true,
  last_used_at    timestamptz,                -- the rotation: the key used longest ago goes next
  uses            bigint not null default 0,
  cooldown_until  timestamptz,                -- KIE refused it; skipped until then unless every key is in the same state
  problem         text check (problem in ('rate_limited', 'no_credits', 'rejected', 'unreadable')),
  problem_at      timestamptz,
  balance         numeric,                    -- KIE credits left when last asked (a person pressed Check)
  balance_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check ((source = 'env') = (key_enc is null))
);

-- Exactly one row stands for the server's own key.
create unique index kie_api_keys_one_env on kie_api_keys (source) where source = 'env';

insert into kie_api_keys (source, label) values ('env', 'Server key (.env)');

alter table task_owners add column kie_key_id uuid references kie_api_keys(id) on delete set null;

-- "Is a running job still using this key?" before one is removed.
create index task_owners_key_idx on task_owners (kie_key_id) where kie_key_id is not null;
