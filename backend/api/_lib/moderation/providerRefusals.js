/**
 * ─────────────────────────────────────────────────────────────────────────────
 * When the generator's own filter refuses a task.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A task KIE refuses on content grounds comes back `fail` with a failMsg such as
 *
 *   "The input or output was flagged as sensitive. Please try again with
 *    different inputs."
 *
 * (observed against the real service for sexual and graphic-violence prompts, on
 * a model with KIE's `nsfw_checker` and on nano-banana-pro alike; nothing is
 * charged). The job shows that text to its owner. This file makes the same fact
 * visible to an admin, as a moderation event with source `provider`.
 *
 * It is a record, not a penalty: the generator does not say whether the prompt,
 * the reference picture or what it was about to draw was the trouble, so it is
 * not a strike (STRIKE_SOURCES does not include it) and nobody is suspended for it.
 *
 * KIE documents no failCode for this, so the message is what there is to go on.
 * The match is deliberately about content wording, so an "Internal Error" or a
 * timeout is never mistaken for a refusal; a refusal worded in some new way is
 * simply not recorded here, and still fails the job exactly as before.
 */

import { recordEvent } from './events.js'

const REFUSAL_WORDING = /flagged as sensitive|sensitive content|content (policy|violation|moderation)|violates? (our |the )?(content|usage) polic|nsfw|prohibited content|inappropriate content/i

/** Does a failed task's message read as a content refusal by the generator? */
export function isProviderContentRefusal(failMsg) {
  return typeof failMsg === 'string' && REFUSAL_WORDING.test(failMsg)
}

/**
 * Record the refusal for the job's owner. Never throws: it runs while a job is
 * being settled, and a note for an admin must not undo or hide the settling.
 *
 * @returns {Promise<boolean>} whether an event was written
 */
export async function recordProviderRefusal({ userId, taskId, model, failMsg }) {
  if (!isProviderContentRefusal(failMsg)) return false
  try {
    await recordEvent({
      userId,
      source: 'provider',
      action: 'blocked',
      categories: ['flagged-by-generator'],
      excerpt: failMsg,
      taskId,
      model,
    })
    return true
  } catch (e) {
    console.error('[moderation] could not record the generator refusal:', e?.message ?? e)
    return false
  }
}
