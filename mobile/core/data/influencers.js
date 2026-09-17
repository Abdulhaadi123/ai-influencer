/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Influencers — reading and writing the user's roster.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── The shape contract ───────────────────────────────────────────────────────
 *
 * Screens keep working with the field names they always used — `mainImage`,
 * `characterSheetImage`, `generationHistory` — even though the server stores
 * asset ids and the files live in S3. This module is the translation layer:
 * rows and asset ids come from the API, displayable objects come out.
 *
 * Each record also carries the raw `*AssetId` values, because a writer needs
 * the id (a signed URL is not a durable reference) and because deleting an
 * influencer has to know which files belong to it.
 *
 * The server decides whose rows these are from the session; nothing here sends
 * a user id.
 */

import { apiFetch } from '../api/client'
import { resolveUrls } from './assets'

/**
 * API row → the object screens consume.
 * @param {object} row
 * @param {Map<string,string>} urls  assetId → signed URL
 * @param {object[]} history         this influencer's gallery entries, newest first
 */
function toApp(row, urls, history = []) {
  const url = id => (id ? urls.get(String(id)) ?? null : null)

  return {
    id: row.id,
    name: row.name || '',
    gender: row.gender,
    age: row.age,
    type: row.type || 'Influencer',
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),

    niche: row.niche || '',
    niches: row.niches || [],
    nicheCustom: row.niche_custom || '',
    backstory: row.backstory || '',
    introExtrovert: row.intro_extrovert ?? 50,
    physicalDesc: row.physical_desc || '',
    vibeWords: row.vibe_words || [],

    // Displayable URLs…
    mainImage: url(row.main_asset_id),
    referenceImage: url(row.reference_asset_id),
    characterSheetImage: url(row.character_sheet_asset_id),
    closeUpImage1: url(row.closeup1_asset_id),
    closeUpImage2: url(row.closeup2_asset_id),

    // …and the durable references behind them.
    mainAssetId: row.main_asset_id,
    referenceAssetId: row.reference_asset_id,
    characterSheetAssetId: row.character_sheet_asset_id,
    closeUpImage1AssetId: row.closeup1_asset_id,
    closeUpImage2AssetId: row.closeup2_asset_id,

    prompt: row.prompt || '',
    copyAttributes: row.copy_attributes || [],

    audience: row.audience || '',
    clothingStyle: row.clothing_style || '',
    hobbies: row.hobbies || '',
    location: row.location || '',
    palette: row.palette || [],
    voice: row.voice || '',
    dreamBrands: row.dream_brands || '',
    contentPillars: row.content_pillars || [],

    wardrobeSlots: (row.wardrobe_slots || []).map(slot => ({
      ...slot,
      image: url(slot.asset_id),
    })),

    generationHistory: history,
  }
}

/** A gallery row → the entry shape the gallery renders. */
export function toGalleryEntry(row, url) {
  return {
    id: row.id,
    type: row.kind === 'video' ? 'video' : 'image',
    label: row.label,
    url: url ?? null,
    assetId: row.asset_id,
    date: new Date(row.created_at).getTime(),
  }
}

/** App patch → API columns. Only keys actually present are translated, so a
 *  partial update stays partial and cannot blank a field by omission. */
function toRow(patch) {
  const row = {}
  const map = {
    name: 'name',
    gender: 'gender',
    age: 'age',
    type: 'type',
    niche: 'niche',
    niches: 'niches',
    nicheCustom: 'niche_custom',
    backstory: 'backstory',
    introExtrovert: 'intro_extrovert',
    physicalDesc: 'physical_desc',
    vibeWords: 'vibe_words',
    prompt: 'prompt',
    copyAttributes: 'copy_attributes',
    audience: 'audience',
    clothingStyle: 'clothing_style',
    hobbies: 'hobbies',
    location: 'location',
    palette: 'palette',
    voice: 'voice',
    dreamBrands: 'dream_brands',
    contentPillars: 'content_pillars',
    wardrobeSlots: 'wardrobe_slots',

    mainAssetId: 'main_asset_id',
    referenceAssetId: 'reference_asset_id',
    characterSheetAssetId: 'character_sheet_asset_id',
    closeUpImage1AssetId: 'closeup1_asset_id',
    closeUpImage2AssetId: 'closeup2_asset_id',
  }

  for (const [appKey, column] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(patch, appKey)) row[column] = patch[appKey]
  }
  return row
}

/** The single-file fields of a record: the durable id, and the URL it displays as. */
const FILE_FIELDS = [
  { assetKey: 'mainAssetId', urlKey: 'mainImage', label: 'main image' },
  { assetKey: 'referenceAssetId', urlKey: 'referenceImage', label: 'reference image' },
  { assetKey: 'characterSheetAssetId', urlKey: 'characterSheetImage', label: 'character sheet' },
  { assetKey: 'closeUpImage1AssetId', urlKey: 'closeUpImage1', label: 'close-up' },
  { assetKey: 'closeUpImage2AssetId', urlKey: 'closeUpImage2', label: 'feature sheet' },
]

/**
 * Where a file is used on this influencer, other than the gallery — e.g.
 * ['character sheet']. A gallery entry and a reference sheet are often the same
 * file, so deleting one deletes the other.
 */
export function assetUses(record, assetId) {
  if (!record || !assetId) return []
  const id = String(assetId)
  const uses = FILE_FIELDS.filter(f => record[f.assetKey] && String(record[f.assetKey]) === id).map(f => f.label)
  if ((record.wardrobeSlots || []).some(s => s?.asset_id && String(s.asset_id) === id)) uses.push('wardrobe')
  return uses
}

