/**
 * POST /api/prompt-assist
 *
 * Rewrites what the user typed into a stronger prompt.
 *
 * ── Why this endpoint exists ─────────────────────────────────────────────────
 *
 * The suggestion feature used to call api.openai.com directly from the app,
 * with EXPO_PUBLIC_OPENAI_API_KEY compiled into the bundle. Same problem the
 * KIE key had: an .apk is a zip file, so the key was extractable by anyone who
 * installed the app, and revoking it meant shipping a new build to everyone.
 *
 * Now the key lives here and the request is authenticated. The feature stays
 * optional — with no key configured the endpoint reports that plainly and the
 * suggestion UI never appears.
 *
 * Body: { text, kind } → { suggestion: string|null }
 */

import { requireUser, applyCors } from './_lib/auth.js'
import { sendServerError } from './_lib/errors.js'
import { rateLimit } from '../lib/rateLimit.js'

const OPENAI_KEY = process.env.OPENAI_API_KEY || ''
const MODEL = process.env.PROMPT_ASSIST_MODEL || 'gpt-4o-mini'

/** Long enough for any real prompt; short enough that this cannot be used as a
 *  general-purpose LLM endpoint on our bill. */
const MAX_INPUT_CHARS = 2000

const SYSTEM = {
  appearance:
    'You rewrite short descriptions of a person into vivid, concrete prompts for an ' +
    'image model. Keep every detail the user gave — never contradict them. Add only ' +
    'specifics that make the image better: lighting, framing, texture, styling. ' +
    'One paragraph, under 60 words, plain descriptive prose. No preamble, no quotes, ' +
    'no bullet points, no commentary. Output only the rewritten description.',

  script:
    'You rewrite what a social-media influencer says to camera so it sounds natural ' +
    "and holds attention. Keep the speaker's meaning, product and intent exactly. " +
    'Make it sound spoken, not written — contractions, natural rhythm, a strong first ' +
    'line. Keep it roughly the same length as the original. No stage directions, no ' +
    'emoji, no quotes, no commentary. Output only the rewritten script.',

  // The scene is what is SEEN — where the video happens and what she does —
  // as opposed to `script`, which is what is said. Two rules matter and are
  // stated twice because breaking either damages the generation:
  // the prompt builder parses timing phrases like "at 3s" into action beats
  // (mobile/core/prompts/videoPrompt.js), so they must survive the rewrite
  // verbatim; and anything the model invents as speech ends up competing with
  // the real script.
  scene:
    'You rewrite a short note describing what happens in a video into clear, ' +
    'filmable direction. Keep every element the user gave — the location, the ' +
    'actions, the order they happen in. PRESERVE ANY TIMING PHRASE EXACTLY AS ' +
    'WRITTEN, for example "at 3s" or "at the end"; never reword, move or drop ' +
    'one. Add only detail a camera could see: the setting, the light, what the ' +
    'person physically does. Never invent dialogue or anything spoken. Two or ' +
    'three sentences, under 50 words, plain prose. No quotes, no commentary. ' +
    'Output only the rewritten scene.',
}

/**
 * The timing phrases a scene's action beats are built from.
 *
 * Deliberately the same shape as the parser in
 * mobile/core/prompts/videoPrompt.js — if the two drift, this guard stops
 * protecting the thing it exists for.
 */
const TIMING = /\bat\s+(\d+)\s*s(?:ec(?:ond)?s?)?\b/gi

/** Every beat time a piece of text names, in seconds. */
const secondsIn = text => new Set([...String(text).matchAll(TIMING)].map(m => Number(m[1])))

/**
 * Whether a scene rewrite kept every beat time the user wrote.
 *
 * "Holds it up at 3s" becomes a beat at 0:03. A rewrite that drops the phrase,
 * or turns it into "three seconds in", silently removes that beat from the
 * generated video — and the user would never know, because the suggestion
 * reads perfectly well. A model follows an instruction most of the time, not
 * every time, so this is checked rather than trusted.
 *
 * Compared as SECONDS, not as text, because that is what the beat parser
 * reads: "at 3s" and "at 3 seconds" are the same beat and both are fine. Only
 * losing the time, or changing it, is refused.
 *
 * @returns {boolean} false when a suggestion must not be offered
 */
export function keepsTimings(input, output) {
  const wanted = secondsIn(input)
  if (!wanted.size) return true
  const got = secondsIn(output)
  return [...wanted].every(s => got.has(s))
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const user = await requireUser(req, res)
  if (!user) return

  if (!OPENAI_KEY) {
    // Not an error: the feature is optional and the client treats 501 as
    // "unavailable", hiding the suggestion UI entirely.
    return res.status(501).json({ error: 'Suggestions are not available right now.', code: 'NOT_CONFIGURED' })
  }

  const rl = rateLimit(`assist:${user.id}`)
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter))
    return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' })
  }

  const { text, kind = 'appearance' } = req.body || {}
  const input = String(text || '').trim()

  if (!input) return res.status(400).json({ error: 'text is required.' })
  if (input.length > MAX_INPUT_CHARS) {
    return res.status(413).json({ error: 'This text is too long to improve.' })
  }

  try {
    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM[kind] || SYSTEM.appearance },
          { role: 'user', content: input },
        ],
        // Enough for a paragraph, capped so a runaway response cannot cost much.
        max_tokens: 220,
        temperature: 0.7,
      }),
    })

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '')
      console.error('[prompt-assist] upstream', upstream.status, detail.slice(0, 200))
      return res.status(502).json({ error: 'The prompt assistant is unavailable right now.' })
    }

    const json = await upstream.json()
    const out = json?.choices?.[0]?.message?.content?.trim()
    if (!out) return res.status(200).json({ suggestion: null })

    // Models sometimes wrap the answer in quotes despite being told not to.
    const cleaned = out.replace(/^["'`]+|["'`]+$/g, '').trim()

    // Unchanged means there is nothing worth showing.
    let suggestion = cleaned.toLowerCase() === input.toLowerCase() ? null : cleaned

    // A scene rewrite that lost a timing would quietly cost the user an action
    // beat. Offer nothing rather than something that damages the generation.
    if (suggestion && kind === 'scene' && !keepsTimings(input, suggestion)) {
      console.warn('[prompt-assist] a scene rewrite dropped a timing phrase; not offering it')
      suggestion = null
    }

    res.setHeader('Cache-Control', 'private, no-store')
    return res.status(200).json({ suggestion })
  } catch (e) {
    return sendServerError(res, e, { tag: '[prompt-assist]', message: 'The prompt assistant is unavailable right now.' })
  }
}
