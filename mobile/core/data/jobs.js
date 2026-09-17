/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The generation queue, in the database.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * KIE is asynchronous and slow, and its result URLs expire in 24 hours, so the
 * taskId is the only durable handle to work already paid for. It used to live
 * in device storage, which meant a job was invisible from any other device and
 * gone with the install. It is a row now, so a video started on a phone can be
 * collected from a laptop.
 *
 * ── Push, not poll ───────────────────────────────────────────────────────────
 *
 * The tab badge previously re-read local storage every three seconds. Doing
 * that against a database would be a request every three seconds per client,
 * forever, mostly returning nothing new.
 *
 * Instead `subscribe()` opens a Realtime channel filtered to this user's rows,
 * and Postgres pushes changes as they happen. The UI is more responsive AND
 * quieter. Something still has to ask KIE whether a task has finished — that is
 * the sync loop, which writes the answer here; every screen then learns about
 * it through this one channel.
 *
 * The pure predicates below are deliberately synchronous: they are used inside
 * render, where awaiting is not an option.
 */

import { supabase, requireUserId } from '../supabase'
import { dbError } from '../errors'

/** KIE's own vocabulary for "still working". */
export const ACTIVE_STATES = ['waiting', 'queuing', 'generating']

/** KIE's retention window for a finished result. */
export const RESULT_TTL_MS = 24 * 60 * 60 * 1000

const COLUMNS = `
  id, influencer_id, kie_task_id, kind, label, model,
  state, result_url, asset_id, fail_msg,
  created_at, updated_at, completed_at
`

function toApp(row) {
  return {
    id: row.id,
    influencerId: row.influencer_id,
    taskId: row.kie_task_id,
    kind: row.kind,
    label: row.label,
    model: row.model,
    state: row.state,
    resultUrl: row.result_url,
    assetId: row.asset_id,
    failMsg: row.fail_msg,
    createdAt: new Date(row.created_at).getTime(),
    completedAt: row.completed_at ? new Date(row.completed_at).getTime() : null,
  }
}

export function isActive(job) {
  return ACTIVE_STATES.includes(job?.state)
}

/**
 * Finished on KIE's side, bytes not yet in our own storage.
 *
 * Requires the result URL: a collected job whose file was later deleted also
 * has no asset, but there is nothing left to collect — offering Save there
 * only produced an error.
 */
export function isCollectable(job) {
  return job?.state === 'success' && !job?.assetId && !!job?.resultUrl && !isExpired(job)
}

/** Finished, never collected, and past the point where KIE still serves it. */
export function isExpired(job) {
  if (job?.state !== 'success' || job?.assetId || !job?.resultUrl) return false
  return Date.now() - (job.completedAt || job.createdAt || 0) > RESULT_TTL_MS
}

/** Collected once, and the stored file has since been deleted. */
export function isDeleted(job) {
  return job?.state === 'success' && !job?.assetId && !job?.resultUrl
}

/**
 * Every job for the signed-in user, newest first.
 * RLS scopes this; no user filter is needed or wanted.
 */
export async function listJobs({ limit = 60 } = {}) {
  const { data, error } = await supabase
    .from('generation_jobs')
    .select(COLUMNS)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw dbError('load the queue', error)
  return (data || []).map(toApp)
}

/** One job by its KIE task id, or null. RLS scopes it to the signed-in user. */
export async function getJobByTaskId(taskId) {
  if (!taskId) return null

  const { data, error } = await supabase
    .from('generation_jobs')
    .select(COLUMNS)
    .eq('kie_task_id', taskId)
    .maybeSingle()

  if (error) throw dbError('check that job', error)
  return data ? toApp(data) : null
}

/**
 * Whether any of this influencer's jobs is still running.
 *
 * The generator downloads a job's reference images when the job STARTS, which
 * can be minutes after it was queued, so a file can be deleted only once nothing
 * running might still need it. Fails safe: when the answer is unknown it says
 * yes, because the question is always "is it safe to delete?".
 */
export async function hasActiveJobs(influencerId) {
  if (!influencerId) return false
  const { count, error } = await supabase
    .from('generation_jobs')
    .select('id', { count: 'exact', head: true })
    .in('state', ACTIVE_STATES)
    .eq('influencer_id', influencerId)

  if (error) { console.warn('[jobs] active check failed:', error.message); return true }
  return (count ?? 0) > 0
}

export async function countActive() {
  const { count, error } = await supabase
    .from('generation_jobs')
    .select('id', { count: 'exact', head: true })
    .in('state', ACTIVE_STATES)

  if (error) { console.warn('[jobs] count failed:', error.message); return 0 }
  return count ?? 0
}

/**
 * Record jobs the moment their taskIds exist — before any polling starts.
 *
 * From that instant KIE is doing paid work, so it must be recoverable even if
 * the app dies a second later. `upsert` on (user_id, kie_task_id) makes a retry
 * idempotent rather than producing a duplicate row.
 */
