/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Storing a finished generation — one copy of the logic for the API and worker.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Three things collect a KIE result: the screen that started the job (through
 * /api/storage/ingest), the Queue tab's Save button (same endpoint), and
 * server/worker.js. They used to act independently, so the same result could be
 * copied into S3 twice and filed in the gallery twice — and the screens never
 * managed to mark the queue row, which then offered to save the result again.
 *
 * Collection is IDEMPOTENT on (user, source URL):
 *
 *   • an asset already stored from this URL is reused, not fetched again;
 *   • a collector that loses a concurrent race to insert (the unique index in
 *     migration 0002) deletes its own copy of the bytes and adopts the winner's;
 *   • the queue row that produced the URL is marked collected here, server-side,
 *     so no client has to carry a taskId around to do it.
 *
 * ── The SSRF rule ────────────────────────────────────────────────────────────
 *
 * The URL comes from a client (or from KIE via the database), so it is not
 * trusted: https only, and only KIE's own CDNs. Fetching an arbitrary URL from
 * inside the server is a request-forgery primitive — `http://169.254.169.254/`
 * reads cloud instance metadata. If a model starts serving results from a new
 * CDN, add that host here deliberately.
 *
 * The check applies to EVERY hop. fetch follows redirects on its own, so
 * checking only the first URL let an allowed host bounce the server anywhere.
 */

import { newKey, putObject, deleteObject, kindFor, ALLOWED_CONTENT_TYPES, MAX_UPLOAD_BYTES } from './s3.js'
import { wouldExceedQuota, QUOTA_EXCEEDED_RESPONSE } from './quota.js'

/** Redirects followed before giving up. A CDN needs one or two. */
const MAX_REDIRECTS = 3

/** Covers a slow download of the largest allowed file, not an endless hang. */
const FETCH_TIMEOUT_MS = 10 * 60 * 1000

/** Hosts KIE serves results from. Matched by exact host or subdomain. */
export const ALLOWED_RESULT_HOSTS = [
  'aiquickdraw.com',   // generation results — tempfile.aiquickdraw.com
  'redpandaai.co',     // uploaded media — tempfile./kieai.redpandaai.co
  'kie.ai',            // KIE-hosted files
]

export function isAllowedResultSource(raw) {
  let u
  try { u = new URL(raw) } catch { return false }
  if (u.protocol !== 'https:') return false
  return ALLOWED_RESULT_HOSTS.some(h => u.hostname === h || u.hostname.endsWith(`.${h}`))
}

/**
 * Fetch a result, following redirects by hand so each hop is checked against
 * the allowlist before it is requested.
 *
 * @param {string} url  already checked by the caller
 * @param {typeof fetch} [fetchImpl]  injectable for tests
 */
export async function fetchAllowedSource(url, fetchImpl = fetch) {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  let current = url

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchImpl(current, { redirect: 'manual', signal })
    if (res.status < 300 || res.status >= 400) return res

    const location = res.headers.get('location')
    // Release the redirect's connection before moving on.
    await res.body?.cancel?.().catch(() => {})
    const next = location ? new URL(location, current).toString() : null
    if (!next || !isAllowedResultSource(next)) {
      throw new ResultError('The generator redirected to a source that is not allowed.', {
        status: 400, code: 'BAD_SOURCE', permanent: true,
      })
    }
    current = next
  }

  throw new ResultError('The generator redirected too many times.', {
    status: 502, code: 'SOURCE_UNAVAILABLE', permanent: true,
  })
}

/**
 * A collection failure the caller can act on: `status` for an HTTP response,
 * `permanent` for the worker, which must stop retrying a result that will never
 * arrive (expired, wrong type, too large) instead of trying it every cycle.
 */
export class ResultError extends Error {
  constructor(message, { status = 500, code = 'FAILED', permanent = false } = {}) {
    super(message)
    this.name = 'ResultError'
    this.status = status
    this.code = code
    this.permanent = permanent
  }
}

const UNIQUE_VIOLATION = '23505'

async function findStored(db, userId, sourceUrl) {
  const { data, error } = await db
    .from('assets')
    .select('id, kind')
    .eq('user_id', userId)
    .eq('source_url', sourceUrl)
    .limit(1)
  if (error) throw error
  return data?.[0] ?? null
}

/**
 * Clear the generator link on the jobs that produced an asset about to be
 * deleted. A job holding a link and no asset looks uncollected, and the worker
 * would store the deleted file again. Throws, so the delete does not go ahead
 * while that is still possible.
 */
export async function forgetSource(db, userId, assetId) {
  const { error } = await db
    .from('generation_jobs')
    .update({ result_url: null })
    .eq('user_id', userId)
    .eq('asset_id', assetId)
  if (error) throw error
}

