/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The generation queue.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * KIE has no endpoint that lists tasks, so a job's row is the only way back to a
 * result that was paid for. The app records a job the moment KIE accepts it
 * (register), asks the server to check on it (sync), and learns about changes by
 * asking what changed since it last looked (changes) — there is no push channel.
 *
 * Only the server writes a job's state and result link, from KIE's own answer
 * (_lib/kieStatus.js). A client cannot report a result: if it could, any user
 * could plant a link for the worker to fetch into their storage.
 */

import { one, many, query } from '../_lib/db.js'
import { userRoute, badRequest, forbidden, noStore, enforceLimit } from '../_lib/http.js'
import { isUuid, text, ASSET_KINDS } from '../_lib/validate.js'
import { fetchKieTaskStatus, applyKieStatus, ACTIVE_STATES, JOB_COLUMNS } from '../_lib/kieStatus.js'
import { rateLimit } from '../../lib/rateLimit.js'

const RESULT_TTL_HOURS = 24
const MAX_TASK_ID = 200

const taskIdFrom = value => (typeof value === 'string' && value && value.length <= MAX_TASK_ID ? value : null)

/** GET /api/jobs?limit= → { jobs } newest first */
export const list = userRoute(async (req, res, user) => {
  const limit = Math.min(Math.max(Number(req.query?.limit) || 60, 1), 200)
  const jobs = await many(
    `select ${JOB_COLUMNS} from generation_jobs where user_id = $1 order by created_at desc limit $2`,
    [user.id, limit],
  )
  noStore(res)
  res.json({ jobs })
}, { tag: '[jobs/list]', message: 'Unable to load the queue. Please try again.' })

/** GET /api/jobs/by-task?taskId= → { job | null } */
export const byTask = userRoute(async (req, res, user) => {
  const taskId = taskIdFrom(req.query?.taskId)
  if (!taskId) throw badRequest('taskId is required.')
  const job = await one(`select ${JOB_COLUMNS} from generation_jobs where user_id = $1 and kie_task_id = $2`, [user.id, taskId])
  noStore(res)
  res.json({ job })
}, { tag: '[jobs/by-task]', message: 'Unable to check this generation. Please try again.' })

/** GET /api/jobs/active-count?influencerId= → { count } */
export const activeCount = userRoute(async (req, res, user) => {
  const influencerId = req.query?.influencerId || null
  if (influencerId !== null && !isUuid(influencerId)) throw badRequest('influencerId is not valid.')
  const row = await one(
    `select count(*)::int as count from generation_jobs
      where user_id = $1 and state = any($2::text[]) and ($3::uuid is null or influencer_id = $3::uuid)`,
    [user.id, ACTIVE_STATES, influencerId],
  )
  noStore(res)
  res.json({ count: row.count })
}, { tag: '[jobs/active-count]', message: 'Unable to count active generations.' })

/**
 * GET /api/jobs/changes?since=<cursor> → { jobs, cursor, activeCount }
 *
 * What the app polls instead of receiving pushes. Pass back the `cursor` from
 * the previous answer. The cursor sits a few seconds in the past, so a change
 * committed just as it was taken is not missed; that means a change can be
 * reported twice, and callers treat a repeat as a no-op.
 */
export const changes = userRoute(async (req, res, user) => {
  const since = req.query?.since ? new Date(String(req.query.since)) : null
  if (since && Number.isNaN(since.getTime())) throw badRequest('since is not a valid time.')

  const { cursor } = await one(`select now() - interval '5 seconds' as cursor`)
  const jobs = since
    ? await many(
        `select ${JOB_COLUMNS} from generation_jobs
          where user_id = $1 and updated_at > $2
          order by updated_at asc
          limit 200`,
        [user.id, since],
      )
    : []
  const { count } = await one(
    'select count(*)::int as count from generation_jobs where user_id = $1 and state = any($2::text[])',
    [user.id, ACTIVE_STATES],
  )

  noStore(res)
  res.json({ jobs, cursor, activeCount: count })
}, { tag: '[jobs/changes]', message: 'Unable to check the queue.' })

/**
 * GET /api/jobs/sync?taskId= → { status, job }
 *
 * Ask KIE about a task and record the answer. `status` is KIE's answer,
 * normalised; `job` is the row after it was applied, or null when the task has
 * no row. Works for an unrecorded task too, so a screen can keep watching a job
 * whose row could not be written.
 */
