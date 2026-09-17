/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Generations — the gallery.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A row per result: the asset carries the file, this carries what it was and
 * when. A result can be filed by the screen that generated it, by the Queue
 * tab, or by the server's worker, so adding one that is already filed returns
 * the existing entry rather than a duplicate tile.
 */

import { apiFetch } from '../api/client'
import { resolveUrl } from './assets'
import { toGalleryEntry } from './influencers'

async function withUrl(row) {
  return row ? toGalleryEntry(row, await resolveUrl(row.asset_id)) : null
}

/**
 * The gallery entry for a file, if one exists.
 * @returns {Promise<{id, type, label, url, assetId, date}|null>}
 */
export async function findByAsset(assetId) {
  if (!assetId) return null
  const { generation } = await apiFetch(`/api/generations/by-asset?assetId=${encodeURIComponent(assetId)}`)
  return withUrl(generation)
}

/**
 * Record a finished result against an influencer.
 * @returns {Promise<{id, type, label, url, assetId, date}>} in the shape the
 *          gallery renders, so a caller can show it without a reload
 */
export async function add({ influencerId, assetId, kind = 'image', label = 'Generation' }) {
  if (!assetId) throw new Error('A generation needs a file.')
  const { generation } = await apiFetch('/api/generations/add', {
    method: 'POST',
    body: { influencerId: influencerId || null, assetId, kind, label },
  })
  return withUrl(generation)
}

/** Remove a gallery entry AND the file behind it — the server does both. */
export async function remove(generationId) {
  await apiFetch('/api/generations/delete', { method: 'POST', body: { generationId } })
}
