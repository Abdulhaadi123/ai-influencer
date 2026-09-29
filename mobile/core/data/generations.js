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
import { resolveUrl, resolveUrls } from './assets'
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
 * One page of an influencer's gallery, newest first.
 *
 * The roster carries only the newest few entries, so this is how the Gallery tab
 * reaches the rest. Pass the last entry you hold as the cursor — its exact
 * `createdAt` and `id` — rather than an offset: a result collected while the
 * user scrolls would shift every offset and silently skip or repeat an entry.
 *
 * @param {object} opts
 * @param {string} opts.influencerId
 * @param {string|null} [opts.beforeAt]  the last held entry's `createdAt`
 * @param {string|null} [opts.beforeId]  the last held entry's `id`
 * @param {number} [opts.limit]
 * @returns {Promise<{entries: object[], hasMore: boolean}>}
 */
export async function listForInfluencer({ influencerId, beforeAt = null, beforeId = null, limit = 30 }) {
  if (!influencerId) return { entries: [], hasMore: false }

  const params = new URLSearchParams({ influencerId, limit: String(limit) })
  // Both halves or neither: one alone cannot order anything, and the server
  // refuses a half cursor.
  if (beforeAt && beforeId) {
    params.set('beforeAt', String(beforeAt))
    params.set('beforeId', String(beforeId))
  }

  const { generations = [], hasMore = false } = await apiFetch(`/api/generations/by-influencer?${params.toString()}`)
  // One batch of signed URLs for the page, the same way the roster does it.
  const urls = await resolveUrls(generations.map(g => g.asset_id))
  return {
    entries: generations.map(g => toGalleryEntry(g, urls.get(String(g.asset_id)))),
    hasMore,
  }
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
