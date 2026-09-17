/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Assets — files in S3, owned by a user.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The bucket is private. There is no public URL for anything, and no object is
 * reachable by guessing a key. A file is handed out as a presigned GET that
 * expires in minutes, minted by the server only after it has checked the
 * `assets` row belongs to the caller.
 *
 * That check is the authorisation boundary for media. It is worth being precise
 * about why the URL itself is not: a presigned URL is a bearer token, so it
 * must be short-lived and must never be persisted. Storing one in the database
 * would recreate the exact bug this replaces, where records outlived the URLs
 * they pointed at.
 *
 * ── Two ways bytes get in ────────────────────────────────────────────────────
 *
 *   • ingestRemote — the server fetches a KIE result URL and streams it into
 *     S3. Generated media never round-trips through the device, so a phone on
 *     a slow connection cannot lose a result it already paid for, and the copy
 *     happens even if the app is killed mid-generation.
 *
 *   • createUpload — the server mints a presigned PUT and the client sends the
 *     bytes straight to S3. Used for reference photos and driving videos, which
 *     only exist on the device. The bytes never pass through our API, so a 60 MB
 *     video does not have to fit inside a serverless function's limits.
 */

import { apiFetch } from '../api/client'
import { AppError } from '../errors'
import { uploadToPresignedUrl, getByteSize } from '../platform/uploader'

/** The server's cap per download-url request (backend/api/storage/download-url.js). */
const MAX_IDS_PER_REQUEST = 100

/**
 * Signed GET URLs, cached until shortly before they expire.
 *
 * Without this, a gallery of thirty tiles asks the server for thirty URLs on
 * every render. The margin means a URL is never handed to an <Image> with two
 * seconds of life left, which would show a broken tile for no good reason.
 *
 * @type {Map<string, {url: string, expiresAt: number}>}
 */
const urlCache = new Map()

/** Refresh this far before actual expiry. */
const EXPIRY_MARGIN_MS = 60_000

/**
 * How often the app re-signs the URLs it is showing, and how close to expiry a
 * URL has to be to get re-signed. The window is the interval plus the margin,
 * so no URL can expire between two passes.
 */
export const URL_REFRESH_INTERVAL_MS = 3 * 60_000
export const URL_REFRESH_WINDOW_MS = URL_REFRESH_INTERVAL_MS + EXPIRY_MARGIN_MS

/**
 * Signed URL → asset id, for every URL this session has handed out.
 *
 * Screens hold URLs, and generation receives whatever the screen holds. This
 * lets generation swap a display URL for a longer-lived one (urlForGeneration)
 * without every call site carrying the asset id alongside. Cleared on sign-out.
 *
 * @type {Map<string, string>}
 */
const assetIdByUrl = new Map()

function cached(assetId, minRemainingMs = EXPIRY_MARGIN_MS) {
  const hit = urlCache.get(assetId)
  if (hit && hit.expiresAt - minRemainingMs > Date.now()) return hit.url
  if (hit) urlCache.delete(assetId)
  return null
}

/**
 * Resolve many assets to displayable URLs in one request.
 *
 * @param {string[]} assetIds
 * @param {object} [opts]
 * @param {number} [opts.minRemainingMs] re-sign cached URLs with less life than
 *        this left — what a periodic refresh uses to stay ahead of expiry
 * @returns {Promise<Map<string, string>>} assetId → signed URL (missing ids are
 *          simply absent; a deleted asset should render a placeholder, not throw)
 */
export async function resolveUrls(assetIds, { minRemainingMs = EXPIRY_MARGIN_MS } = {}) {
  const wanted = [...new Set((assetIds || []).filter(Boolean).map(String))]
  const out = new Map()

  const missing = []
  for (const id of wanted) {
    const hit = cached(id, minRemainingMs)
    if (hit) out.set(id, hit)
    else missing.push(id)
  }

  if (missing.length === 0) return out

  // In batches the server accepts. One request for everything worked until an
  // account passed 100 files; the server then refused it outright, the failure
  // was swallowed below, and every image in the app went blank at once.
  const batches = []
  for (let i = 0; i < missing.length; i += MAX_IDS_PER_REQUEST) {
    batches.push(missing.slice(i, i + MAX_IDS_PER_REQUEST))
  }

  await Promise.all(batches.map(async batch => {
    try {
      const json = await apiFetch('/api/storage/download-url', {
        method: 'POST',
        body: { assetIds: batch },
      })

      const now = Date.now()
      for (const [id, entry] of Object.entries(json?.urls || {})) {
        if (!entry?.url) continue
        const expiresAt = now + (entry.expiresIn ?? 600) * 1000
        urlCache.set(id, { url: entry.url, expiresAt })
        assetIdByUrl.set(entry.url, id)
        out.set(id, entry.url)
      }
    } catch (e) {
      // A failure here is a rendering problem, not a data problem — callers show
      // placeholders. Throwing would take down a whole gallery over one tile,
      // and one failed batch must not blank the others.
      console.warn('[assets] could not resolve URLs:', e?.message ?? e)
    }
  }))

  return out
}

