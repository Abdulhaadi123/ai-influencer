/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Generations — the gallery.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This used to be `influencer.generationHistory`, an array embedded in the
 * record. Appending one clip meant rewriting the entire influencer, two devices
 * generating at once would clobber each other's history, and "everything I have
 * ever made" was not a question the data could answer.
 *
 * A row per result fixes all three. The asset carries the file; this table
 * carries what it was and when.
 */

import { supabase, requireUserId } from '../supabase'
import { dbError } from '../errors'
import { resolveUrls } from './assets'

const COLUMNS = 'id, influencer_id, asset_id, kind, label, created_at'

async function toEntry(row) {
  const urls = await resolveUrls([row.asset_id])
  return {
    id: row.id,
    type: row.kind === 'video' ? 'video' : 'image',
    label: row.label,
    url: urls.get(String(row.asset_id)) ?? null,
    assetId: row.asset_id,
    date: new Date(row.created_at).getTime(),
  }
}

/**
 * The gallery entry for an asset, if one exists.
 *
 * A result can be filed by the screen that generated it, by the Queue tab, or
 * by the server's worker, so "is this already in the gallery" is asked by
 * asset rather than assumed.
 *
 * @returns {Promise<{id, type, label, url, assetId, date}|null>}
 */
export async function findByAsset(assetId) {
  if (!assetId) return null
  const { data, error } = await supabase
    .from('generations')
    .select(COLUMNS)
    .eq('asset_id', assetId)
    .limit(1)

  if (error) throw dbError('check the gallery', error)
  return data?.[0] ? toEntry(data[0]) : null
}

/**
 * Record a finished result against an influencer.
 *
 * Idempotent per asset: when the result is already filed — the worker got
 * there first, or the Queue tab saved it again — the existing entry comes back
 * instead of a duplicate tile.
 *
 * @returns {Promise<{id, type, label, url, assetId, date}>} in the shape the
 *          gallery renders, so a caller can prepend it without a refetch.
 */
export async function add({ influencerId, assetId, kind = 'image', label = 'Generation' }) {
  if (!assetId) throw new Error('A generation needs an asset.')
  const userId = await requireUserId()

  const existing = await findByAsset(assetId)
  if (existing) return existing

  const { data, error } = await supabase
    .from('generations')
    .insert({
      user_id: userId,
      influencer_id: influencerId || null,
      asset_id: assetId,
      kind,
      label,
    })
    .select(COLUMNS)
    .single()

  if (error?.code === '23505') {
    // The worker filed it in the same moment; the unique index (migration 0003)
    // kept it to one entry, and that entry is the answer.
    const filed = await findByAsset(assetId)
    if (filed) return filed
  }
  if (error) throw dbError('save this to the gallery', error)
  return toEntry(data)
}

/**
 * Remove a gallery entry AND the file behind it.
 *
 * Deleting only the row would leave an orphaned S3 object — invisible to the
 * user, still billed. The API endpoint does both, which is why this does not
 * just delete the row here.
 */
export async function remove(generationId) {
  const { apiFetch } = await import('../api/client')
  await apiFetch('/api/generations/delete', { method: 'POST', body: { generationId } })
}
