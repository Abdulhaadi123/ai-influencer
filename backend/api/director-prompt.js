/**
 * POST /api/director-prompt
 *
 * Director Mode's writer: an idea in, a finished Seedance prompt out — which reference picture is what, a
 * summary, then the clip shot by shot with timings, camera, speech and sound. The model that writes it may search the
 * web first (what works in this kind of ad, how Seedance prompts are best written), the way a person asking a
 * chat assistant for a UGC ad prompt would have it do.
 *
 * It is not the prompt assistant (api/prompt-assist.js): that rewrites what a person typed into a stronger
 * version of the same text, in one cheap call. This writes a whole plan, and costs more — a few cents
 * (the tokens, plus OpenAI's fee for each web search) — so it is limited per person, per minute and per day.
 * What is done in code and what is left to the model is explained in api/_lib/director.js.
 *
 * Body: {
 *   idea: string,                         what the video should show (required)
 *   seconds?: number,                     the clip's length; moved to one Seedance takes (default 15)
 *   aspect?: '9:16'|'16:9'|'1:1',
 *   language?: string,                    the language spoken in the video (default English)
 *   character?: { name?, gender?: 'Female'|'Male', description? },
 *   references?: [{ role: 'product'|'character'|'character_extra'|'location' }]   in the order the pictures are uploaded
 * }
 * → { prompt: string|null, searched: boolean, sources: number, seconds: number, shots: number,
 *     notice?: { code: 'REVIEW'|'DECLINED', message } }
 *
 * `prompt` is null when the director would not write this one (`notice` says so): not an error, the same way the
 * prompt assistant answers. `searched` is true only when the answer itself shows the web was searched.
 *
 * Text is checked before the model sees it and again once the prompt is written — a model can turn a harmless
 * idea into something that is not. Neither check is a strike: this fires while a person is still composing
 * (events.js), and the prompt that is finally sent to be generated is checked again by the generation proxy.
 *
 * Environment (all optional but the key, which is the one the prompt assistant and the moderation use):
 *   OPENAI_API_KEY          without it: 501 NOT_CONFIGURED, and the app hides Director Mode's writer
 *   DIRECTOR_MODEL          default gpt-4o-mini. Tried first; if the account has no such model, or it gives no plan, gpt-4o-mini is tried
 *                           after it (a line in the log says so), so a mistyped or unavailable name cannot take the director down
 *   DIRECTOR_SEARCH         false turns web search off altogether (default on)
 *   DIRECTOR_PER_MINUTE     default 4
 *   DIRECTOR_PER_DAY        default 30
 *   DIRECTOR_OPENAI_BASE_URL   only so tests can stand in for OpenAI; production leaves it unset
 */

import { userRoute, HttpError, noStore } from './_lib/http.js'
import { screenText, ModerationRefusal, MESSAGES } from './_lib/moderation/service.js'
import { createRateLimiter } from '../lib/rateLimit.js'
import {
  cleanInput, DirectorInputError, DirectorOutputError,
  systemPrompt, userMessage, extractOutput, readPlan, composePrompt, limitMessage,
} from './_lib/director.js'

