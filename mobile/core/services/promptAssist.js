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
 * Optional feature: if no key is configured, `isAvailable()` is false and the
 * UI never appears.
 */

import { PROMPT_ASSIST_MODEL } from '../config/generation'
import { hasOpenAiKey, openAiFetch } from '../platform/openaiTransport'

export function isAvailable() {
  return hasOpenAiKey()
}

/** Below this, there is not enough intent to improve on. */
export const MIN_LENGTH = 12

const SYSTEM = {
  appearance:
    'You rewrite short descriptions of a person into vivid, concrete prompts for an ' +
    'image model. Keep every detail the user gave — never contradict them. Add only ' +
    'specifics that make the image better: lighting, framing, texture, styling. ' +
    'One paragraph, under 60 words, plain descriptive prose. No preamble, no quotes, ' +
    'no bullet points, no commentary. Output only the rewritten description.',

  script:
    'You rewrite what a social-media influencer says to camera so it sounds natural ' +
    'and holds attention. Keep the speaker\'s meaning, product and intent exactly. ' +
    'Make it sound spoken, not written — contractions, natural rhythm, a strong first ' +
    'line. Keep it roughly the same length as the original. No stage directions, no ' +
    'emoji, no quotes, no commentary. Output only the rewritten script.',
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
  if (!hasOpenAiKey()) return null

  const res = await openAiFetch({
    model: PROMPT_ASSIST_MODEL,
    messages: [
      { role: 'system', content: SYSTEM[kind] || SYSTEM.appearance },
      { role: 'user', content: input },
    ],
    // Enough for a paragraph, capped so a runaway response cannot cost much.
    max_tokens: 220,
    temperature: 0.7,
  }, signal)

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Prompt assistant failed (${res.status}). ${detail.slice(0, 140)}`)
  }

  const json = await res.json()
  const out = json?.choices?.[0]?.message?.content?.trim()
  if (!out) return null

  // Models sometimes wrap the answer in quotes despite being told not to.
  const cleaned = out.replace(/^["'`]+|["'`]+$/g, '').trim()

  // If it came back essentially unchanged, there is nothing to offer.
  if (cleaned.toLowerCase() === input.toLowerCase()) return null

  return cleaned
}
