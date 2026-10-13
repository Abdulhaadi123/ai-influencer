-- ═════════════════════════════════════════════════════════════════════════════
-- 003 — the generator's own refusals are moderation events too
-- ═════════════════════════════════════════════════════════════════════════════
--
-- KIE (and the models behind it) run their own content filters. When one of them
-- refuses a task — "The input or output was flagged as sensitive" — the job fails
-- and says so, but nothing reached the moderation queue, so an admin could not
-- see who was running into the filters or how often.
--
-- Those refusals are now recorded with source `provider`. They are NOT strikes:
-- the generator does not say whether the prompt, the reference image or its own
-- output was the problem (see api/_lib/moderation/events.js).
--
-- Only the check on `source` changes; no row is touched, so this applies to a
-- live database as it stands.

alter table moderation_events drop constraint moderation_events_source_check;

alter table moderation_events add constraint moderation_events_source_check
  check (source in ('prompt', 'prompt_assist', 'image', 'video', 'output', 'report', 'provider'));
