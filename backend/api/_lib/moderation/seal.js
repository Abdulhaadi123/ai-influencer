/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Sealing an upload — so the bytes that are checked are the bytes that are sent.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * An upload reaches S3 through a presigned PUT link (s3.js presignPut). The link
 * pins the key and the length, not the content, lives for UPLOAD_TTL_SECONDS and
 * can be used again. So after a file had been checked and marked `clear`, whoever
 * held the link could put different bytes under the same key, and the generator —
 * which fetches the file later, when its task starts — would be handed a file nobody
 * had looked at.
 *
 * Sealing removes the window rather than narrowing it. The upload is copied INSIDE
 * S3 to a key no link names, the asset is pointed at the copy, and the original is
 * deleted. Only this server can write to the sealed key, so the file cannot change
 * after it is checked. (A second use of the old link now writes to a key nothing
 * refers to; it is swept with the account's other files.)
 *
 * ── When it happens ──────────────────────────────────────────────────────────
 *
 *   • at /api/storage/confirm, before the answer — so every upload the app
 *     completes is sealed before the app can ask for a link to it, and the link it
 *     gets already names the sealed key;
 *   • before any check of an upload (moderateAsset), for one that was never
 *     confirmed.
 *
 * ── What counts as already sealed ────────────────────────────────────────────
 *
 *   • anything the server wrote itself (`origin = 'generated'`): no link exists;
 *   • an upload with `sealed_at` set;
 *   • an upload old enough that its link has expired. This is what keeps every file
 *     uploaded before sealing existed working: they are not rewritten, and need not be.
 */

import { transaction } from '../db.js'
import { copyObject, deleteObject, UPLOAD_TTL_SECONDS } from '../s3.js'

/** Past this age an upload's link is certainly dead: its lifetime plus a margin for clocks. */
const LINK_DEAD_AFTER_MS = (UPLOAD_TTL_SECONDS + 15 * 60) * 1000

/**
 * Whether nobody but the server can still write to this asset's file.
 *
 * @param {{origin: string, sealed_at?: Date|string|null, created_at?: Date|string|null}} asset
 * @param {number} [now]
 */
export function isSealed(asset, now = Date.now()) {
  if (asset.origin !== 'upload') return true
  if (asset.sealed_at) return true
  const created = asset.created_at ? new Date(asset.created_at).getTime() : NaN
  return Number.isFinite(created) && now - created > LINK_DEAD_AFTER_MS
}

/** `users/<id>/2026/10/<asset>.jpg` → `users/<id>/2026/10/<asset>-sealed.jpg`. */
export function sealedKeyFor(key) {
  const dot = key.lastIndexOf('.')
  return dot > key.lastIndexOf('/') ? `${key.slice(0, dot)}-sealed${key.slice(dot)}` : `${key}-sealed`
}

/**
 * Seal an upload, once. Safe to call for anything: a file that does not need it is
 * returned as it was, and two callers sealing the same file at once take turns (the
 * second finds it done) — important, because a second copy could land after the first
 * was checked.
 *
 * @param {{id: string, origin: string, s3_key: string, sealed_at?: Date|null, created_at?: Date|null}} asset
 * @returns {Promise<typeof asset>} the asset, with the key it now lives at
 * @throws  whatever S3 throws (a missing source is NoSuchKey); nothing is changed when it does
 */
export async function sealAsset(asset) {
  if (isSealed(asset)) return asset

  const { sealed, staleKey } = await transaction(async client => {
    // One sealer per asset at a time. Held across the copy on purpose: that is the point.
    await client.query('select pg_advisory_xact_lock(hashtextextended($1::text, 6))', [asset.id])

    const { rows } = await client.query('select s3_key, sealed_at from assets where id = $1', [asset.id])
    if (!rows.length) throw Object.assign(new Error('The file is gone.'), { name: 'NoSuchKey' })
    if (rows[0].sealed_at) return { sealed: { ...asset, s3_key: rows[0].s3_key, sealed_at: rows[0].sealed_at }, staleKey: null }

    const fromKey = rows[0].s3_key
    const toKey = sealedKeyFor(fromKey)
    await copyObject({ fromKey, toKey })

    const updated = await client.query(
      'update assets set s3_key = $2, sealed_at = now() where id = $1 returning sealed_at',
      [asset.id, toKey],
    )
    return { sealed: { ...asset, s3_key: toKey, sealed_at: updated.rows[0].sealed_at }, staleKey: fromKey }
  })

  // After the commit: if the database refused, the original must still be there.
  if (staleKey) {
    await deleteObject(staleKey).catch(e => console.warn('[seal] could not remove the original after sealing:', e?.message ?? e))
  }
  return sealed
}
