/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Per-influencer JSON documents: studio settings and creation params.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   studio_settings  what the video studio was last set to — convenience state
 *   creation_params  what the influencer was generated from — written once, in
 *                    the create transaction (influencers/index.js); read here
 *                    so "Regenerate" produces the same person
 *
 * The shapes belong to the app, so the server stores them as given, within a
 * size limit.
 */

import { one, query } from '../_lib/db.js'
import { userRoute, badRequest, forbidden, noStore, HttpError } from '../_lib/http.js'
import { isUuid } from '../_lib/validate.js'

const MAX_DOCUMENT_BYTES = 64 * 1024

function influencerIdFrom(value) {
  if (!isUuid(value)) throw badRequest('influencerId is required.')
  return value
}

/** GET /api/studio-settings?influencerId= → { settings | null } */
export const getStudioSettings = userRoute(async (req, res, user) => {
  const influencerId = influencerIdFrom(req.query?.influencerId)
  const row = await one('select settings from studio_settings where user_id = $1 and influencer_id = $2', [user.id, influencerId])
  noStore(res)
  res.json({ settings: row?.settings ?? null })
}, { tag: '[studio-settings/get]', message: 'Unable to load your settings.' })

/** POST /api/studio-settings  { influencerId, settings } → 204 */
export const saveStudioSettings = userRoute(async (req, res, user) => {
  const influencerId = influencerIdFrom(req.body?.influencerId)
  const settings = req.body?.settings
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw badRequest('settings must be an object.')
  const serialised = JSON.stringify(settings)
  if (Buffer.byteLength(serialised) > MAX_DOCUMENT_BYTES) throw new HttpError(413, 'These settings are too large to save.', 'TOO_LARGE')

  if (!(await one('select 1 from influencers where id = $1 and user_id = $2', [influencerId, user.id]))) {
    throw forbidden('This influencer belongs to another account.')
  }

  await query(
    `insert into studio_settings (user_id, influencer_id, settings)
     values ($1, $2, $3::jsonb)
     on conflict (user_id, influencer_id) do update set settings = excluded.settings`,
    [user.id, influencerId, serialised],
  )
  res.status(204).end()
}, { tag: '[studio-settings/save]', message: 'Unable to save your settings.' })

/** GET /api/creation-params?influencerId= → { params | null } */
export const getCreationParams = userRoute(async (req, res, user) => {
  const influencerId = influencerIdFrom(req.query?.influencerId)
  const row = await one('select params from creation_params where user_id = $1 and influencer_id = $2', [user.id, influencerId])
  noStore(res)
  res.json({ params: row?.params ?? null })
}, { tag: '[creation-params/get]', message: 'Unable to load the generation settings for this influencer.' })
