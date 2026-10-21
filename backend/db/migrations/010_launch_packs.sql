-- ═════════════════════════════════════════════════════════════════════════════
-- 010 — the packs that go on sale: 5,000 / 10,000 / 20,000 credits
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The packs are decided: 5,000 credits for $20, 10,000 for $35 and 20,000 for $70. The prices live
-- in Google Play (and RevenueCat), not here — this table only says how many credits a product is worth,
-- and a product that is not listed here, or is disabled, is never credited (api/revenuecat-webhook.js).
--
-- The product ids to create in Play Console and RevenueCat are therefore:
--
--     credits_5000    5,000 credits    (already listed since 005: it was a Test Store pack too)
--     credits_10000   10,000 credits
--     credits_20000   20,000 credits
--
-- The two Test Store packs of 005, credits_500 and credits_1500, are left as they were. They are not
-- for sale anywhere real, so nothing is ever credited for them in production, and a development build
-- using RevenueCat's Test Store can still try them.
--
-- `on conflict do nothing`: this can be applied to a database where someone has already added a row by
-- hand, and then keeps theirs.

insert into credit_packs (product_id, credits, label) values
  ('credits_5000',  5000,  '5,000 credits'),
  ('credits_10000', 10000, '10,000 credits'),
  ('credits_20000', 20000, '20,000 credits')
on conflict (product_id) do nothing;
