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
import { userRoute, badRequest, forbidden, notFound, noStore, HttpError } from '../_lib/http.js'
import { isUuid, displayNameOf } from '../_lib/validate.js'

export const INFLUENCER_COLUMNS = `
  id, name, gender, age, type,
  niche, niches, niche_custom, backstory, intro_extrovert, physical_desc, vibe_words,
  main_asset_id, prompt, reference_asset_id, copy_attributes,
  character_sheet_asset_id, closeup1_asset_id, closeup2_asset_id,
  audience, clothing_style, hobbies, location, palette, voice, dream_brands, content_pillars,
  wardrobe_slots, created_at, updated_at
`

/**
 * The longest each text column may be; anything past it is cut off. Every one used to take 20,000
 * characters, so a name, a gender or an age could be a page long — and the roster, which carries every
 * influencer in one answer, was as heavy as the longest thing anyone had pasted into a short field.
 * The numbers are well above what the app lets a person type (mobile/core/config/inputLimits.js).
 */
const TEXT_LIMITS = {
  name: 100, gender: 40, age: 10, type: 60, niche: 100, niche_custom: 200,
  backstory: 4_000, physical_desc: 4_000, prompt: 12_000,
  audience: 500, clothing_style: 500, hobbies: 500, location: 200, voice: 200, dream_brands: 500,
}
const TEXT = Object.keys(TEXT_LIMITS)
const INTEGER = ['intro_extrovert']
const TEXT_ARRAY = ['niches', 'vibe_words', 'copy_attributes', 'palette', 'content_pillars']
const ASSET_ID = ['main_asset_id', 'reference_asset_id', 'character_sheet_asset_id', 'closeup1_asset_id', 'closeup2_asset_id']
const JSON_COLUMNS = ['wardrobe_slots']

/** Columns that may not be null — a null is replaced by the column's default. */
const NOT_NULL_DEFAULTS = { name: '', type: 'Influencer', intro_extrovert: 50 }

const MAX_ARRAY = 100

/**
 * How many influencers one account may hold. The roster is read whole, every time the app opens, so an
 * account with thousands would make its own app slow; and each influencer is a person who costs money
 * to generate, so nobody making a real roster comes near this. Read when used, so a test can change it.
 */
const maxInfluencers = () => Number(process.env.MAX_INFLUENCERS_PER_USER) || 100

/** A JSON document stored on an influencer (wardrobe slots, the creation parameters): as large as studio settings may be. */
const MAX_JSON_BYTES = 64 * 1024
const tooLarge = value => Buffer.byteLength(JSON.stringify(value)) > MAX_JSON_BYTES

/**
 * How many of an influencer's newest gallery entries the roster carries.
 *
 * Enough to fill the first screen of the Gallery grid; the rest is paged in.
 * Every entry here costs a presigned URL on the client, so this number is the
 * app's startup cost per influencer.
 */
const GALLERY_PREVIEW = 12

/** '' for no age; otherwise a whole number from 18 to 99, as text; anything else is a 400. */
function ageOf(value) {
  const text = value.trim()
  if (!text) return ''
  const n = /^\d{1,3}$/.test(text) ? Number(text) : NaN
  if (!(n >= 18 && n <= 99)) throw badRequest('Age must be a whole number from 18 to 99.', 'BAD_AGE')
  return String(n)
}

/** The request's patch, reduced to known columns with checked values. */
function cleanRow(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('Nothing to save.')
  const row = {}

  for (const [column, value] of Object.entries(input)) {
    if (TEXT.includes(column)) {
      if (value === null) row[column] = NOT_NULL_DEFAULTS[column] ?? null
      // A name is shown as one line in lists and headings: line breaks and runs of spaces are tidied away.
      else if (typeof value === 'string' && column === 'name') row[column] = displayNameOf(value, TEXT_LIMITS.name) ?? ''
      // An age is optional, and otherwise an adult's: 18 to 99 (mobile/core/config/inputLimits.js says the same).
      else if (typeof value === 'string' && column === 'age') row[column] = ageOf(value)
      else if (typeof value === 'string') row[column] = value.slice(0, TEXT_LIMITS[column])
      else throw badRequest(`${column} must be text.`)
    } else if (INTEGER.includes(column)) {
      // A number, or text that is one. (Number() alone also takes true, [] and "" for 1, 0 and 0 — and
      // throws on an object whose toString is not a function, which was a 500 for a hand-made body.)
      const n = value === null
        ? NOT_NULL_DEFAULTS[column]
        : typeof value === 'number' || (typeof value === 'string' && value.trim() !== '') ? Number(value) : NaN
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
      // Each entry is a slot (an object). The app reads `slot.asset_id` of every one when it loads the roster, so a
      // `null` or a number saved here would stop the whole roster from opening.
      if (value.some(slot => slot === null || typeof slot !== 'object' || Array.isArray(slot))) {
        throw badRequest(`${column} must be a list of objects.`)
      }
      if (tooLarge(value)) throw badRequest(`${column} is too large.`, 'TOO_LARGE')
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
  if (rows[0].n !== wanted.length) throw forbidden('This file belongs to another account.')
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
  const ids = influencers.map(i => i.id)

  // Only the newest few per influencer. This query had no LIMIT at all, so
  // opening the app fetched every generation the account had ever made and the
  // client then asked storage to sign a URL for every one of them — an
  // account with a few hundred clips paid that cost on every launch, and again
  // every three minutes when the URLs were refreshed. The rest of a gallery is
  // fetched by the Gallery tab as it is scrolled (generations/index.js).
  const generations = ids.length
    ? await many(
        `select id, influencer_id, asset_id, kind, label, created_at
           from (
             select g.id, g.influencer_id, g.asset_id, g.kind, g.label, g.created_at,
                    row_number() over (
                      partition by g.influencer_id order by g.created_at desc, g.id desc
                    ) as rn
               from generations g
              where g.user_id = $1 and g.influencer_id = any($2::uuid[])
           ) t
          where t.rn <= $3
          order by t.created_at desc`,
        [user.id, ids, GALLERY_PREVIEW],
      )
    : []

  // The true totals, so a gallery showing 12 of 200 can still say 200 and know
  // there is more to fetch.
  const counts = ids.length
    ? await many(
        `select influencer_id,
                count(*)::int as total,
                count(*) filter (where kind = 'video')::int as videos,
                count(*) filter (where kind = 'image')::int as images
           from generations
          where user_id = $1 and influencer_id = any($2::uuid[])
          group by influencer_id`,
        [user.id, ids],
      )
    : []

  noStore(res)
  res.json({ influencers, generations, counts, previewLimit: GALLERY_PREVIEW })
}, { tag: '[influencers/list]', message: 'Unable to load your influencers. Please try again.' })

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
  if (creationParams !== null && tooLarge(creationParams)) throw badRequest('creationParams is too large.', 'TOO_LARGE')

  const influencer = await transaction(async client => {
    const run = (text, params) => client.query(text, params)
    const { rows: [held] } = await client.query('select count(*)::int as n from influencers where user_id = $1', [user.id])
    if (held.n >= maxInfluencers()) {
      throw new HttpError(409, `You have reached the limit of ${maxInfluencers()} influencers. Delete one to add another.`, 'INFLUENCER_LIMIT')
    }
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
}, { tag: '[influencers/create]', message: 'Unable to save the influencer. Please try again.' })

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
}, { tag: '[influencers/update]', message: 'Unable to save your changes. Please try again.' })