const apiKey = () => process.env.OPENAI_API_KEY || ''
/** The model the real runs of 2026-11-19 used: the one that is known to answer. What DIRECTOR_MODEL names is tried before it. */
const FALLBACK_MODEL = 'gpt-4o-mini'
const model = () => (process.env.DIRECTOR_MODEL || '').trim() || FALLBACK_MODEL
/** The models to try, in order: the one asked for, then the known one (only once when they are the same). */
const models = () => [...new Set([model(), FALLBACK_MODEL])]
const baseUrl = () => (process.env.DIRECTOR_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')
const searchOn = () => String(process.env.DIRECTOR_SEARCH ?? 'true').toLowerCase() !== 'false'

const DAY_MS = 24 * 60 * 60_000
const limiter = createRateLimiter([
  { windowMs: 60_000, max: Number(process.env.DIRECTOR_PER_MINUTE) || 4 },
  { windowMs: DAY_MS, max: Number(process.env.DIRECTOR_PER_DAY) || 30 },
])

/** A search and a written plan take a while. Per try, and for all of them together. */
const TRY_MS = 60_000
const ALL_MS = 110_000

const DECLINED = Object.freeze({
  code: 'DECLINED',
  message: 'The director could not write a prompt for this idea. Try describing it a little differently.',
})

/**
 * Said when the plan the model wrote shows a child. Every person in a Director video is an adult; the model is told so, and
 * the plan is checked for the words that give a child away (api/_lib/director.js childInPlan) rather than left to the model.
 */
const ADULTS = Object.freeze({
  code: 'DECLINED',
  message: 'The director only writes videos with adults in them. Describe an adult, or an idea with no person, and try again.',
})

/** Said when the prompt that was written is what failed the content check, not the idea (the server log says which categories). */
const HELD = Object.freeze({
  code: 'DECLINED',
  message: 'The prompt written for this idea did not pass the content check. Try describing it a little differently.',
})

/**
 * The ways to ask, best first. The web search tool has had two names (`web_search`, and `web_search_preview` before
 * it) and not every model takes either, and an account without the tool must still get a prompt, so a request
 * the upstream refuses is asked again in the next way, ending with no search at all.
 */
function ways() {
  const plain = { tools: null, calls: null }
  if (!searchOn()) return [plain]
  return [
    { tools: [{ type: 'web_search' }], calls: 3 },
    { tools: [{ type: 'web_search_preview' }], calls: null },
    plain,
  ]
}

/** One request to OpenAI's Responses API. Resolves with the Response; throws on a network failure or a timeout. */
function ask({ system, text, way, ms, modelName }) {
  const body = {
    model: modelName,
    instructions: system,
    input: text,
    max_output_tokens: 3000,
    // What a person typed is not kept at OpenAI to be looked at later.
    store: false,
  }
  if (way.tools) {
    body.tools = way.tools
    body.tool_choice = 'auto'
    // Search is the expensive part: this caps what one prompt can cost.
    if (way.calls) body.max_tool_calls = way.calls
  }
  return fetch(`${baseUrl()}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
  })
}

/**
 * Get a usable plan out of the model, trying the ways in turn, and the known model after the one asked for.
 * @returns {Promise<{refusal: string}|{plan: object, searched: boolean, sources: number}>}
 */
async function writePlan(input) {
  const system = systemPrompt(input)
  const text = userMessage(input)
  const deadline = Date.now() + ALL_MS

  let unusable = false          // the last answer arrived but was not a plan
  const tried = models()
  for (const [index, modelName] of tried.entries()) {
    let skipSearch = false      // an answer that cost a search and was not a plan: do not pay for another
    let halt = false            // our key is refused, or we are being limited: another model would meet the same answer
    unusable = false

    for (const way of ways()) {
      if (skipSearch && way.tools) continue
      const left = deadline - Date.now()
      if (left < 5_000) break

      let upstream
      try {
        upstream = await ask({ system, text, way, ms: Math.min(TRY_MS, left), modelName })
      } catch (e) {
        console.error('[director] upstream did not answer:', e?.name || e?.message || e)
        unusable = false
        continue
      }

      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => '')
        console.error('[director] upstream', upstream.status, `(${modelName})`, detail.slice(0, 200))
        unusable = false
        if ([401, 429].includes(upstream.status)) { halt = true; break }
        // No such model for this account (404) or not allowed to use it (403): its other ways would meet the same answer.
        if ([403, 404].includes(upstream.status)) break
        continue
      }

      const out = extractOutput(await upstream.json().catch(() => null))
      if (out.refusal && !out.text) return { refusal: out.refusal }
      try {
        const read = readPlan(out.text, input.seconds)
        if (read.refusal) return { refusal: read.refusal, child: read.child === true }
        return { plan: read.plan, searched: out.searched, sources: out.sources }
      } catch (e) {
        if (!(e instanceof DirectorOutputError)) throw e
        console.error('[director] the answer was not a plan:', e.message, out.incomplete ? '(cut short)' : '', `(${modelName})`)
        unusable = true
        if (way.tools) skipSearch = true
      }
    }

    if (halt) break
    if (index < tried.length - 1) console.warn(`[director] "${modelName}" gave no plan; trying "${tried[index + 1]}"`)
  }

  throw unusable
    ? new HttpError(502, 'The director could not finish this one. Please try again.', 'DIRECTOR_FAILED')
    : new HttpError(502, 'The director is unavailable right now. Please try again in a moment.', 'ASSISTANT_UNAVAILABLE')
}

/** A moderation refusal as the HttpError the route wrapper answers with. */
function refused(e) {
  return e instanceof ModerationRefusal ? new HttpError(e.status, e.message, e.code) : e
}

export default userRoute(async (req, res, user) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
  if (!apiKey()) {
    // Not an error: the feature is optional, and the app treats 501 as "unavailable".
    throw new HttpError(501, 'The director is not available right now.', 'NOT_CONFIGURED')
  }

  let input
  try {
    input = cleanInput(req.body)
  } catch (e) {
    if (e instanceof DirectorInputError) throw new HttpError(e.status, e.message, e.code)
    throw e
  }

  // The wait can be a minute or the rest of the day (the per-day cap), and the message says which.
  const allowed = limiter(`director:${user.id}`)
  if (!allowed.ok) {
    throw new HttpError(429, limitMessage(allowed.retryAfter), 'RATE_LIMITED', { 'Retry-After': String(allowed.retryAfter) })
  }

  let verdict
  try {
    verdict = await screenText({
      user,
      text: [input.idea, input.character.name, input.character.description].filter(Boolean).join('\n'),
      source: 'prompt_assist',
    })
  } catch (e) {
    throw refused(e)
  }
  const review = verdict === 'review' ? { code: 'REVIEW', message: MESSAGES.suggestionReview } : undefined

  const written = await writePlan(input)
  noStore(res)
  if (written.refusal) {
    // The model's own words go to the server log, for whoever runs it, and are not passed on: the person is told only
    // that it was declined. (Until this line existed a decline left no trace at all, so nobody could tell why.)
    console.warn(`[director] user=${user.id} seconds=${input.seconds} ${written.child ? 'the written plan was held back' : 'the model declined this idea'}: ${String(written.refusal).slice(0, 240)}`)
    return res.status(200).json({ prompt: null, searched: false, sources: 0, seconds: input.seconds, shots: 0, notice: written.child ? ADULTS : DECLINED })
  }

  const prompt = composePrompt(input, written.plan)
  try {
    await screenText({ user, text: prompt, source: 'prompt_assist' })
  } catch (e) {
    if (e instanceof ModerationRefusal && e.code === 'CONTENT_BLOCKED') {
      // What the model wrote, not what the person typed, failed the check. The categories and scores are also on the
      // admin panel's Moderation page (source prompt_assist); the text itself is not logged.
      const tripped = (e.hits || []).map(h => `${h.category} ${Number(h.score).toFixed(2)}`).join(', ')
      console.warn(`[director] user=${user.id} seconds=${input.seconds} the written prompt (${prompt.length} characters, ${written.plan.shots.length} shots) was held back by the content check${tripped ? `: ${tripped}` : ''}`)
      return res.status(200).json({ prompt: null, searched: written.searched, sources: written.sources, seconds: input.seconds, shots: 0, notice: HELD })
    }
    throw refused(e)
  }

  console.log(`[director] user=${user.id} seconds=${input.seconds} shots=${written.plan.shots.length} searched=${written.searched} sources=${written.sources}`)
  return res.status(200).json({
    prompt,
    searched: written.searched,
    sources: written.sources,
    seconds: input.seconds,
    shots: written.plan.shots.length,
    notice: review,
  })
}, { tag: '[director]', message: 'The director is unavailable right now.' })