export const sync = userRoute(async (req, res, user) => {
  const taskId = taskIdFrom(req.query?.taskId)
  if (!taskId) throw badRequest('taskId is required.')
  // Shares the generation proxy's per-user allowance: both spend KIE requests.
  enforceLimit(rateLimit, `user:${user.id}`, 'Too many requests. Please wait a moment and try again.')

  const status = await fetchKieTaskStatus(taskId)
  const job = status.state === 'ratelimited' || status.state === 'unknown'
    ? await one(`select ${JOB_COLUMNS} from generation_jobs where user_id = $1 and kie_task_id = $2`, [user.id, taskId])
    : (await applyKieStatus({ userId: user.id, taskId, status })).job

  noStore(res)
  res.json({ status, job })
}, { tag: '[jobs/sync]', message: 'Unable to check this generation. Please try again.' })

/**
 * POST /api/jobs/register  { entries: [{ taskId, influencerId?, kind?, label?, model? }] } → { jobs }
 *
 * Called the moment KIE accepts a task. Registering the same task again changes
 * nothing — it does not reset a job that has already moved on.
 */
export const register = userRoute(async (req, res, user) => {
  const entries = req.body?.entries
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 20) {
    throw badRequest('entries must be a list of 1 to 20 jobs.')
  }

  const rows = entries.map(e => {
    const taskId = taskIdFrom(e?.taskId)
    if (!taskId) throw badRequest('Every job needs a taskId.')
    const influencerId = e?.influencerId ?? null
    if (influencerId !== null && !isUuid(influencerId)) throw badRequest('influencerId is not valid.')
    const kind = e?.kind ?? 'image'
    if (!ASSET_KINDS.includes(kind)) throw badRequest('kind is not valid.')
    return { taskId, influencerId, kind, label: text(e?.label, 120) || 'Generation', model: text(e?.model, 200) }
  })

  const influencerIds = [...new Set(rows.map(r => r.influencerId).filter(Boolean))]
  if (influencerIds.length) {
    const { n } = await one(
      'select count(*)::int as n from influencers where user_id = $1 and id = any($2::uuid[])',
      [user.id, influencerIds],
    )
    if (n !== influencerIds.length) throw forbidden('This influencer belongs to another account.')
  }

  const params = [user.id]
  const values = rows.map(r => {
    params.push(r.influencerId, r.taskId, r.kind, r.label, r.model)
    const i = params.length
    return `($1, $${i - 4}::uuid, $${i - 3}, $${i - 2}::asset_kind, $${i - 1}, $${i})`
  })
  await query(
    `insert into generation_jobs (user_id, influencer_id, kie_task_id, kind, label, model)
     values ${values.join(', ')}
     on conflict (user_id, kie_task_id) do nothing`,
    params,
  )

  const jobs = await many(
    `select ${JOB_COLUMNS} from generation_jobs where user_id = $1 and kie_task_id = any($2::text[])`,
    [user.id, rows.map(r => r.taskId)],
  )
  res.status(201).json({ jobs })
}, { tag: '[jobs/register]', message: 'Unable to record the generation.' })

/** POST /api/jobs/remove  { id } → 204 */
export const remove = userRoute(async (req, res, user) => {
  const { id } = req.body || {}
  if (!isUuid(id)) throw badRequest('id is required.')
  await query('delete from generation_jobs where id = $1 and user_id = $2', [id, user.id])
  res.status(204).end()
}, { tag: '[jobs/remove]', message: 'Unable to remove this item. Please try again.' })

/**
 * POST /api/jobs/clear-settled → 204
 *
 * Clears everything finished with. A finished result that has not been saved
 * and has not expired stays: its row is the only way anything — the Queue or
 * the worker — can still collect it.
 */
export const clearSettled = userRoute(async (req, res, user) => {
  await query(
    `delete from generation_jobs
      where user_id = $1
        and state <> all($2::text[])
        and (
             state <> 'success'
          or asset_id is not null
          or result_url is null
          or coalesce(completed_at, updated_at) < now() - $3::int * interval '1 hour'
        )`,
    [user.id, ACTIVE_STATES, RESULT_TTL_HOURS],
  )
  res.status(204).end()
}, { tag: '[jobs/clear-settled]', message: 'Unable to clear the queue. Please try again.' })
