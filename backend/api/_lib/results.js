/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Storing a finished generation — one copy of the logic for the API and worker.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Three things collect a KIE result: the screen that started the job (through
 * /api/storage/ingest), the Queue tab's Save button (same endpoint), and
 * server/worker.js. Collection is IDEMPOTENT on (user, source URL):
 *
 *   • an asset already stored from this URL is reused, not fetched again;
 *   • a collector that loses a concurrent race to insert (the unique index
 *     assets_user_source_url_key) deletes its own copy of the bytes and adopts
 *     the winner's;
 *   • the queue row that produced the URL is marked collected here, so no
 *     client has to carry a taskId around to do it.
 *
 * ── The SSRF rule ────────────────────────────────────────────────────────────
 *
 * The URL comes from a client or from KIE, so it is not trusted: https only,
 * and only KIE's own CDNs. Fetching an arbitrary URL from inside the server is
 * a request-forgery primitive — `http://169.254.169.254/` reads cloud instance
 * metadata. If a model starts serving results from a new CDN, add that host
 * here deliberately.
 *
 * The check applies to EVERY hop. fetch follows redirects on its own, so
 * checking only the first URL let an allowed host bounce the server anywhere.
 */

import { newKey, putObject, deleteObject, kindFor, ALLOWED_CONTENT_TYPES, MAX_UPLOAD_BYTES } from './s3.js'
import { wouldExceedQuota, QUOTA_EXCEEDED_RESPONSE } from './quota.js'
import { one, query } from './db.js'

/** Hosts KIE serves results from. Matched by exact host or subdomain. */
export const ALLOWED_RESULT_HOSTS = [
  'aiquickdraw.com',   // generation results — tempfile.aiquickdraw.com
  'redpandaai.co',     // uploaded media — tempfile./kieai.redpandaai.co
  'kie.ai',            // KIE-hosted files
]

/** Redirects followed before giving up. A CDN needs one or two. */
const MAX_REDIRECTS = 3

/** Covers a slow download of the largest allowed file, not an endless hang. */
const FETCH_TIMEOUT_MS = 10 * 60 * 1000

export function isAllowedResultSource(raw) {
  let u
  try { u = new URL(raw) } catch { return false }
  if (u.protocol !== 'https:') return false
  return ALLOWED_RESULT_HOSTS.some(h => u.hostname === h || u.hostname.endsWith(`.${h}`))
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

const UNIQUE_VIOLATION = '23505'

function findStored(userId, sourceUrl) {
  return one('select id, kind from assets where user_id = $1 and source_url = $2 limit 1', [userId, sourceUrl])
}

/**
 * Clear the generator link on the jobs that produced an asset about to be
 * deleted. A job holding a link and no asset looks uncollected, and the worker
 * would store the deleted file again. Throws, so the delete does not go ahead
 * while that is still possible.
 *
 * Pass the delete's transaction client, so no one sees the job changed while
 * its asset still exists. Rows whose link is already clear are left alone: an
 * update that changes nothing still moves `updated_at`, the app's change feed
 * then reports the job — asset still attached — as freshly collected, and the
 * gallery entry being deleted is put straight back on screen.
 */
export async function forgetSource(userId, assetId, client = null) {
  const sql = `update generation_jobs set result_url = null
                where user_id = $1 and asset_id = $2 and result_url is not null`
  await (client ? client.query(sql, [userId, assetId]) : query(sql, [userId, assetId]))
}

/** Best-effort: the bytes are already safe, so a failure here is logged, not thrown. */
async function markJobsCollected(userId, sourceUrl, assetId) {
  try {
    await query(
      `update generation_jobs
          set state = 'success', asset_id = $3, result_url = null
        where user_id = $1 and result_url = $2 and asset_id is null`,
      [userId, sourceUrl, assetId],
    )
  } catch (e) {
    console.warn('[results] could not mark the job collected:', e.message)
  }
}

/**
 * Copy a generated file into the owner's storage, once.
 *
 * `enforceQuota` is on for the API and off for the worker, which only collects
 * results the user has already paid for — see _lib/quota.js. Reusing a stored
 * copy takes no space, so it is never refused.
 *
 * @returns {Promise<{assetId: string, kind: string, reused: boolean}>}
 * @throws {ResultError | Error}
 */
export async function storeGeneratedResult({ userId, influencerId = null, sourceUrl, enforceQuota = false }) {
  if (!userId) throw new ResultError('No owner for this result.', { status: 400, code: 'NO_OWNER' })
  if (!sourceUrl || !isAllowedResultSource(sourceUrl)) {
    throw new ResultError('That source is not allowed.', { status: 400, code: 'BAD_SOURCE', permanent: true })
  }

  const existing = await findStored(userId, sourceUrl)
  if (existing) {
    await markJobsCollected(userId, sourceUrl, existing.id)
    return { assetId: existing.id, kind: existing.kind, reused: true }
  }

  const quotaRefusal = () => new ResultError(QUOTA_EXCEEDED_RESPONSE.error, {
    status: 507, code: QUOTA_EXCEEDED_RESPONSE.code,
  })
  if (enforceQuota && await wouldExceedQuota(userId, 0)) throw quotaRefusal()

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
  if (enforceQuota && declared && await wouldExceedQuota(userId, declared)) throw quotaRefusal()

  const buffer = Buffer.from(await upstream.arrayBuffer())
  // Checked again after reading: Content-Length is a claim, not a guarantee.
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new ResultError('That file is too large.', { status: 413, code: 'TOO_LARGE', permanent: true })
  }
  // Content-Length is optional; without it the real size is only known now.
  if (enforceQuota && !declared && await wouldExceedQuota(userId, buffer.byteLength)) throw quotaRefusal()

  const { assetId, key } = newKey({ userId, contentType })
  await putObject({ key, body: buffer, contentType })

  try {
    await query(
      `insert into assets (id, user_id, influencer_id, s3_key, kind, origin, content_type, byte_size, source_url)
       values ($1, $2, $3, $4, $5, 'generated', $6, $7, $8)`,
      [assetId, userId, influencerId, key, kindFor(contentType), contentType, buffer.byteLength, sourceUrl],
    )
  } catch (insertError) {
    // An object no row points at is invisible, undeletable through the app, and
    // billed forever — so the bytes just written go before anything else.
    await deleteObject(key).catch(e =>
      console.warn('[results] could not remove an unrecorded object:', e?.message ?? e))

    if (insertError.code === UNIQUE_VIOLATION) {
      const winner = await findStored(userId, sourceUrl)
      if (winner) {
        await markJobsCollected(userId, sourceUrl, winner.id)
        return { assetId: winner.id, kind: winner.kind, reused: true }
      }
    }
    throw insertError
  }

  await markJobsCollected(userId, sourceUrl, assetId)
  return { assetId, kind: kindFor(contentType), reused: false }
}
