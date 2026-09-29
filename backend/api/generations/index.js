/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The gallery — look up and add entries. (Delete: ./delete.js)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * One entry per file (unique index generations_asset_key). A result can be
 * filed by the screen that made it, the Queue tab, or the worker; adding an
 * entry that already exists returns that entry instead of a duplicate.
 */

import { one, many } from '../_lib/db.js'
import { userRoute, badRequest, forbidden, noStore } from '../_lib/http.js'
import { isUuid, text, ASSET_KINDS } from '../_lib/validate.js'

const COLUMNS = 'id, influencer_id, asset_id, kind, label, created_at'

/** Page size for the Gallery's own fetches. */
const MAX_PAGE = 60

/** GET /api/generations/by-asset?assetId= → { generation | null } */
export const byAsset = userRoute(async (req, res, user) => {
  const { assetId } = req.query || {}
  if (!isUuid(assetId)) throw badRequest('assetId is required.')
  const generation = await one(`select ${COLUMNS} from generations where user_id = $1 and asset_id = $2`, [user.id, assetId])
  noStore(res)
  res.json({ generation })
}, { tag: '[generations/by-asset]', message: 'Unable to load the gallery. Please try again.' })

/**
 * GET /api/generations/by-influencer?influencerId=&limit=&beforeAt=&beforeId=
 * → { generations, hasMore }
 *
 * One influencer's gallery, newest first, in pages — because the roster only
 * carries the newest few (influencers/index.js).
 *
 * Keyset pagination on (created_at, id), not OFFSET: a result collected while
 * the user is scrolling shifts every offset by one, which silently skips or
 * repeats an entry. Pass back the last row's `created_at` and `id`.
 */
export const byInfluencer = userRoute(async (req, res, user) => {
  const { influencerId, beforeAt = null, beforeId = null } = req.query || {}
  if (!isUuid(influencerId)) throw badRequest('influencerId is required.')
  const limit = Math.min(Math.max(Number(req.query?.limit) || 30, 1), MAX_PAGE)

  if (beforeAt !== null && Number.isNaN(new Date(String(beforeAt)).getTime())) {
    throw badRequest('beforeAt is not a valid time.')
  }
  if (beforeId !== null && !isUuid(beforeId)) throw badRequest('beforeId is not valid.')
  // Both halves of the cursor or neither — one alone cannot order anything.
  const cursor = beforeAt !== null && beforeId !== null

  // One row more than asked for, to answer hasMore without a second count.
  const rows = await many(
    `select ${COLUMNS} from generations
      where user_id = $1 and influencer_id = $2
        and ($3::boolean is false or (created_at, id) < ($4::timestamptz, $5::uuid))
      order by created_at desc, id desc
      limit $6`,
    [user.id, influencerId, cursor, cursor ? beforeAt : null, cursor ? beforeId : null, limit + 1],
  )

  noStore(res)
  res.json({ generations: rows.slice(0, limit), hasMore: rows.length > limit })
}, { tag: '[generations/by-influencer]', message: 'Unable to load the gallery. Please try again.' })

/** POST /api/generations/add  { assetId, influencerId?, kind?, label? } → { generation } */
export const add = userRoute(async (req, res, user) => {
  const { assetId, influencerId = null, kind = 'image' } = req.body || {}
  const label = text(req.body?.label, 120) || 'Generation'
  if (!isUuid(assetId)) throw badRequest('A gallery entry needs a file.')
  if (influencerId !== null && !isUuid(influencerId)) throw badRequest('influencerId is not valid.')
  if (!ASSET_KINDS.includes(kind)) throw badRequest('kind is not valid.')

  if (!(await one('select 1 from assets where id = $1 and user_id = $2', [assetId, user.id]))) {
    throw forbidden('This file belongs to another account.')
  }
  if (influencerId && !(await one('select 1 from influencers where id = $1 and user_id = $2', [influencerId, user.id]))) {
    throw forbidden('This influencer belongs to another account.')
  }

  const inserted = await one(
    `insert into generations (user_id, influencer_id, asset_id, kind, label)
     values ($1, $2, $3, $4, $5)
     on conflict (asset_id) do nothing
     returning ${COLUMNS}`,
    [user.id, influencerId, assetId, kind, label],
  )
  const generation = inserted
    ?? await one(`select ${COLUMNS} from generations where user_id = $1 and asset_id = $2`, [user.id, assetId])

  res.status(inserted ? 201 : 200).json({ generation })
}, { tag: '[generations/add]', message: 'Unable to save this to the gallery. Please try again.' })
