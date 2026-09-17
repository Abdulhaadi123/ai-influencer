/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Sessions — how a signed-in device proves who it is.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Signing in gives the app two random tokens:
 *
 *   access token   sent with every API call; expires after an hour
 *   refresh token  exchanged for a fresh pair when the access token expires;
 *                  lasts 30 days from its last use
 *
 * Both are 256 random bits and are stored only as SHA-256 hashes, so a copy of
 * the database contains no usable token. They are checked against the database
 * on every call rather than being self-contained signed tokens — which means
 * signing out, "sign out everywhere", a password change and account deletion
 * take effect on the very next request, not an hour later.
 *
 * ── Rotation and replay ──────────────────────────────────────────────────────
 *
 * Every refresh replaces BOTH tokens and remembers the refresh token it
 * replaced. If that old token is used again after the real app has moved on, a
 * copy of it exists somewhere else — so the session is ended for everyone
 * holding it. The real user signs in again; whoever copied it cannot.
 *
 * A short grace period covers the one innocent case: the app sent a refresh,
 * the server rotated, and the answer never arrived (the app was killed, the
 * connection dropped), so the app retries with the token it still has.
 */

import { createHash, randomBytes } from 'node:crypto'

import { query, transaction } from './db.js'

export const ACCESS_TTL_SECONDS = Number(process.env.ACCESS_TOKEN_TTL_SECONDS || 60 * 60)
export const REFRESH_TTL_SECONDS = Number(process.env.REFRESH_TOKEN_TTL_SECONDS || 30 * 24 * 60 * 60)

/** How long a just-replaced refresh token may still be used — see the header. */
const REUSE_GRACE_SECONDS = 30

/** A session last-used time older than this is updated; newer is left alone. */
const LAST_USED_RESOLUTION_MS = 5 * 60 * 1000

export function newToken() {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex')
}

/** What the app is told about a user. Never includes the password hash. */
export function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name ?? null,
    emailConfirmed: !!row.email_confirmed_at,
  }
}

function issued(user, accessToken, refreshToken) {
  return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS, user: publicUser(user) }
}

const trimAgent = userAgent => (userAgent ? String(userAgent).slice(0, 200) : null)

/**
 * Sign a user in on a new device.
 * @param {{id, email, display_name, email_confirmed_at}} user  a users row
 */
export async function createSession(user, { userAgent = null } = {}) {
  const accessToken = newToken()
  const refreshToken = newToken()
  await query(
    `insert into sessions (user_id, access_hash, access_expires_at, refresh_hash, refresh_expires_at, user_agent)
     values ($1, $2, now() + $3::int * interval '1 second', $4, now() + $5::int * interval '1 second', $6)`,
    [user.id, hashToken(accessToken), ACCESS_TTL_SECONDS, hashToken(refreshToken), REFRESH_TTL_SECONDS, trimAgent(userAgent)],
  )
  return issued(user, accessToken, refreshToken)
}

/**
 * The signed-in user for an access token, or null when it is unknown, expired
 * or revoked.
 *
 * @returns {Promise<{id, email, displayName, emailConfirmed, sessionId} | null>}
 */
export async function findSessionByAccessToken(accessToken) {
  const { rows } = await query(
    `select s.id as session_id, s.last_used_at, u.id, u.email, u.display_name, u.email_confirmed_at
       from sessions s
       join users u on u.id = s.user_id
      where s.access_hash = $1 and s.access_expires_at > now()`,
    [hashToken(accessToken)],
  )
  const row = rows[0]
  if (!row) return null

  // Worth knowing ("signed in on 3 devices, last used…"), not worth a write per call.
  if (Date.now() - new Date(row.last_used_at).getTime() > LAST_USED_RESOLUTION_MS) {
    query('update sessions set last_used_at = now() where id = $1', [row.session_id])
      .catch(e => console.warn('[sessions] could not record last use:', e.message))
  }

  return { ...publicUser(row), sessionId: row.session_id }
}

/**
 * Exchange a refresh token for a new pair.
 *
 * @returns {Promise<object|null>} the new session, or null when the token is
 *          not valid — which also covers a replay caught after the grace period,
 *          where the session is ended as well
 */
export async function refreshSession(refreshToken, { userAgent = null } = {}) {
  if (typeof refreshToken !== 'string' || !refreshToken || refreshToken.length > 200) return null
  const presented = hashToken(refreshToken)

  return transaction(async client => {
    let { rows } = await client.query(
      `select s.id, s.user_id, u.email, u.display_name, u.email_confirmed_at
         from sessions s
         join users u on u.id = s.user_id
        where s.refresh_hash = $1 and s.refresh_expires_at > now()
          for update of s`,
      [presented],
    )
    let session = rows[0]

    if (!session) {
      ;({ rows } = await client.query(
        `select s.id, s.user_id, u.email, u.display_name, u.email_confirmed_at,
                s.rotated_at > now() - $2::int * interval '1 second' as within_grace
           from sessions s
           join users u on u.id = s.user_id
          where s.previous_refresh_hash = $1 and s.refresh_expires_at > now()
            for update of s`,
        [presented, REUSE_GRACE_SECONDS],
      ))
      const replayed = rows[0]
      if (!replayed) return null

      if (!replayed.within_grace) {
        await client.query('delete from sessions where id = $1', [replayed.id])
        console.warn(`[sessions] an old refresh token was reused; session ${replayed.id} ended`)
        return null
      }
      session = replayed
    }

    const accessToken = newToken()
    const nextRefreshToken = newToken()
    await client.query(
      `update sessions
          set access_hash           = $2,
              access_expires_at     = now() + $3::int * interval '1 second',
              previous_refresh_hash = refresh_hash,
              refresh_hash          = $4,
              refresh_expires_at    = now() + $5::int * interval '1 second',
              rotated_at            = now(),
              last_used_at          = now(),
              user_agent            = coalesce($6, user_agent)
        where id = $1`,
      [session.id, hashToken(accessToken), ACCESS_TTL_SECONDS, hashToken(nextRefreshToken), REFRESH_TTL_SECONDS, trimAgent(userAgent)],
    )

    return issued(
      { id: session.user_id, email: session.email, display_name: session.display_name, email_confirmed_at: session.email_confirmed_at },
      accessToken,
      nextRefreshToken,
    )
  })
}

/** Sign out the one device holding either token. */
export async function revokeSession({ accessToken = null, refreshToken = null }) {
  if (accessToken) await query('delete from sessions where access_hash = $1', [hashToken(accessToken)])
  if (refreshToken) {
    const h = hashToken(refreshToken)
    await query('delete from sessions where refresh_hash = $1 or previous_refresh_hash = $1', [h])
  }
}

/**
 * Sign a user out everywhere — optionally except the session making the request.
 * @param {object} [opts.client]  a transaction client, to make this part of one
 */
export async function revokeAllSessions(userId, { exceptSessionId = null, client = null } = {}) {
  const run = client ? (text, params) => client.query(text, params) : query
  await run(
    'delete from sessions where user_id = $1 and ($2::uuid is null or id <> $2::uuid)',
    [userId, exceptSessionId],
  )
}
