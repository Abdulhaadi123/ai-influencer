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
import { ASSIST_MAX } from '../config/inputLimits'

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
 * What comes back is an answer to show, not just a string: the stronger text (or null when
 * there is none worth offering) and, when the server has something to say about the text itself —
 * that it may go against the content guidelines, or that it could not be improved — a `notice`.
 * A refusal (`CONTENT_BLOCKED`) is an answer too, and is returned as one rather than thrown:
 * the person typing must be told, not shown nothing.
 *
 * @param {string} text                what the user typed
 * @param {object} [opts]
 * @param {'appearance'|'script'|'scene'} [opts.kind]
 * @param {AbortSignal} [opts.signal]  cancels a request the user has typed past
 * @returns {Promise<{suggestion: string|null, notice: {tone: 'blocked'|'warning'|'info', message: string}|null}|null>}
 *          null when there was nothing to ask
 */
export async function improvePrompt(text, { kind = 'appearance', signal } = {}) {
  const input = (text || '').trim()
  if (input.length < MIN_LENGTH) return null
  // The server refuses more than this (413). Asking would only cost a request and a rate-limit slot.
  if (input.length > ASSIST_MAX) return null
  if (!available) return null

  try {
    const json = await apiFetch('/api/prompt-assist', {
      method: 'POST',
      body: { text: input, kind },
      signal,
    })
    return { suggestion: json?.suggestion ?? null, notice: noticeFrom(json?.notice) }
  } catch (e) {
    // The server's own refusal of the text: say so, in the server's words.
    if (e instanceof ApiError && e.code === 'CONTENT_BLOCKED') {
      return { suggestion: null, notice: { tone: 'blocked', message: e.message } }
    }
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

/** A notice from the server ({ code, message }) as the card draws it. Anything else is no notice. */
function noticeFrom(raw) {
  if (!raw || typeof raw.message !== 'string' || !raw.message) return null
  return { tone: raw.code === 'REVIEW' ? 'warning' : 'info', message: raw.message }
}