/**
 * A URL that will still work when the generator gets round to fetching it.
 *
 * Display URLs expire ten minutes after they are signed, and KIE fetches its
 * inputs when a task STARTS, which can be long after it was queued — so a
 * display URL could fail a job that was already charged for. A URL this session
 * signed is re-signed with the server's generation lifetime; anything else (a
 * KIE-hosted URL, a URL from elsewhere) comes back unchanged.
 *
 * @param {string} source
 * @returns {Promise<string>}
 */
export async function urlForGeneration(source) {
  const assetId = typeof source === 'string' ? assetIdByUrl.get(source) : null
  if (!assetId) return source

  try {
    const json = await apiFetch('/api/storage/download-url', {
      method: 'POST',
      body: { assetIds: [assetId], purpose: 'generation' },
    })
    return json?.urls?.[assetId]?.url || source
  } catch (e) {
    // The display URL may well still be valid. Failing the generation over a
    // refresh would be worse than trying it.
    console.warn('[assets] could not sign a generation URL:', e?.message ?? e)
    return source
  }
}

/** Convenience for a single asset. */
export async function resolveUrl(assetId) {
  if (!assetId) return null
  const map = await resolveUrls([assetId])
  return map.get(String(assetId)) ?? null
}

/**
 * Have the server copy a remote file (a KIE result) into this user's S3 space.
 *
 * Idempotent: asking again for the same result returns the asset already
 * stored (`reused: true`), and the server marks the queue row collected.
 *
 * @returns {Promise<{assetId: string, reused: boolean}>}
 */
export async function ingestRemote({ sourceUrl, kind, influencerId = null, contentType = null }) {
  if (!sourceUrl) throw new Error('ingestRemote needs a sourceUrl')

  const json = await apiFetch('/api/storage/ingest', {
    method: 'POST',
    body: { sourceUrl, kind, influencerId, contentType },
    // The server downloads the result and writes it to storage before it
    // answers; a long video needs longer than an ordinary call.
    timeoutMs: 5 * 60_000,
  })

  if (!json?.assetId) throw new AppError('The file could not be saved. Please try again.')
  return { assetId: json.assetId, reused: !!json.reused }
}

/**
 * Upload a local file (data URL or file:// URI) to this user's S3 space.
 *
 * @param {object}  input
 * @param {string}  input.uri           data: URL or file:// URI
 * @param {'image'|'video'|'audio'} input.kind
 * @param {string}  [input.contentType]
 * @param {number}  [input.byteSize]    measured from `uri` when not given
 * @param {string}  [input.influencerId]
 * @returns {Promise<{assetId: string}>}
 */
export async function uploadLocal({ uri, kind, contentType, byteSize, influencerId = null }) {
  if (!uri) throw new Error('uploadLocal needs a uri')

  const resolvedType =
    contentType ||
    (uri.startsWith('data:') ? uri.slice(5, uri.indexOf(';')) : null) ||
    (kind === 'video' ? 'video/mp4' : 'image/jpeg')

  // The server decides the key and records the row BEFORE any bytes move, so
  // an upload that dies halfway leaves a row we can reconcile rather than an
  // orphaned object nobody knows about.
  // The exact size is required: the server signs it into the upload URL, so
  // storage accepts that many bytes and no other number, and the quota counts
  // what is really stored rather than what a client claimed.
  const size = byteSize ?? await getByteSize(uri)

  const { assetId, uploadUrl } = await apiFetch('/api/storage/upload-url', {
    method: 'POST',
    body: { contentType: resolvedType, kind, influencerId, byteSize: size },
  })

  if (!uploadUrl) throw new AppError('The upload could not be started. Please try again.')

  await uploadToPresignedUrl({ uploadUrl, uri, contentType: resolvedType })

  // Tell the server the bytes landed, so it can stamp the real size and mark
  // the asset usable. An asset that is never confirmed can be swept later.
  await apiFetch('/api/storage/confirm', { method: 'POST', body: { assetId } })

  return { assetId }
}

/** Permanently delete an asset and its S3 object. */
export async function remove(assetId) {
  if (!assetId) return
  urlCache.delete(String(assetId))
  await apiFetch('/api/storage/delete', { method: 'POST', body: { assetId } })
}

/** Drop every cached URL — called on sign-out so nothing survives into the next session. */
export function clearUrlCache() {
  urlCache.clear()
  assetIdByUrl.clear()
}
