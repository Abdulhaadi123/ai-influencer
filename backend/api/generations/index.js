/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The gallery — look up and add entries. (Delete: ./delete.js)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * One entry per file (unique index generations_asset_key). A result can be
 * filed by the screen that made it, the Queue tab, or the worker; adding an
 * entry that already exists returns that entry instead of a duplicate.
 */

import { one } from '../_lib/db.js'
import { userRoute, badRequest, forbidden, noStore } from '../_lib/http.js'
import { isUuid, text, ASSET_KINDS } from '../_lib/validate.js'

const COLUMNS = 'id, influencer_id, asset_id, kind, label, created_at'

/** GET /api/generations/by-asset?assetId= → { generation | null } */
export const byAsset = userRoute(async (req, res, user) => {
  const { assetId } = req.query || {}
  if (!isUuid(assetId)) throw badRequest('assetId is required.')
  const generation = await one(`select ${COLUMNS} from generations where user_id = $1 and asset_id = $2`, [user.id, assetId])
  noStore(res)
  res.json({ generation })
}, { tag: '[generations/by-asset]', message: 'Could not check the gallery. Please try again.' })

/** POST /api/generations/add  { assetId, influencerId?, kind?, label? } → { generation } */
export const add = userRoute(async (req, res, user) => {
  const { assetId, influencerId = null, kind = 'image' } = req.body || {}
  const label = text(req.body?.label, 120) || 'Generation'
  if (!isUuid(assetId)) throw badRequest('A gallery entry needs a file.')
  if (influencerId !== null && !isUuid(influencerId)) throw badRequest('influencerId is not valid.')
  if (!ASSET_KINDS.includes(kind)) throw badRequest('kind is not valid.')

  if (!(await one('select 1 from assets where id = $1 and user_id = $2', [assetId, user.id]))) {
    throw forbidden('That file is not yours.')
  }
  if (influencerId && !(await one('select 1 from influencers where id = $1 and user_id = $2', [influencerId, user.id]))) {
    throw forbidden('That influencer is not yours.')
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
}, { tag: '[generations/add]', message: 'Could not save this to the gallery. Please try again.' })
