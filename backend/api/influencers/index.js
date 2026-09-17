/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Influencers — list, create, update. (Delete: ./delete.js)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Rows go out in database shape (snake_case, asset ids); the app maps them and
 * turns asset ids into signed URLs itself (mobile/core/data/influencers.js).
 *
 * Writes accept only the columns listed below. Column names in the generated
 * SQL come from that list and never from the request, and every asset id a
 * client wants to attach is checked to be its own — otherwise an influencer
 * could be pointed at a stranger's file.
 */

import { one, many, query, transaction } from '../_lib/db.js'
import { userRoute, badRequest, forbidden, notFound, noStore } from '../_lib/http.js'
import { isUuid } from '../_lib/validate.js'

export const INFLUENCER_COLUMNS = `
  id, name, gender, age, type,
  niche, niches, niche_custom, backstory, intro_extrovert, physical_desc, vibe_words,
  main_asset_id, prompt, reference_asset_id, copy_attributes,
  character_sheet_asset_id, closeup1_asset_id, closeup2_asset_id,
  audience, clothing_style, hobbies, location, palette, voice, dream_brands, content_pillars,
  wardrobe_slots, created_at, updated_at
`

const TEXT = [
  'name', 'gender', 'age', 'type', 'niche', 'niche_custom', 'backstory', 'physical_desc', 'prompt',
  'audience', 'clothing_style', 'hobbies', 'location', 'voice', 'dream_brands',
]
const INTEGER = ['intro_extrovert']
const TEXT_ARRAY = ['niches', 'vibe_words', 'copy_attributes', 'palette', 'content_pillars']
const ASSET_ID = ['main_asset_id', 'reference_asset_id', 'character_sheet_asset_id', 'closeup1_asset_id', 'closeup2_asset_id']
const JSON_COLUMNS = ['wardrobe_slots']

/** Columns that may not be null — a null is replaced by the column's default. */
const NOT_NULL_DEFAULTS = { name: '', type: 'Influencer' }

const MAX_TEXT = 20_000
const MAX_ARRAY = 100

/** The request's patch, reduced to known columns with checked values. */
function cleanRow(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('Nothing to save.')
  const row = {}

  for (const [column, value] of Object.entries(input)) {
    if (TEXT.includes(column)) {
      if (value === null) row[column] = NOT_NULL_DEFAULTS[column] ?? null
      else if (typeof value === 'string') row[column] = value.slice(0, MAX_TEXT)
      else throw badRequest(`${column} must be text.`)
    } else if (INTEGER.includes(column)) {
      const n = Number(value)
      if (!Number.isInteger(n) || n < 0 || n > 100) throw badRequest(`${column} must be a whole number from 0 to 100.`)
      row[column] = n
    } else if (TEXT_ARRAY.includes(column)) {
      if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw badRequest(`${column} must be a list of text.`)
      row[column] = value.slice(0, MAX_ARRAY).map(v => v.slice(0, 500))
    } else if (ASSET_ID.includes(column)) {
      if (value !== null && !isUuid(value)) throw badRequest(`${column} is not a valid file id.`)
      row[column] = value
    } else if (JSON_COLUMNS.includes(column)) {
      if (!Array.isArray(value) || value.length > 20) throw badRequest(`${column} must be a short list.`)
      row[column] = value
    }
    // Anything else — including user_id and id — is ignored.
  }
  return row
}

/** Every asset id a cleaned row points at, including inside wardrobe slots. */
function assetIdsIn(row) {
  const ids = ASSET_ID.map(c => row[c]).filter(Boolean)
  for (const slot of row.wardrobe_slots || []) {
    if (slot && isUuid(slot.asset_id)) ids.push(slot.asset_id)
  }
  return ids
}

async function assertAssetsOwned(run, userId, ids) {
  const wanted = [...new Set(ids.filter(Boolean))]
  if (!wanted.length) return
  const { rows } = await run(
    'select count(*)::int as n from assets where user_id = $1 and id = any($2::uuid[])',
    [userId, wanted],
  )
  if (rows[0].n !== wanted.length) throw forbidden('That file is not yours.')
}

