/**
 * ─────────────────────────────────────────────────────────────────────────────
 * When the prompt assistant should ask, show, or stay quiet.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Pure — no React, no platform APIs — so the rules can be tested on their own.
 * The hook owns the debounce, the abort and the caches; this owns the decision,
 * and the ORDER of these rules is the part that was wrong.
 *
 * Every request costs money and a rate-limit slot, so the default is silence:
 * only genuinely new text the user wrote is worth asking about.
 */

/** Show nothing and send nothing. */
export const CLEAR = 'clear'
/** Show a suggestion already held, without asking again. */
export const SHOW = 'show'
/** Debounce, then ask the assistant. */
export const REQUEST = 'request'

/**
 * @param {object} input
 * @param {string} input.text        what is in the field
 * @param {boolean} input.available  whether the server has an assistant at all
 * @param {number} input.minLength   below this there is no intent to improve on
 * @param {boolean} input.ignored    text the user did not write (see below)
 * @param {string|null|undefined} input.cached  a previous answer for this exact
 *        text; `undefined` means never asked, `null` means asked and not worth
 *        showing — which is still an answer and must not be asked again
 * @returns {{action: string, suggestion?: string|null, reason: string}}
 */
export function nextAction({ text, available, minLength, ignored = false, cached }) {
  const trimmed = (text || '').trim()

  if (!available) return { action: CLEAR, reason: 'no-assistant' }
  if (trimmed.length < minLength) return { action: CLEAR, reason: 'too-short' }

  // Before the cache, deliberately. Ignored text is text the user did not
  // write — a suggestion they just accepted, or a value restored from storage.
  // Asking about either sent the model its own output, or fired a request for a
  // field nobody had touched; between them a single edit could cost two calls.
  if (ignored) return { action: CLEAR, reason: 'not-user-input' }

  if (cached !== undefined) return { action: SHOW, suggestion: cached, reason: 'cached' }

  return { action: REQUEST, reason: 'new-text' }
}
