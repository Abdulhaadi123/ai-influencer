/**
 * Admin — the overview: numbers, usage, the audit log, and how the server is set up.
 *
 *   GET /api/admin/stats
 *   GET /api/admin/usage?days=30
 *   GET /api/admin/audit?page=
 *   GET /api/admin/config
 */

import { many, one } from '../_lib/db.js'
import { adminRoute, pageOf, likeTerm, queryText } from '../_lib/admin.js'
import { noStore } from '../_lib/http.js'
import { moderationConfig } from '../_lib/moderation/config.js'
import { nsfwCheckerEnabled } from '../_lib/moderation/kieFilters.js'
import { webhooksConfigured } from '../kie-callback.js'
import { billingEnforced } from '../_lib/billing.js'
import { STORE_PROBLEM } from './billing.js'
import { revenueCatConfigured } from '../revenuecat-webhook.js'

const n = value => Number(value) || 0

export const stats = adminRoute(async (_req, res) => {
  const users = await one(
    `select count(*)::int as total,
            count(*) filter (where status = 'suspended')::int as suspended,
            count(*) filter (where created_at > now() - interval '7 days')::int as new_7d
       from users`,
  )
  const jobs = await one(
    `select count(*) filter (where state in ('waiting', 'queuing', 'generating'))::int as running,
            count(*) filter (where created_at > now() - interval '24 hours')::int as started_24h,
            count(*) filter (where state = 'fail' and created_at > now() - interval '24 hours')::int as failed_24h,
            coalesce(sum(kie_credits) filter (where completed_at > now() - interval '24 hours'), 0) as credits_24h,
            coalesce(sum(kie_credits) filter (where completed_at > now() - interval '7 days'), 0) as credits_7d,
            coalesce(sum(kie_credits) filter (where completed_at > now() - interval '30 days'), 0) as credits_30d,
            count(*) filter (where state in ('success', 'fail') and kie_credits is null
                              and completed_at > now() - interval '30 days')::int as uncharged_unknown
       from generation_jobs`,
  )
  const moderation = await one(
    `select count(*) filter (where status = 'open')::int as open,
            count(*) filter (where status = 'open' and action = 'blocked')::int as open_blocked,
            count(*) filter (where created_at > now() - interval '24 hours')::int as events_24h
       from moderation_events`,
  )
  // Models real jobs have used that nobody has priced: something to look at. A row for one MODE of a model
  // (`kling-3.0/motion-control:720p`) prices that model, exactly as it does on the Prices page.
  const { unpriced } = await one(
    `select count(distinct j.model)::int as unpriced
       from generation_jobs j
      where j.model is not null and j.model <> ''
        and not exists (
              select 1 from model_prices p
               where p.model = j.model
                  or left(p.model, length(j.model) + 1) = j.model || ':'
            )`,
  )
  // Store deliveries that did NOT turn into credits and should have: a purchase from nobody we know, a
  // product we do not sell, or a test purchase while those are switched off. Someone paid; look into it.
  const { problems } = await one(
    `select count(*)::int as problems from billing_events e
      where e.received_at > now() - interval '30 days' and ${STORE_PROBLEM}`,
  )

  noStore(res)
  res.json({
    users,
    jobs: {
      running: jobs.running,
      started24h: jobs.started_24h,
      failed24h: jobs.failed_24h,
      credits24h: n(jobs.credits_24h),
      credits7d: n(jobs.credits_7d),
      credits30d: n(jobs.credits_30d),
      // Settled jobs KIE gave no `creditsConsumed` for — the totals above leave them out.
      chargeUnknown30d: jobs.uncharged_unknown,
    },
    moderation: { open: moderation.open, openBlocked: moderation.open_blocked, events24h: moderation.events_24h },
    unpricedModels: unpriced,
    billingProblems30d: problems,
  })
}, { tag: '[admin/stats]', message: 'Unable to load the overview.' })

/**
 * Jobs, failures and KIE credits per day and model — what the platform is costing.
 *
 * `days` is whole UTC calendar days ending today (today included), which is what the
 * chart draws. A rolling "now minus N days" window would also take in part of the day
 * before the chart's first column, and the by-model totals would then not add up to it.
 */
export const usage = adminRoute(async (req, res) => {
  const days = Math.min(90, Math.max(1, Math.floor(Number(req.query?.days)) || 30))
  const rows = await many(
    `select to_char(date_trunc('day', completed_at at time zone 'UTC'), 'YYYY-MM-DD') as day,
            coalesce(model, '(unknown)') as model,
            count(*) filter (where state = 'success')::int as succeeded,
            count(*) filter (where state = 'fail')::int as failed,
            coalesce(sum(kie_credits), 0) as credits
       from generation_jobs
      where state in ('success', 'fail')
        and completed_at >= (date_trunc('day', now() at time zone 'UTC') - ($1::int - 1) * interval '1 day') at time zone 'UTC'
      group by 1, 2
      order by 1 desc, credits desc, 2`,
    [days],
  )
  noStore(res)
  res.json({
    days,
    rows: rows.map(r => ({ day: r.day, model: r.model, succeeded: r.succeeded, failed: r.failed, credits: n(r.credits) })),
  })
}, { tag: '[admin/usage]', message: 'Unable to load usage.' })

/**
 * `?action=user.` narrows to one family of actions (a prefix); `?admin=` searches
 * by the admin's email. Both are optional and forgiving — see queryText.
 */
export const auditLog = adminRoute(async (req, res) => {
  const { page, pageSize, limit, offset } = pageOf(req)
  const action = queryText(req.query?.action, 60)
  const admin = queryText(req.query?.admin, 100)
  const args = [action === null ? null : likeTerm(action), admin === null ? null : likeTerm(admin)]
  const filter = `($1::text is null or action like $1 || '%' escape '\\') and ($2::text is null or admin_email ilike '%' || $2 || '%' escape '\\')`

  const rows = await many(
    `select id, admin_email, action, target_type, target_id, details, created_at
       from admin_audit_log where ${filter} order by created_at desc, id desc limit $3 offset $4`,
    [...args, limit, offset],
  )
  const { total } = await one(`select count(*)::int as total from admin_audit_log where ${filter}`, args)
  noStore(res)
  res.json({
    entries: rows.map(r => ({
      id: String(r.id),
      admin: r.admin_email,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      details: r.details,
      at: r.created_at,
    })),
    total, page, pageSize,
  })
}, { tag: '[admin/audit]', message: 'Unable to load the audit log.' })

/** How the server is set up, so "why is nothing being checked?" has an answer. Never includes a secret. */
export const config = adminRoute(async (_req, res) => {
  const m = moderationConfig()
  noStore(res)
  res.json({
    moderation: {
      enabled: m.enabled,
      checkerConfigured: m.configured,
      failMode: m.failClosed ? 'closed' : 'open',
      model: m.model,
      strikeLimit: m.strikeLimit,
      strikeWindowDays: m.strikeWindowDays,
      suspendOnMinors: m.suspendOnMinors,
      videoFrames: m.videoFrames,
      thresholds: m.rules,
      thresholdsProblem: m.thresholdsProblem,
    },
    kie: { callbacksConfigured: webhooksConfigured(), nsfwChecker: nsfwCheckerEnabled() },
    billing: {
      enforced: billingEnforced(),
      webhookConfigured: revenueCatConfigured(),
      acceptSandbox: String(process.env.REVENUECAT_ACCEPT_SANDBOX ?? 'true').toLowerCase() !== 'false',
    },
  })
}, { tag: '[admin/config]', message: 'Unable to load the configuration.' })
