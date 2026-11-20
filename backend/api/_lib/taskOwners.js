/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Who started a generation task (migration 009).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * KIE answers for every task of the studio's one key, so a task id is a bearer secret: whoever knows it
 * could register it as their own job, ask how it is doing and have its result copied into their storage.
 * The proxy records the account that started each task (api/kie.js), and everything that takes a task id
 * from a client — registering a job, syncing one, asking KIE about one — refuses anyone else.
 *
 * A task with no recorded owner (one from before the table existed, that nothing could be backfilled for)
 * is left as it was: refusing it would strand work the account has already paid for.
 *
 * The row also says which KIE key started the task (migration 013), because KIE only answers about a task
 * for that key (api/_lib/kieKeys.js). A task with no key recorded was started with the server's own key.
 */

import { one, many, query } from './db.js'
import { forbidden } from './http.js'

export const TASK_NOT_YOURS_MESSAGE = 'This generation belongs to another account.'

/**
 * Remember that `userId` started `taskId`, with the KIE key `keyId` (null: the server's own).
 * Idempotent; the first account to be recorded keeps it.
 */
export async function recordTaskOwner(userId, taskId, keyId = null) {
  if (!userId || typeof taskId !== 'string' || !taskId) return
  await query(
    'insert into task_owners (kie_task_id, user_id, kie_key_id) values ($1, $2, $3) on conflict (kie_task_id) do nothing',
    [taskId.slice(0, 200), userId, keyId],
  )
}

/** The account that started a task, or null when none is recorded. */
export async function ownerOf(taskId) {
  if (typeof taskId !== 'string' || !taskId) return null
  const row = await one('select user_id from task_owners where kie_task_id = $1', [taskId])
  return row?.user_id ?? null
}

/** Throws 403 TASK_NOT_YOURS if any of these tasks was started by someone other than `userId`. */
export async function assertTasksAreYours(userId, taskIds) {
  const wanted = [...new Set(taskIds.filter(id => typeof id === 'string' && id))]
  if (!wanted.length) return
  const owned = await many('select user_id from task_owners where kie_task_id = any($1::text[]) and user_id <> $2', [wanted, userId])
  if (owned.length) throw forbidden(TASK_NOT_YOURS_MESSAGE, 'TASK_NOT_YOURS')
}
