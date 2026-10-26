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
import { isUuid, text, momentOf, wholeNumber, ASSET_KINDS } from '../_lib/validate.js'
import { cursorSql, cursorOf, olderThan, pageFrom } from '../_lib/paging.js'
import { OUTPUT_REMOVED_MESSAGE } from '../_lib/moderation/service.js'

const COLUMNS = `id, influencer_id, asset_id, kind, label, created_at, ${cursorSql()} as cursor`

/** What the gallery's filter can ask for. */
const GALLERY_KINDS = ['image', 'video']

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
 * GET /api/generations/by-influencer?influencerId=&limit=&cursor=&kind=
 * → { generations, hasMore, nextCursor }
 *
 * One influencer's gallery, newest first, in pages — because the roster only
 * carries the newest few (influencers/index.js). `kind` (image or video) pages
 * through that kind alone, so the gallery's filter never has to fetch a page of
 * videos to find no images in it.
 *
 * Keyset pagination (_lib/paging.js): pass back a row's `cursor` to continue
 * after it. `beforeAt` + `beforeId` (a row's created_at and id) is the older
 * form, still answered for app builds that send it; it is only as exact as a
 * millisecond, which is why it was replaced.
 */
export const byInfluencer = userRoute(async (req, res, user) => {
  const { influencerId, beforeAt = null, beforeId = null, cursor: cursorParam = null, kind = null } = req.query || {}
  if (!isUuid(influencerId)) throw badRequest('influencerId is required.')
  const limit = wholeNumber(req.query?.limit, { min: 1, max: MAX_PAGE, fallback: 30 })
  if (kind !== null && !GALLERY_KINDS.includes(kind)) throw badRequest('kind must be image or video.')

  const cursor = cursorParam === null ? null : cursorOf(cursorParam)
  if (cursorParam !== null && !cursor) throw badRequest('cursor is not valid.')

  const at = beforeAt === null ? null : momentOf(beforeAt)
  if (beforeAt !== null && !at) throw badRequest('beforeAt is not a valid time.')
  if (beforeId !== null && !isUuid(beforeId)) throw badRequest('beforeId is not valid.')
  // Both halves of the old cursor or neither — one alone cannot order anything.
  const legacy = !cursor && at !== null && beforeId !== null

  // One row more than asked for, to answer hasMore without a second count.
  const rows = await many(
    `select ${COLUMNS} from generations
      where user_id = $1 and influencer_id = $2
        and ($3::text is null or kind = $3::asset_kind)
        and ($4::boolean is false or ${olderThan('$5', '$6')})
        and ($7::boolean is false or (created_at, id) < ($8::timestamptz, $9::uuid))
      order by created_at desc, id desc
      limit $10`,
    [
      user.id, influencerId, kind,
      cursor !== null, cursor?.at ?? null, cursor?.id ?? null,
      legacy, legacy ? at : null, legacy ? beforeId : null,
      limit + 1,
    ],
  )

  const page = pageFrom(rows, limit)
  noStore(res)
  res.json({ generations: page.items, hasMore: page.hasMore, nextCursor: page.nextCursor })
}, { tag: '[generations/by-influencer]', message: 'Unable to load the gallery. Please try again.' })

/** POST /api/generations/add  { assetId, influencerId?, kind?, label? } → { generation } */
export const add = userRoute(async (req, res, user) => {
  const { assetId, influencerId = null, kind = 'image' } = req.body || {}
  const label = text(req.body?.label, 120) || 'Generation'
  if (!isUuid(assetId)) throw badRequest('A gallery entry needs a file.')
  if (influencerId !== null && !isUuid(influencerId)) throw badRequest('influencerId is not valid.')
  if (!ASSET_KINDS.includes(kind)) throw badRequest('kind is not valid.')

  const asset = await one('select moderation_status from assets where id = $1 and user_id = $2', [assetId, user.id])
  if (!asset) throw forbidden('This file belongs to another account.')
  // Filing a blocked file would put it back in front of its owner.
  if (asset.moderation_status === 'blocked') throw forbidden(OUTPUT_REMOVED_MESSAGE, 'CONTENT_BLOCKED')
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
