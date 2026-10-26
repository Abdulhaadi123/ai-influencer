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
 * Whether a file has a gallery entry — asked of the server, because the app holds
 * only the pages someone has scrolled to. Throws when it cannot find out.
 */
export async function isInGallery(assetId) {
  if (!assetId) return false
  const { generation } = await apiFetch(`/api/generations/by-asset?assetId=${encodeURIComponent(assetId)}`)
  return !!generation
}

/**
 * One page of an influencer's gallery, newest first.
 *
 * The roster carries only the newest few entries, so this is how the Gallery tab
 * reaches the rest. Pass the `cursor` of the last entry held rather than an
 * offset: a result collected while the user scrolls would shift every offset and
 * silently skip or repeat an entry. `paging.js` works out which cursor.
 *
 * @param {object} opts
 * @param {string} opts.influencerId
 * @param {string|null} [opts.cursor]  where the last page ended
 * @param {'image'|'video'|null} [opts.kind]  one kind only, for the gallery's filter
 * @param {object|null} [opts.before]  the oldest entry held — for a server without cursors
 * @param {number} [opts.limit]
 * @returns {Promise<{entries: object[], hasMore: boolean, nextCursor: string|null}>}
 */
export async function listForInfluencer({ influencerId, cursor = null, kind = null, before = null, limit = 30 }) {
  if (!influencerId) return { entries: [], hasMore: false, nextCursor: null }

  const params = new URLSearchParams({ influencerId, limit: String(limit) })
  if (cursor) params.set('cursor', cursor)
  if (kind) params.set('kind', kind)
  // The older form, only exact to the millisecond. Both halves or neither: one
  // alone cannot order anything, and the server refuses a half cursor.
  if (!cursor && before?.createdAt && before?.id) {
    params.set('beforeAt', String(before.createdAt))
    params.set('beforeId', String(before.id))
  }

  const { generations = [], hasMore = false, nextCursor = null } = await apiFetch(`/api/generations/by-influencer?${params.toString()}`)
  // One batch of signed URLs for the page, the same way the roster does it.
  const urls = await resolveUrls(generations.map(g => g.asset_id))
  return {
    entries: generations.map(g => toGalleryEntry(g, urls.get(String(g.asset_id)))),
    hasMore,
    nextCursor,
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
