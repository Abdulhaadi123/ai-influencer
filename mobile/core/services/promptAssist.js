/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Prompt assistant — rewrites what the user types into a stronger prompt.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Deliberately a SUGGESTION, never a replacement. The caller shows the result
 * next to the user's own text and lets them decide; nothing here writes back
 * into the field.
 *
 * Two flavours, because the two inputs want opposite things:
 *   • 'appearance' — describing how an influencer looks, for an image model.
 *   • 'script'     — words a person will actually say to camera.
 *
 * ── Where the model call happens ─────────────────────────────────────────────
 *
 * On the server. This module used to call api.openai.com directly with a key
 * inlined into the app bundle; that key is now held by /api/prompt-assist,
 * which authenticates the caller and rate-limits per user. The prompt text
 * itself is the only thing that leaves the device.
 *
 * The feature stays optional: with no key configured the endpoint answers 501
 * and `isAvailable()` goes false, so the suggestion UI never appears.
 */

import { apiFetch, ApiError } from '../api/client'

/** Below this, there is not enough intent to improve on. */
export const MIN_LENGTH = 12

/**
 * Whether the assistant is usable.
 *
 * Availability is a server fact now, so it is discovered rather than known: the
 * first request tells us, and the answer is remembered for the session. Until
 * then this returns true so the hook is allowed to try once — assuming
 * unavailable would mean the feature never appears even when it is configured.
 */
let available = true
export function isAvailable() {
  return available
}

/**
 * @param {string} text                what the user typed
 * @param {object} [opts]
 * @param {'appearance'|'script'} [opts.kind]
 * @param {AbortSignal} [opts.signal]  cancels a request the user has typed past
 * @returns {Promise<string|null>} the improved text, or null if not worth showing
 */
export async function improvePrompt(text, { kind = 'appearance', signal } = {}) {
  const input = (text || '').trim()
  if (input.length < MIN_LENGTH) return null
  if (!available) return null

  try {
    const json = await apiFetch('/api/prompt-assist', {
      method: 'POST',
      body: { text: input, kind },
      signal,
    })
    return json?.suggestion ?? null
  } catch (e) {
    // 501 means the server has no OpenAI key. That is a configuration state,
    // not a failure — stop asking for the rest of the session rather than
    // retrying on every keystroke pause.
    if (e instanceof ApiError && e.status === 501) {
      available = false
      return null
    }
    throw e
  }
}
