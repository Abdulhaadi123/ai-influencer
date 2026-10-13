/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The classifier — OpenAI's moderation endpoint.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * POST {base}/moderations with `omni-moderation-latest`, which reads text and
 * images, is free, and reuses the key prompt-assist already holds.
 *
 * Limits worth knowing (from OpenAI's documentation):
 *   • images only get the sexual, violence and self-harm categories. Everything
 *     else, INCLUDING sexual/minors, is text-only and scores 0 for an image.
 *     This file cannot make an image check catch a child; policy.js and the
 *     README say so rather than pretend.
 *   • it does not read audio or video. Video is checked by frames (frames.js).
 *   • do not send suspected CSAM to it. Nothing here does anything but classify
 *     what a user submitted, and a refusal does not forward the content anywhere.
 *
 * ── One image per request ────────────────────────────────────────────────────
 *
 * The endpoint refuses a request that carries more than one image (HTTP 400,
 * `too_many_images`: "Number of images (4) exceeds maximum of 1"). A video is
 * judged by several frames, so `classify` sends each image in a request of its own
 * — the text, if any, rides with the first — and runs them side by side.
 *
 * Whether the API answers an array of items with one result or one per item is
 * not something the documentation pins down, so nothing here depends on it: every
 * `results` entry of every request is merged, keeping the worst score of each
 * category. That is also the right way to judge a video's frames.
 */

import { moderationConfig } from './config.js'
import { mergeResults } from './policy.js'

/** The checker could not give an answer. Not the user's doing; the caller decides what it means. */
export class ModerationUnavailableError extends Error {
  constructor(message, { cause = null, retryable = false } = {}) {
    super(message)
    this.name = 'ModerationUnavailableError'
    this.retryable = retryable
    if (cause) this.cause = cause
  }
}

/** More than this is far beyond any prompt, and bounded so a body cannot be arbitrarily large. */
export const MAX_TEXT_CHARS = 30_000

/** Attempts per classification: one retry covers a blip, more would stall a request the user is waiting on. */
const ATTEMPTS = 2
const RETRY_DELAY_MS = 400

const sleep = ms => new Promise(r => setTimeout(r, ms))

export const textItem = text => ({ type: 'text', text: String(text).slice(0, MAX_TEXT_CHARS) })
export const imageItem = (buffer, contentType) => ({
  type: 'image_url',
  image_url: { url: `data:${contentType};base64,${buffer.toString('base64')}` },
})

/** The most images the endpoint takes in one request. */
export const MAX_IMAGES_PER_REQUEST = 1

/**
 * Cut a list of items into requests the endpoint accepts: at most one image each,
 * with all the text in the first.
 *
 * @returns {Array<Array<object>>}
 */
export function splitForRequests(items) {
  const images = items.filter(item => item.type === 'image_url')
  if (images.length <= MAX_IMAGES_PER_REQUEST) return [items]
  const texts = items.filter(item => item.type !== 'image_url')
  return images.map((image, i) => (i === 0 ? [...texts, image] : [image]))
}

/**
 * Classify text and/or images.
 *
 * @param {Array<ReturnType<typeof textItem>|ReturnType<typeof imageItem>>} items
 * @param {{config?: ReturnType<typeof moderationConfig>, fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<ReturnType<typeof mergeResults>>}
 * @throws {ModerationUnavailableError}  any one of the requests could not be answered
 */
export async function classify(items, { config = moderationConfig(), fetchImpl = fetch } = {}) {
  if (!config.apiKey) throw new ModerationUnavailableError('OPENAI_API_KEY is not set.')
  if (!items?.length) return mergeResults([])

  const answers = await Promise.all(splitForRequests(items).map(group => classifyGroup(group, config, fetchImpl)))
  return mergeResults(answers.flat())
}

/** One request, retried once on a blip. Returns the API's raw `results`. */
async function classifyGroup(items, config, fetchImpl) {
  let lastError = null
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      return await requestOnce(items, config, fetchImpl)
    } catch (e) {
      lastError = e
      if (!(e instanceof ModerationUnavailableError) || !e.retryable || attempt === ATTEMPTS) break
      await sleep(RETRY_DELAY_MS)
    }
  }
  throw lastError
}

/**
 * How long one request may take: the configured time plus a few seconds for every
 * megabyte sent. An image goes out base64-encoded, and on a slow link a couple of
 * megabytes took longer than the flat limit — measured against the real endpoint,
 * a 2 MB PNG answered 200 after 12–19 s — so it timed out every time and its
 * result stayed `unchecked`. Text and video frames are small and keep the limit
 * they had; the cap stops a huge file from holding a request for minutes.
 */
export function timeoutFor(bodyBytes, config) {
  const extra = Math.min(MAX_EXTRA_MS, Math.round((bodyBytes / 1_000_000) * EXTRA_MS_PER_MB))
  return config.timeoutMs + extra
}
const EXTRA_MS_PER_MB = 3_000
const MAX_EXTRA_MS = 30_000

async function requestOnce(items, config, fetchImpl) {
  let res
  try {
    const body = JSON.stringify({ model: config.model, input: items })
    res = await fetchImpl(`${config.baseUrl}/moderations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(timeoutFor(Buffer.byteLength(body), config)),
    })
  } catch (e) {
    // Timeout, DNS, connection reset: all worth one more try.
    throw new ModerationUnavailableError(`The moderation service could not be reached (${e?.name || 'error'}).`, { cause: e, retryable: true })
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    // 429 and 5xx pass; 401/400/403 are our configuration, and retrying cannot fix them.
    const retryable = res.status === 429 || res.status >= 500
    throw new ModerationUnavailableError(
      `The moderation service answered HTTP ${res.status}: ${detail.slice(0, 200)}`,
      { retryable },
    )
  }

  let json
  try { json = await res.json() } catch (e) {
    throw new ModerationUnavailableError('The moderation service sent an unreadable answer.', { cause: e })
  }
  if (!Array.isArray(json?.results) || json.results.length === 0) {
    throw new ModerationUnavailableError('The moderation service answer had no results.')
  }
  return json.results
}
