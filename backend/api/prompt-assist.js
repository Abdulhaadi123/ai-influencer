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
 * Body: { text, kind } → { suggestion: string|null, notice?: { code, message } }
 *
 * `notice` is something to tell the person about THEIR text, shown beside the suggestion (or alone,
 * when there is none): code REVIEW — the checker lets it through but it is close to the line — and
 * DECLINED — the rewriter would not touch it. A text the checker refuses is not a notice but a 400
 * CONTENT_BLOCKED, and the app says so too: a person who typed something unacceptable and saw nothing
 * at all concluded the feature was broken.
 */

import { requireUser, applyCors } from './_lib/auth.js'
import { sendServerError } from './_lib/errors.js'
import { screenText, ModerationRefusal, MESSAGES } from './_lib/moderation/service.js'
import { rateLimit } from '../lib/rateLimit.js'

const OPENAI_KEY = process.env.OPENAI_API_KEY || ''
const MODEL = process.env.PROMPT_ASSIST_MODEL || 'gpt-4o-mini'
// Only so tests can stand in for OpenAI; production leaves it unset.
const OPENAI_BASE = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')

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

/**
 * Whether what the model sent back is its refusal to help, not a rewrite. "I'm sorry, but I can't
 * assist with that." is a perfectly fluent answer, and offering it as the person's new description —
 * with a "Use suggestion" button — would put those words into their prompt.
 */
const REFUSAL = /^\s*(?:i['’]?m sorry|i am sorry|sorry[,.! ]|i can['’]?t\b|i cannot\b|i won['’]?t\b|i['’]?m unable|i am unable|unfortunately[, ]+i\b|as an ai\b)/i
export const looksLikeRefusal = out => out.length < 400 && REFUSAL.test(out)

export default async function handler(req, res) {
  if (applyCors(req, res)) return

  // Signed in first, so an anonymous caller gets the same 401 here as on every other endpoint.
  const user = await requireUser(req, res)
  if (!user) return
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' })

  if (!OPENAI_KEY) {
    // Not an error: the feature is optional and the client treats 501 as
    // "unavailable", hiding the suggestion UI entirely.
    return res.status(501).json({ error: 'Suggestions are not available right now.', code: 'NOT_CONFIGURED' })
  }

  const rl = rateLimit(`assist:${user.id}`)
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter))
    return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.', code: 'RATE_LIMITED' })
  }

  const { text } = req.body || {}
  // Only the kinds listed above: `kind: "constructor"` is not a prompt.
  const requested = req.body?.kind
  const kind = typeof requested === 'string' && Object.hasOwn(SYSTEM, requested) ? requested : 'appearance'
  const input = typeof text === 'string' ? text.trim() : ''

  if (!input) return res.status(400).json({ error: 'text is required.', code: 'TEXT_REQUIRED' })
  if (input.length > MAX_INPUT_CHARS) {
    return res.status(413).json({ error: 'This text is too long to improve.', code: 'TOO_LONG' })
  }

  let verdict
  try {
    // Refused text is not rewritten. (Not a strike either — this endpoint fires
    // while the user is still typing; see moderation/events.js.)
    verdict = await screenText({ user, text: input, source: 'prompt_assist' })
  } catch (e) {
    if (e instanceof ModerationRefusal) return res.status(e.status).json({ error: e.message, code: e.code })
    return sendServerError(res, e, { tag: '[prompt-assist] moderation:', message: 'The prompt assistant is unavailable right now.' })
  }

  try {
    const upstream = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM[kind] },
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
      return res.status(502).json({ error: 'The prompt assistant is unavailable right now.', code: 'ASSISTANT_UNAVAILABLE' })
    }

    const json = await upstream.json()
    // Text that is allowed but close to the line is still answered, with a word of warning beside it.
    const review = verdict === 'review' ? { code: 'REVIEW', message: MESSAGES.suggestionReview } : undefined
    const declined = { code: 'DECLINED', message: MESSAGES.suggestionDeclined }

    const message = json?.choices?.[0]?.message
    const out = message?.content?.trim()
    res.setHeader('Cache-Control', 'private, no-store')
    // Nothing back, or the model's own refusal: there is no suggestion. Say why, when it is not the
    // person's plain text (that case is the warning above).
    if (!out || message?.refusal || looksLikeRefusal(out)) {
      return res.status(200).json({ suggestion: null, notice: review ?? (out || message?.refusal ? declined : undefined) })
    }

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

    return res.status(200).json({ suggestion, notice: review })
  } catch (e) {
    return sendServerError(res, e, { tag: '[prompt-assist]', message: 'The prompt assistant is unavailable right now.' })
  }
}
