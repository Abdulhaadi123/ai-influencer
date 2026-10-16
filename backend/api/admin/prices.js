/**
 * Admin — the model price list.
 *
 *   GET  /api/admin/prices
 *   POST /api/admin/prices/upsert  { model, unit, credits, enabled, label?, note? }
 *   POST /api/admin/prices/delete  { model }
 *
 * Each row prices one KIE model in the app's own credits and says whether it may
 * be used (api/_lib/prices.js). A model that KIE bills differently per mode can have a
 * row per mode, named `<model>:<mode>` (`kling-3.0/motion-control:720p`). The list also shows `unpriced`: models that jobs
 * have actually used which have no row, so nothing is being served for free by
 * accident. Deleting a row does not disable the model — a model with no row is
 * allowed; to switch one off, keep its row and clear `enabled`.
 */

import { many, transaction } from '../_lib/db.js'
import { adminRoute, audit, requiredText, optionalText } from '../_lib/admin.js'
import { badRequest, notFound, noStore } from '../_lib/http.js'

const UNITS = ['per_second', 'per_video', 'per_image']

/** KIE ids look like `kling-3.0/video` or `veo3_fast`. Nothing else is a model id. */
const MODEL_ID = /^[A-Za-z0-9][\w.\-/:]{0,199}$/

/** Far above any real price; stops a typo from becoming a number nobody can read. */
const MAX_CREDITS = 1_000_000

const shape = row => ({
  model: row.model,
  label: row.label,
  unit: row.unit,
  credits: Number(row.credits),
  enabled: row.enabled,
  note: row.note,
  updatedAt: row.updated_at,
  updatedBy: row.updated_by_email ?? null,
})

function readModel(value) {
  const model = requiredText(value, 'model', 200)
  if (!MODEL_ID.test(model)) throw badRequest('That is not a model id.')
  return model
}

export const list = adminRoute(async (_req, res) => {
  const prices = await many(
    `select p.model, p.label, p.unit, p.credits, p.enabled, p.note, p.updated_at, u.email as updated_by_email
       from model_prices p left join users u on u.id = p.updated_by
      order by p.model`,
  )
  const unpriced = await many(
    `select j.model, count(*)::int as jobs, coalesce(sum(j.kie_credits), 0) as kie_credits
       from generation_jobs j
      where j.model is not null and j.model <> ''
        and not exists (
              select 1 from model_prices p
               where p.model = j.model
                  or left(p.model, length(j.model) + 1) = j.model || ':'   -- a row for one mode of the model prices it
            )
      group by j.model
      order by jobs desc, j.model`,
  )
  noStore(res)
  res.json({
    prices: prices.map(shape),
    unpriced: unpriced.map(r => ({ model: r.model, jobs: r.jobs, kieCredits: Number(r.kie_credits) || 0 })),
    units: UNITS,
  })
}, { tag: '[admin/prices]', message: 'Unable to load prices.' })

export const upsert = adminRoute(async (req, res, admin) => {
  const model = readModel(req.body?.model)
  const { unit, credits, enabled } = req.body || {}
  if (!UNITS.includes(unit)) throw badRequest(`unit must be one of: ${UNITS.join(', ')}.`)
  if (typeof credits !== 'number' || !Number.isFinite(credits) || credits < 0 || credits > MAX_CREDITS) {
    throw badRequest(`credits must be a number from 0 to ${MAX_CREDITS}.`)
  }
  if (typeof enabled !== 'boolean') throw badRequest('enabled must be true or false.')
  const label = optionalText(req.body?.label, 'The label', 120)
  const note = optionalText(req.body?.note, 'The note', 300)

  const row = await transaction(async client => {
    const { rows } = await client.query(
      `insert into model_prices (model, label, unit, credits, enabled, note, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (model) do update
         set label = $2, unit = $3, credits = $4, enabled = $5, note = $6, updated_by = $7
       returning model, label, unit, credits, enabled, note, updated_at`,
      [model, label, unit, credits, enabled, note, admin.id],
    )
    await audit(admin, 'price.upsert', { targetType: 'model', targetId: model, details: { unit, credits, enabled } }, client)
    return rows[0]
  })
  res.json({ price: shape({ ...row, updated_by_email: admin.email }) })
}, { tag: '[admin/prices/upsert]', message: 'Unable to save this price.' })

export const remove = adminRoute(async (req, res, admin) => {
  const model = readModel(req.body?.model)
  const removed = await transaction(async client => {
    const { rowCount } = await client.query('delete from model_prices where model = $1', [model])
    if (rowCount) await audit(admin, 'price.delete', { targetType: 'model', targetId: model }, client)
    return rowCount > 0
  })
  if (!removed) throw notFound('That model has no price.')
  res.json({ ok: true })
}, { tag: '[admin/prices/delete]', message: 'Unable to delete this price.' })
