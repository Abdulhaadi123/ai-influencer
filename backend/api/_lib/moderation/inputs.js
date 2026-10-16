/**
 * ─────────────────────────────────────────────────────────────────────────────
 * What in a generation request has to be checked.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A createTask body is `{ model, input: { ...fields the model takes } }`, and
 * the fields differ per model (`prompt`, `image_urls`, `reference_image_urls`,
 * `first_frame_url`, `video_urls`, `multi_prompt`, `kling_elements`…). Listing
 * the ones that matter would be a list that is wrong the day a model is added
 * and silently lets that model's text or images through unchecked.
 *
 * So this walks EVERYTHING in the request instead, and sorts what it finds into
 * two piles — text to read, and URLs of files to check — by the shape of the
 * value, not the name of the field. A new model's fields are covered without
 * anyone remembering to add them.
 *
 * Pure: no I/O, no environment. service.js does the checking.
 */

import { isAllowedResultSource } from '../results.js'

/** Fields the server sets itself, or that carry an id rather than content. */
const SKIPPED_KEYS = new Set(['model', 'callBackUrl', 'callbackUrl', 'callback_url'])

/** A field that is prose whatever its length: a one-word prompt is still a prompt. */
const TEXT_KEY = /(prompt|text|script|dialog|caption|description|negative|instruction|lyrics|message|title|name)/i

const URL_LIKE = /^(https?:\/\/|data:)/i

/** A value with no spaces and this short is an option ("pro", "720p", "9:16"), not prose. */
const OPTION_MAX_LENGTH = 24

const MAX_DEPTH = 8
const MAX_NODES = 2000
export const MAX_URLS = 40

/**
 * @param {unknown} payload  the parsed request body
 * @returns {{text: string, urls: Array<{url: string, key: string}>}}
 *   `text` is every piece of prose, one per line; `urls` every link, with the
 *   name of the field it came in (a hint only — see classifyMediaUrl).
 */
export function collectInputs(payload) {
  const texts = new Set()
  const urls = []
  let nodes = 0

  const visit = (value, key, depth) => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return

    if (typeof value === 'string') {
      const s = value.trim()
      if (!s) return
      if (URL_LIKE.test(s)) { urls.push({ url: s, key }); return }
      if (TEXT_KEY.test(key) || /\s/.test(s) || s.length > OPTION_MAX_LENGTH) texts.add(s)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, depth + 1)
      return
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (!SKIPPED_KEYS.has(k)) visit(v, k, depth + 1)
      }
    }
  }

  visit(unwrapStringInput(payload), '', 0)
  return { text: [...texts].join('\n'), urls }
}

/**
 * An `input` sent as a JSON string rather than an object would otherwise be one
 * opaque blob whose links and fields are never looked at. Unwrap it.
 */
function unwrapStringInput(payload) {
  if (payload && typeof payload === 'object' && typeof payload.input === 'string') {
    try {
      const parsed = JSON.parse(payload.input)
      if (parsed && typeof parsed === 'object') return { ...payload, input: parsed }
    } catch { /* not JSON — it is read as text */ }
  }
  return payload
}

/** Every user-owned object key starts like this (see s3.js newKey). */
const OWN_KEY = /^users\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//i

/**
 * Where a link points.
 *
 *   own     a file in this app's private bucket → `key` identifies the asset, and
 *           its moderation status is looked up
 *   kie     a file on KIE's own hosts. Where it CAME from says nothing about what is
 *           in it: it may be something KIE generated, a file uploaded through the
 *           proxy (which checks uploads, but not every way a file could have got
 *           there), or something another account's result left lying at a guessable
 *           address. It is therefore fetched and checked when it is used
 *           (service.js screenKieLink) — never trusted for its host.
 *   other   anything else. Not checkable, so not allowed.
 *
 * @param {string} raw
 * @param {{bucket?: string, endpoint?: string}} [where]  the bucket and, for S3-compatible storage, its endpoint
 * @returns {{kind: 'own', key: string} | {kind: 'kie'} | {kind: 'other'}}
 */
export function classifyMediaUrl(raw, { bucket = '', endpoint = '' } = {}) {
  // A control character is never part of a link someone meant. Refusing it here also keeps
  // it from becoming a request to a host, with whatever that does to the one reading it.
  if (typeof raw !== 'string' || /[\u0000-\u001f\u007f]/.test(raw)) return { kind: 'other' }

  let url
  try { url = new URL(raw) } catch { return { kind: 'other' } }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { kind: 'other' }

  const key = ownObjectKey(url, bucket, endpoint)
  if (key) return { kind: 'own', key }
  if (isAllowedResultSource(raw)) return { kind: 'kie' }
  return { kind: 'other' }
}

function ownObjectKey(url, bucket, endpoint) {
  if (!bucket) return null

  let path
  try { path = decodeURIComponent(url.pathname) } catch { return null }

  let key = null
  if (url.protocol === 'https:' && url.hostname.endsWith('.amazonaws.com')) {
    // Virtual-hosted style: <bucket>.s3.<region>.amazonaws.com/<key>
    if (url.hostname.startsWith(`${bucket}.s3`)) key = path.slice(1)
    // Path style: s3.<region>.amazonaws.com/<bucket>/<key>
    else if (/^s3[.-]/.test(url.hostname) && path.startsWith(`/${bucket}/`)) key = path.slice(bucket.length + 2)
  } else if (endpoint) {
    let custom
    try { custom = new URL(endpoint) } catch { return null }
    if (url.host === custom.host && path.startsWith(`/${bucket}/`)) key = path.slice(bucket.length + 2)
  }

  return key && OWN_KEY.test(key) ? key : null
}