/** Best-effort: the bytes are already safe, so a failure here is logged, not thrown. */
async function markJobsCollected(db, userId, sourceUrl, assetId) {
  const { error } = await db
    .from('generation_jobs')
    .update({ state: 'success', asset_id: assetId, result_url: null })
    .eq('user_id', userId)
    .eq('result_url', sourceUrl)
    .is('asset_id', null)
  if (error) console.warn('[results] could not mark the job collected:', error.message)
}

/**
 * Copy a generated file into the owner's storage, once.
 *
 * Every query carries `userId` explicitly: both callers use the service-role
 * client, where Row Level Security does not apply.
 *
 * `enforceQuota` is on for the API and off for the worker, which only collects
 * results the user has already paid for — see _lib/quota.js. Reusing a stored
 * copy takes no space, so it is never refused.
 *
 * @returns {Promise<{assetId: string, kind: string, reused: boolean}>}
 * @throws {ResultError | Error}
 */
export async function storeGeneratedResult(db, { userId, influencerId = null, sourceUrl, enforceQuota = false }) {
  if (!userId) throw new ResultError('No owner for this result.', { status: 400, code: 'NO_OWNER' })
  if (!sourceUrl || !isAllowedResultSource(sourceUrl)) {
    throw new ResultError('That source is not allowed.', { status: 400, code: 'BAD_SOURCE', permanent: true })
  }

  const existing = await findStored(db, userId, sourceUrl)
  if (existing) {
    await markJobsCollected(db, userId, sourceUrl, existing.id)
    return { assetId: existing.id, kind: existing.kind, reused: true }
  }

  const quotaRefusal = () => new ResultError(QUOTA_EXCEEDED_RESPONSE.error, {
    status: 507, code: QUOTA_EXCEEDED_RESPONSE.code,
  })
  if (enforceQuota && await wouldExceedQuota(db, userId, 0)) throw quotaRefusal()

  const upstream = await fetchAllowedSource(sourceUrl)
  if (!upstream.ok) {
    // By far the likeliest cause is the 24-hour expiry, and that is permanent.
    throw new ResultError(
      upstream.status === 404
        ? 'That result has expired and is no longer available from the generator.'
        : `The generator returned HTTP ${upstream.status}.`,
      { status: 502, code: 'SOURCE_UNAVAILABLE', permanent: upstream.status === 404 },
    )
  }

  const contentType = (upstream.headers.get('content-type') || '').split(';')[0].trim()
  if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
    throw new ResultError(`Unsupported file type (${contentType || 'unknown'}).`, {
      status: 415, code: 'UNSUPPORTED_TYPE', permanent: true,
    })
  }

  const declared = Number(upstream.headers.get('content-length') || 0)
  if (declared && declared > MAX_UPLOAD_BYTES) {
    throw new ResultError('That file is too large.', { status: 413, code: 'TOO_LARGE', permanent: true })
  }
  if (enforceQuota && declared && await wouldExceedQuota(db, userId, declared)) throw quotaRefusal()

  const buffer = Buffer.from(await upstream.arrayBuffer())
  // Checked again after reading: Content-Length is a claim, not a guarantee.
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new ResultError('That file is too large.', { status: 413, code: 'TOO_LARGE', permanent: true })
  }
  // Content-Length is optional; without it the real size is only known now.
  if (enforceQuota && !declared && await wouldExceedQuota(db, userId, buffer.byteLength)) throw quotaRefusal()

  const { assetId, key } = newKey({ userId, contentType })
  await putObject({ key, body: buffer, contentType })

  const { error: insertError } = await db.from('assets').insert({
    id: assetId,
    user_id: userId,
    influencer_id: influencerId,
    s3_key: key,
    kind: kindFor(contentType),
    origin: 'generated',
    content_type: contentType,
    byte_size: buffer.byteLength,
    source_url: sourceUrl,
  })

  if (insertError) {
    // An object no row points at is invisible, undeletable through the app, and
    // billed forever — so the bytes just written go before anything else.
    await deleteObject(key).catch(e =>
      console.warn('[results] could not remove an unrecorded object:', e?.message ?? e))

    if (insertError.code === UNIQUE_VIOLATION) {
      const winner = await findStored(db, userId, sourceUrl)
      if (winner) {
        await markJobsCollected(db, userId, sourceUrl, winner.id)
        return { assetId: winner.id, kind: winner.kind, reused: true }
      }
    }
    throw insertError
  }

  await markJobsCollected(db, userId, sourceUrl, assetId)
  return { assetId, kind: kindFor(contentType), reused: false }
}