/**
 * The record with a deleted file removed from every field that showed it. The
 * database does the same (the foreign keys are ON DELETE SET NULL); this keeps
 * the screen from holding a link to a file that is gone.
 */
export function withoutAsset(record, assetId) {
  if (!assetUses(record, assetId).length) return record
  const id = String(assetId)
  const next = { ...record }
  for (const f of FILE_FIELDS) {
    if (next[f.assetKey] && String(next[f.assetKey]) === id) {
      next[f.assetKey] = null
      next[f.urlKey] = null
    }
  }
  next.wardrobeSlots = (next.wardrobeSlots || []).map(s =>
    s?.asset_id && String(s.asset_id) === id ? { ...s, asset_id: null, image: null } : s)
  return next
}

/** Every asset id an app-shaped record displays — what a URL refresh re-signs. */
export function assetIdsOf(record) {
  return [
    record?.mainAssetId, record?.referenceAssetId, record?.characterSheetAssetId,
    record?.closeUpImage1AssetId, record?.closeUpImage2AssetId,
    ...(record?.wardrobeSlots || []).map(slot => slot?.asset_id),
    ...(record?.generationHistory || []).map(entry => entry?.assetId),
  ].filter(Boolean)
}

/**
 * The record with re-signed URLs swapped in.
 *
 * Returns the SAME object when nothing changed, so a refresh that re-signs
 * nothing re-renders nothing. An id missing from `urls` keeps its current URL.
 *
 * @param {object} record          app-shaped influencer
 * @param {Map<string,string>} urls assetId → signed URL
 */
export function withUrls(record, urls) {
  let changed = false
  const swap = (id, current) => {
    const next = id && urls.has(String(id)) ? urls.get(String(id)) : current
    if (next !== current) changed = true
    return next
  }

  const fields = {
    mainImage: swap(record.mainAssetId, record.mainImage),
    referenceImage: swap(record.referenceAssetId, record.referenceImage),
    characterSheetImage: swap(record.characterSheetAssetId, record.characterSheetImage),
    closeUpImage1: swap(record.closeUpImage1AssetId, record.closeUpImage1),
    closeUpImage2: swap(record.closeUpImage2AssetId, record.closeUpImage2),
  }
  const wardrobeSlots = (record.wardrobeSlots || []).map(slot => {
    const image = swap(slot?.asset_id, slot?.image)
    return image === slot?.image ? slot : { ...slot, image }
  })
  const generationHistory = (record.generationHistory || []).map(entry => {
    const url = swap(entry?.assetId, entry?.url)
    return url === entry?.url ? entry : { ...entry, url }
  })

  if (!changed) return record
  return { ...record, ...fields, wardrobeSlots, generationHistory }
}

/** Every asset id referenced by a set of rows, for one batched URL request. */
function collectAssetIds(rows, generations) {
  const ids = []
  for (const r of rows) {
    ids.push(
      r.main_asset_id, r.reference_asset_id,
      r.character_sheet_asset_id, r.closeup1_asset_id, r.closeup2_asset_id,
    )
    for (const slot of r.wardrobe_slots || []) ids.push(slot?.asset_id)
  }
  for (const g of generations) ids.push(g.asset_id)
  return ids.filter(Boolean)
}

/**
 * The signed-in user's whole roster, gallery attached. Two round trips however
 * many influencers there are: the rows, and one batch of signed URLs.
 */
export async function list() {
  const { influencers: rows = [], generations = [] } = await apiFetch('/api/influencers')
  if (!rows.length) return []

  const urls = await resolveUrls(collectAssetIds(rows, generations))

  const historyByInfluencer = new Map()
  for (const g of generations) {
    const entries = historyByInfluencer.get(g.influencer_id) || []
    entries.push(toGalleryEntry(g, urls.get(String(g.asset_id))))
    historyByInfluencer.set(g.influencer_id, entries)
  }

  return rows.map(r => toApp(r, urls, historyByInfluencer.get(r.id) || []))
}

/**
 * Create an influencer.
 *
 * @param {object} record  app-shaped fields (buildNewInfluencer)
 * @param {object} [opts]
 * @param {string[]} [opts.linkAssetIds]   files stored before the influencer
 *        existed (the create wizard's reference and generated image), so that
 *        deleting the influencer deletes them too
 * @param {object} [opts.creationParams]   what it was generated from, for Regenerate
 *
 * All of it is saved in one transaction on the server, or none of it.
 */
export async function create(record, { linkAssetIds = [], creationParams = null } = {}) {
  const { influencer } = await apiFetch('/api/influencers/create', {
    method: 'POST',
    body: {
      record: toRow(record),
      linkAssetIds: linkAssetIds.filter(Boolean),
      creationParams,
    },
  })
  const urls = await resolveUrls(collectAssetIds([influencer], []))
  return toApp(influencer, urls, [])
}

export async function update(id, patch) {
  const row = toRow(patch)
  if (Object.keys(row).length === 0) return null

  const { influencer } = await apiFetch('/api/influencers/update', { method: 'POST', body: { id, patch: row } })
  const urls = await resolveUrls(collectAssetIds([influencer], []))
  return toApp(influencer, urls, [])
}

/**
 * Delete an influencer and everything hanging off it. The server removes the
 * files from S3 before the rows, so nothing is left behind still billed.
 */
export async function remove(id) {
  await apiFetch('/api/influencers/delete', { method: 'POST', body: { influencerId: id } })
}
