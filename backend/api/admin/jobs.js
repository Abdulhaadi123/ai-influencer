/**
 * Admin — generation jobs.
 *
 *   GET /api/admin/jobs?state=&model=&userId=&q=&page=
 *
 * Every job any user has started, with what KIE charged for it (`kie_credits`,
 * null when KIE did not say). Read-only: an admin cannot change a job's state —
 * only KIE's own answer does (api/_lib/kieStatus.js).
 */

import { many, one } from '../_lib/db.js'
import { adminRoute, pageOf, likeTerm, queryText } from '../_lib/admin.js'
import { badRequest, noStore } from '../_lib/http.js'
import { isUuid } from '../_lib/validate.js'

const STATES = ['waiting', 'queuing', 'generating', 'success', 'fail']

export const list = adminRoute(async (req, res) => {
  const { page, pageSize, limit, offset } = pageOf(req)

  const state = req.query?.state || null
  if (state !== null && !STATES.includes(state)) throw badRequest(`state must be one of: ${STATES.join(', ')}.`)
  const userId = req.query?.userId || null
  if (userId !== null && !isUuid(userId)) throw badRequest('userId is not valid.')
  const model = queryText(req.query?.model, 200)
  const search = queryText(req.query?.q, 100)
  const q = search === null ? null : likeTerm(search)

  const filter = `
    ($1::text is null or j.state = $1)
    and ($2::uuid is null or j.user_id = $2::uuid)
    and ($3::text is null or j.model = $3)
    and ($4::text is null or u.email ilike '%' || $4 || '%' escape '\\' or j.kie_task_id ilike '%' || $4 || '%' escape '\\')`

  const rows = await many(
    `select j.id, j.user_id, u.email, j.kie_task_id, j.kind, j.label, j.model, j.state, j.fail_msg,
            j.kie_credits, j.created_at, j.completed_at,
            -- What the person was charged for this job, net of any refund. NULL when nothing was
            -- ever charged (billing was only watching), which is different from a charge of 0.
            (select -sum(l.delta) from credit_ledger l
              where l.user_id = j.user_id and l.kie_task_id = j.kie_task_id and l.kind in ('spend', 'refund')) as charged
       from generation_jobs j
       join users u on u.id = j.user_id
      where ${filter}
      order by j.created_at desc, j.id
      limit $5 offset $6`,
    [state, userId, model, q, limit, offset],
  )
  const { total } = await one(
    `select count(*)::int as total from generation_jobs j join users u on u.id = j.user_id where ${filter}`,
    [state, userId, model, q],
  )

  noStore(res)
  res.json({
    jobs: rows.map(r => ({
      id: r.id,
      userId: r.user_id,
      email: r.email,
      taskId: r.kie_task_id,
      kind: r.kind,
      label: r.label,
      model: r.model,
      state: r.state,
      failMessage: r.fail_msg,
      kieCredits: r.kie_credits === null ? null : Number(r.kie_credits),
      charged: r.charged === null ? null : Math.round(Number(r.charged) * 1000) / 1000,
      createdAt: r.created_at,
      completedAt: r.completed_at,
    })),
    total, page, pageSize,
  })
}, { tag: '[admin/jobs]', message: 'Unable to load jobs.' })