export async function registerJobs(entries) {
  const userId = await requireUserId()

  const rows = (entries || [])
    .filter(e => e?.taskId)
    .map(e => ({
      user_id: userId,
      influencer_id: e.influencerId || null,
      kie_task_id: e.taskId,
      kind: e.kind || 'image',
      label: e.label || 'Generation',
      model: e.model || null,
      state: 'waiting',
    }))

  if (!rows.length) return []

  const { data, error } = await supabase
    .from('generation_jobs')
    .upsert(rows, { onConflict: 'user_id,kie_task_id' })
    .select(COLUMNS)

  if (error) throw dbError('record the job', error)
  return (data || []).map(toApp)
}

/**
 * Fold a KIE recordInfo answer into the row that owns that taskId.
 *
 * Skips the write when nothing changed. The foreground poll runs every few
 * seconds while a user watches a progress bar; rewriting "generating" over
 * itself would be a database round trip per tick and would fire a Realtime
 * event to every one of that user's devices for no reason.
 */
export async function applyStatus(taskId, status) {
  const { data: existing, error: readError } = await supabase
    .from('generation_jobs')
    .select('id, state, asset_id')
    .eq('kie_task_id', taskId)
    .maybeSingle()

  if (readError) { console.warn('[jobs] status read failed:', readError.message); return null }
  if (!existing) return null
  if (existing.state === status.state) return null

  // A job that has finished, or whose result is stored, is final. Several things
  // poll the same job, and a late answer used to write the generator's link back
  // onto a job the server had already collected and cleared — after which
  // deleting the result let the worker collect it again, and it came back.
  if (!ACTIVE_STATES.includes(existing.state) || existing.asset_id) return null

  const patch = { state: status.state }
  if (status.state === 'success') {
    patch.result_url = status.resultUrls?.[0] ?? null
    patch.completed_at = status.completeTime ? new Date(status.completeTime).toISOString() : new Date().toISOString()
  }
  if (status.state === 'fail') {
    patch.fail_msg = status.failMsg || 'Generation failed'
    patch.completed_at = new Date().toISOString()
  }

  const { data, error } = await supabase
    .from('generation_jobs')
    .update(patch)
    .eq('id', existing.id)
    // Only while still running: another poller may have settled it since the read.
    .in('state', ACTIVE_STATES)
    .select(COLUMNS)
    .maybeSingle()

  if (error) { console.warn('[jobs] status update failed:', error.message); return null }
  return data ? toApp(data) : null
}

/**
 * Mark a job's bytes as safely in our own storage.
 *
 * The server already does this as part of /api/storage/ingest, matching the
 * row by its result URL, so screens do not need to call it. It remains for a
 * caller that holds the taskId and wants the row updated regardless.
 */
export async function markCollected(taskId, assetId) {
  const { data, error } = await supabase
    .from('generation_jobs')
    .update({ state: 'success', asset_id: assetId, result_url: null })
    .eq('kie_task_id', taskId)
    .select(COLUMNS)
    .maybeSingle()

  if (error) { console.warn('[jobs] collect failed:', error.message); return null }
  return data ? toApp(data) : null
}

export async function removeJob(id) {
  const { error } = await supabase.from('generation_jobs').delete().eq('id', id)
  if (error) throw dbError('remove that job', error)
}

/**
 * Clear everything finished with. Anything still running stays, and so does a
 * finished result that has not been saved yet and has not expired: deleting its
 * row would leave nothing — not the Queue, not the worker — able to collect it,
 * and it was already paid for.
 */
export async function clearSettled() {
  const expiredBefore = new Date(Date.now() - RESULT_TTL_MS).toISOString()
  const { error } = await supabase
    .from('generation_jobs')
    .delete()
    .not('state', 'in', `(${ACTIVE_STATES.join(',')})`)
    .or(`state.neq.success,asset_id.not.is.null,result_url.is.null,completed_at.lt."${expiredBefore}"`)

  if (error) throw dbError('clear the queue', error)
}

/** Makes every subscription's channel topic unique — see subscribe(). */
let channelSeq = 0

/**
 * Listen for changes to this user's jobs.
 *
 * The filter is belt and braces: RLS already prevents another user's rows from
 * reaching this channel, but stating the filter keeps the subscription narrow
 * and makes the intent obvious to anyone reading it.
 *
 * ── Why every call gets its own channel ──────────────────────────────────────
 *
 * Several things listen at once — the tab badge, the Queue screen, the create
 * wizard waiting on a slow job. realtime-js hands back the EXISTING channel when
 * a topic is reused, and adding a postgres_changes listener to a channel that
 * is already subscribed throws. With one shared topic the badge subscribed
 * first and opening the Queue tab crashed the app; removing either listener
 * would also have torn the channel down under the other. A per-call suffix
 * keeps them independent.
 *
 * @param {(payload: object) => void} handler
 * @returns {() => void} unsubscribe
 */
export function subscribe(userId, handler) {
  if (!userId) return () => {}

  channelSeq += 1
  const channel = supabase
    .channel(`generation_jobs:${userId}:${channelSeq}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'generation_jobs', filter: `user_id=eq.${userId}` },
      payload => handler(payload),
    )
    .subscribe()

  return () => { supabase.removeChannel(channel) }
}
