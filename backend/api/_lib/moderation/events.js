/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Moderation events and strikes.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every refusal, and every item let through but held for a person, is a row in
 * `moderation_events`. Strikes are counted from those rows — there is no
 * counter on the user to drift out of step with them, and an admin who dismisses
 * an event (the checker was wrong) takes the strike back by that act alone.
 *
 * ── What counts as a strike ─────────────────────────────────────────────────
 *
 *   • only refusals of something the USER chose to submit for generation: a
 *     prompt, an uploaded image or video. Something the generator produced is
 *     not the user's doing, a person flagging a result is not an offence, and a
 *     suggestion request is not either — the app fires those on its own while
 *     someone is still typing, so counting them would punish a draft. The
 *     generator's own refusals (source `provider`) are not strikes either: it
 *     does not say whether the prompt, the reference or its own output was the
 *     trouble, so they are recorded for an admin to see and nothing more;
 *   • not dismissed;
 *   • inside the window (MODERATION_STRIKE_WINDOW_DAYS);
 *   • one per MINUTE. A single tap on "generate" sends three prompts at once,
 *     and a refusal of all three is one mistake, not three.
 */

import { one, query } from '../db.js'
import { suspendUser } from '../suspension.js'

/** Event sources that can be a strike — see the header. */
export const STRIKE_SOURCES = Object.freeze(['prompt', 'image', 'video'])

/** A reviewer needs to see what was refused, not a whole essay. */
export const EXCERPT_CHARS = 400

/**
 * @param {object} event
 * @param {string} event.userId
 * @param {'prompt'|'prompt_assist'|'image'|'video'|'output'|'report'|'provider'} event.source
 * @param {'blocked'|'review'} event.action
 * @param {string[]} [event.categories]
 * @param {Record<string, number>} [event.scores]
 * @param {string|null} [event.excerpt]
 * @param {string|null} [event.assetId]
 * @param {string|null} [event.taskId]
 * @param {string|null} [event.model]
 * @param {{query: Function}} [client]  a transaction client, to make the write part of one
 * @returns {Promise<{id: string}>}
 */
export async function recordEvent(
  { userId, source, action, categories = [], scores = {}, excerpt = null, assetId = null, taskId = null, model = null },
  client = null,
) {
  const run = client ? (text, params) => client.query(text, params) : query
  // A NUL in what a user typed would make PostgreSQL refuse the row, and the
  // refusal of a request must not turn into a server error because of it.
  const clean = value => (value === null || value === undefined ? null : String(value).replace(/\u0000/g, ''))
  const { rows } = await run(
    `insert into moderation_events (user_id, source, action, categories, scores, excerpt, asset_id, kie_task_id, model)
     values ($1, $2, $3, $4::text[], $5::jsonb, $6, $7, $8, $9)
     returning id`,
    [
      userId, source, action, categories, JSON.stringify(scores),
      excerpt ? clean(excerpt).slice(0, EXCERPT_CHARS) : null,
      assetId, taskId ? clean(taskId).slice(0, 200) : null, model ? clean(model).slice(0, 200) : null,
    ],
  )
  return rows[0]
}

/** @returns {Promise<number>} the user's current strikes */
export async function countStrikes(userId, windowDays) {
  const row = await one(
    `select count(distinct floor(extract(epoch from created_at) / 60))::int as strikes
       from moderation_events
      where user_id = $1
        and action = 'blocked'
        and source = any($2::text[])
        and status <> 'dismissed'
        and created_at > now() - $3::int * interval '1 day'`,
    [userId, STRIKE_SOURCES, windowDays],
  )
  return row?.strikes ?? 0
}

/**
 * After a refusal of something the user submitted: suspend them when it is the
 * one thing never tolerated, or when the strikes have reached the limit.
 *
 * Admins are never suspended automatically. Testing the checker is part of
 * their job, and an admin locked out by their own tests could not undo it.
 *
 * @param {string} userId
 * @param {{hardRule?: boolean, config: {strikeLimit: number, strikeWindowDays: number, suspendOnMinors: boolean}}} opts
 * @returns {Promise<{suspended: boolean, strikes: number}>} `suspended` is also true
 *          when they were suspended already
 */
export async function applyEnforcement(userId, { hardRule = false, config }) {
  const user = await one('select role, status from users where id = $1', [userId])
  if (!user) return { suspended: false, strikes: 0 }
  if (user.status === 'suspended') return { suspended: true, strikes: 0 }

  const strikes = await countStrikes(userId, config.strikeWindowDays)

  let reason = null
  if (hardRule && config.suspendOnMinors) reason = 'Content involving minors was refused.'
  else if (strikes >= config.strikeLimit) reason = `${strikes} content refusals in ${config.strikeWindowDays} days.`

  if (!reason || user.role === 'admin') return { suspended: false, strikes }

  // False from suspendUser means someone else suspended them a moment ago; either
  // way the account is suspended now, which is what the caller needs to know.
  await suspendUser(userId, reason)
  return { suspended: true, strikes }
}