function sqlValue(column, value) {
  return JSON_COLUMNS.includes(column) ? JSON.stringify(value) : value
}

function placeholder(column, index) {
  return JSON_COLUMNS.includes(column) ? `$${index}::jsonb` : `$${index}`
}


/**
 * GET /api/influencers → { influencers: [...rows], generations: [...rows] }
 * Two queries however many influencers there are.
 */
export const list = userRoute(async (req, res, user) => {
  const influencers = await many(
    `select ${INFLUENCER_COLUMNS} from influencers where user_id = $1 order by created_at desc`,
    [user.id],
  )
  const generations = influencers.length
    ? await many(
        `select id, influencer_id, asset_id, kind, label, created_at
           from generations
          where user_id = $1 and influencer_id = any($2::uuid[])
          order by created_at desc`,
        [user.id, influencers.map(i => i.id)],
      )
    : []
  noStore(res)
  res.json({ influencers, generations })
}, { tag: '[influencers/list]', message: 'Your influencers could not be loaded. Please try again.' })

/**
 * POST /api/influencers/create  { record, linkAssetIds?, creationParams? } → 201 { influencer }
 *
 * One transaction: the influencer, the files the create wizard stored before it
 * existed (linked so deleting the influencer sweeps them), and what it was
 * generated from. Any part failing saves none of it.
 */
export const create = userRoute(async (req, res, user) => {
  const { record, linkAssetIds = [], creationParams = null } = req.body || {}
  const row = cleanRow(record)
  if (!Array.isArray(linkAssetIds) || linkAssetIds.some(id => id !== null && !isUuid(id))) {
    throw badRequest('linkAssetIds must be a list of file ids.')
  }
  const toLink = [...new Set(linkAssetIds.filter(Boolean))]
  if (creationParams !== null && (typeof creationParams !== 'object' || Array.isArray(creationParams))) {
    throw badRequest('creationParams must be an object.')
  }

  const influencer = await transaction(async client => {
    const run = (text, params) => client.query(text, params)
    await assertAssetsOwned(run, user.id, [...assetIdsIn(row), ...toLink])

    const columns = Object.keys(row)
    const { rows: [created] } = await client.query(
      `insert into influencers (user_id${columns.map(c => `, ${c}`).join('')})
       values ($1${columns.map((c, i) => `, ${placeholder(c, i + 2)}`).join('')})
       returning ${INFLUENCER_COLUMNS}`,
      [user.id, ...columns.map(c => sqlValue(c, row[c]))],
    )

    if (toLink.length) {
      await client.query(
        'update assets set influencer_id = $1 where user_id = $2 and id = any($3::uuid[]) and influencer_id is null',
        [created.id, user.id, toLink],
      )
    }
    if (creationParams) {
      await client.query(
        'insert into creation_params (user_id, influencer_id, params) values ($1, $2, $3::jsonb)',
        [user.id, created.id, JSON.stringify(creationParams)],
      )
    }
    return created
  })

  res.status(201).json({ influencer })
}, { tag: '[influencers/create]', message: 'The influencer could not be saved. Please try again.' })

/** POST /api/influencers/update  { id, patch } → { influencer } */
export const update = userRoute(async (req, res, user) => {
  const { id, patch } = req.body || {}
  if (!isUuid(id)) throw badRequest('id is required.')
  const row = cleanRow(patch)
  const columns = Object.keys(row)

  if (!columns.length) {
    const current = await one(`select ${INFLUENCER_COLUMNS} from influencers where id = $1 and user_id = $2`, [id, user.id])
    if (!current) throw notFound('No such influencer.')
    return res.json({ influencer: current })
  }

  await assertAssetsOwned(query, user.id, assetIdsIn(row))

  const influencer = await one(
    `update influencers
        set ${columns.map((c, i) => `${c} = ${placeholder(c, i + 3)}`).join(', ')}
      where id = $1 and user_id = $2
      returning ${INFLUENCER_COLUMNS}`,
    [id, user.id, ...columns.map(c => sqlValue(c, row[c]))],
  )
  if (!influencer) throw notFound('No such influencer.')
  res.json({ influencer })
}, { tag: '[influencers/update]', message: 'Your change could not be saved. Please try again.' })
