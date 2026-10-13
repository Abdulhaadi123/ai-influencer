/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Suspending and restoring an account.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Two things trigger a suspension: moderation (a user keeps submitting content
 * the app refuses — api/_lib/moderation/events.js) and an admin. Both end up
 * here so they do exactly the same thing:
 *
 *   • the status flips, with a reason the admin can read later;
 *   • every session is deleted, so every device is signed out on its next call
 *     rather than carrying on until a token expires.
 *
 * Signing in is refused while suspended (auth/account.js), and so is any request
 * that somehow still holds a session (auth.js) — two layers, because a session
 * that outlives a suspension would defeat it.
 *
 * Nothing is deleted. A suspension is reversible; the user's files and
 * influencers wait for them.
 *
 * Both functions take an optional transaction `client`, so an admin action and
 * its audit entry can be one transaction.
 */

import { query, transaction } from './db.js'
import { revokeAllSessions } from './sessions.js'

/**
 * @param {string} userId
 * @param {string} reason  shown to admins, never to the user
 * @param {{client?: {query: Function}}} [opts]
 * @returns {Promise<boolean>} true when this call suspended them; false when they
 *          already were, or do not exist
 */
export async function suspendUser(userId, reason, { client = null } = {}) {
  const work = async c => {
    const { rows } = await c.query(
      `update users
          set status = 'suspended', suspended_at = now(), suspended_reason = $2
        where id = $1 and status = 'active'
        returning id`,
      [userId, String(reason || 'Suspended.').slice(0, 500)],
    )
    if (!rows.length) return false
    await revokeAllSessions(userId, { client: c })
    return true
  }
  return client ? work(client) : transaction(work)
}

/**
 * @param {string} userId
 * @param {{client?: {query: Function}}} [opts]
 * @returns {Promise<boolean>} true when the account was suspended and now is not
 */
export async function unsuspendUser(userId, { client = null } = {}) {
  const sql = `update users
                  set status = 'active', suspended_at = null, suspended_reason = null
                where id = $1 and status = 'suspended'
                returning id`
  const { rows } = await (client ? client.query(sql, [userId]) : query(sql, [userId]))
  return rows.length > 0
}

export const SUSPENDED_MESSAGE = 'Your account has been suspended. Please contact support if you think this is a mistake.'
