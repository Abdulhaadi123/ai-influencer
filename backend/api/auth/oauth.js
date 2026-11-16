/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Signing in with an outside account (Google, and Apple on an iPhone).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   POST /api/auth/oauth  { provider: 'google', idToken }                              → { session, isNewAccount }
 *   POST /api/auth/oauth  { provider: 'apple', idToken, nonce, fullName? }             → { session, isNewAccount }
 *
 * The person signs in to Google (or Apple) on their phone; the app sends us the ID token it was given, and this
 * decides who that is (api/_lib/oauth/google.js and apple.js say whether to believe the token at all). From then
 * on it is an ordinary session — the same tokens, the same rules, the same sign-out — as one from a password.
 *
 * Apple's token comes with the app's random `nonce` (the token holds its hash, so a token taken from anywhere
 * else is useless) and, on the person's very first sign-in only, their name (`fullName`: Apple gives it to the
 * app once and never again, and never inside the token).
 *
 * ── Which account ────────────────────────────────────────────────────────────
 *
 *   1. one that already belongs to this Google/Apple account (the token's `sub`, which never changes);
 *   2. else the account with the same verified email — joined to it, so a person who signed up with a
 *      password and later taps "Continue with Google" gets their own account, not a second one;
 *   3. else a new account, confirmed from the start (the provider has verified the address), with no password.
 *
 * Step 2 has one trap, and it is closed here. Someone can sign up with another person's address and a
 * password they chose, never confirm it, and wait. If the address's real owner then signs in with Google
 * and we simply joined the two, the waiting person would still hold a working password to the account. So
 * an account whose email was never confirmed is TAKEN OVER by the person who has now proved the address:
 * its password is erased, its tokens are spent and its sessions ended, and only then is Google joined to
 * it. An account whose email was confirmed already proved the same thing to us, so it is simply joined
 * and keeps its password.
 *
 * Apple can leave the email out of a token. An account that already exists is found by `sub` and signs in as
 * usual; with no account yet there is nothing to make one from, and the person is told how to let Apple share
 * the address (OAUTH_EMAIL_MISSING). Apple's "Hide My Email" gives a relay address, which is a verified address
 * like any other; it simply never matches an account made with the real one.
 *
 * An administrator's account is never joined or signed in this way: the panel is password-only, and
 * an app sign-in is refused to an administrator exactly as at the password sign-in.
 */

import { transaction } from '../_lib/db.js'
import { clientIp } from '../_lib/auth.js'
import { publicRoute, badRequest, HttpError, noStore, enforceLimit } from '../_lib/http.js'
import { createSession, revokeAllSessions } from '../_lib/sessions.js'
import { createRateLimiter } from '../../lib/rateLimit.js'
import { SUSPENDED_MESSAGE } from '../_lib/suspension.js'
import { displayNameOf } from '../_lib/validate.js'
import {
  verifyGoogleIdToken, googleConfigured, InvalidGoogleTokenError, GoogleUnavailableError,
} from '../_lib/oauth/google.js'
import {
  verifyAppleIdToken, appleConfigured, InvalidAppleTokenError, AppleUnavailableError,
} from '../_lib/oauth/apple.js'

const oauthByIp = createRateLimiter([{ windowMs: 10 * 60_000, max: 30 }])

const ADMIN_ACCOUNT_MESSAGE = 'This is an administrator account. Sign in to the admin panel; the app needs a regular account.'

const EMAIL_MISSING_MESSAGE = 'Apple did not share an email address, and an account needs one. In Settings tap your name, then Sign-In & Security, '
  + 'then Sign in with Apple, choose this app and stop using it; then try again and allow the email.'

/**
 * One entry per way in: how to say its name, whether the server is set up for it, how to check what the app sent,
 * and which errors mean "the token is bad" and "the provider could not be reached".
 */
const PROVIDERS = Object.freeze({
  google: {
    label: 'Google',
    configured: googleConfigured,
    verify: idToken => verifyGoogleIdToken(idToken),
    Invalid: InvalidGoogleTokenError,
    Unavailable: GoogleUnavailableError,
  },
  apple: {
    label: 'Apple',
    configured: appleConfigured,
    verify: (idToken, { nonce }) => verifyAppleIdToken(idToken, nonce),
    Invalid: InvalidAppleTokenError,
    Unavailable: AppleUnavailableError,
  },
})

export const SUPPORTED_PROVIDERS = Object.freeze(Object.keys(PROVIDERS))

/** How a provider is named to a person ("Google", "Apple"); `null` for one we do not know. */
export const providerLabel = provider => PROVIDERS[provider]?.label ?? null

/**
 * Check what the app sent and say who it is — or refuse, with the right words.
 * Also used where an outside sign-in stands in for a password (deleting an account).
 *
 * @param {object} req
 * @param {unknown} provider
 * @param {unknown} idToken
 * @param {{nonce?: unknown}} [extra]  Apple: the random string whose hash the app gave Apple
 * @returns {Promise<{provider: string, subject: string, email: string|null, name: string|null}>}
 */
export async function verifyOauthProof(req, provider, idToken, { nonce = null } = {}) {
  if (typeof provider !== 'string' || !Object.hasOwn(PROVIDERS, provider)) throw badRequest('That way of signing in is not supported.', 'UNSUPPORTED_PROVIDER')
  const way = PROVIDERS[provider]
  if (!way.configured()) throw new HttpError(503, `Signing in with ${way.label} is not available right now.`, 'OAUTH_NOT_CONFIGURED')
  enforceLimit(oauthByIp, `ip:${clientIp(req)}`)
  try {
    return { provider, ...(await way.verify(idToken, { nonce })) }
  } catch (e) {
    if (e instanceof way.Unavailable) throw new HttpError(503, `${way.label} could not be reached. Please try again in a moment.`, 'OAUTH_UNAVAILABLE')
    if (e instanceof way.Invalid) {
      // Why goes to the log; the caller is told nothing that would help forge one.
      console.warn(`[oauth] refused a ${provider} sign-in: ${e.reason}`)
      throw new HttpError(401, `The ${way.label} sign-in could not be verified. Please try again.`, 'OAUTH_TOKEN_INVALID')
    }
    throw e
  }
}

function refuseUnfit(user) {
  if (!user) throw new Error('oauth: the account that should exist is missing')
  if (user.role === 'admin') throw new HttpError(403, ADMIN_ACCOUNT_MESSAGE, 'ADMIN_ACCOUNT')
  if (user.status !== 'active') throw new HttpError(403, SUSPENDED_MESSAGE, 'ACCOUNT_SUSPENDED')
}

/** The name Apple's sheet gave the app (`{ givenName, familyName }`), as one display name; null when there is none. */
function nameFrom(fullName) {
  if (!fullName || typeof fullName !== 'object') return null
  const part = value => (typeof value === 'string' ? value : '')
  return displayNameOf(`${part(fullName.givenName)} ${part(fullName.familyName)}`)
}

/**
 * The account for a verified outside identity, made or joined as the header says. One transaction,
 * with the rows it decides on locked, so two first sign-ins at the same moment make one account.
 *
 * @returns {Promise<{user: object, isNewAccount: boolean, providers: string[]}>}  `providers`: every outside
 *          account joined to it ('apple', 'google'), for the app to say how this account signs in
 */
async function resolveAccount({ provider, subject, email, name }) {
  return transaction(async client => {
    const rows = async (text, params) => (await client.query(text, params)).rows
    const link = userId => client.query(
      `insert into auth_identities (user_id, provider, subject, email) values ($1, $2, $3, $4)
       on conflict (provider, subject) do nothing`,
      [userId, provider, subject, email],
    )
    const done = async (user, isNewAccount) => ({
      user,
      isNewAccount,
      providers: (await rows('select provider from auth_identities where user_id = $1 order by provider', [user.id])).map(r => r.provider),
    })

    // 1. Already theirs.
    let [user] = await rows(
      `select u.* from auth_identities i join users u on u.id = i.user_id
        where i.provider = $1 and i.subject = $2 for update of u`,
      [provider, subject],
    )
    if (user) {
      refuseUnfit(user)
      // `coalesce`: a token that leaves the email out must not erase the one recorded last time.
      await client.query('update auth_identities set last_used_at = now(), email = coalesce($3, email) where provider = $1 and subject = $2', [provider, subject, email])
      return done(user, false)
    }

    // No account for this identity, and (Apple only) no address to make or join one with.
    if (!email) throw new HttpError(422, EMAIL_MISSING_MESSAGE, 'OAUTH_EMAIL_MISSING')

    // 2. The same verified address.
    ;[user] = await rows('select * from users where lower(email) = $1 for update', [email])
    if (user) {
      refuseUnfit(user)
      if (!user.email_confirmed_at) {
        // Never confirmed: whoever chose its password has not proved the address, and this person has.
        ;[user] = await rows(
          `update users set password_hash = null, password_changed_at = now(), email_confirmed_at = now(),
                  display_name = coalesce(display_name, $2)
            where id = $1 returning *`,
          [user.id, name],
        )
        await client.query('delete from email_tokens where user_id = $1', [user.id])
        await revokeAllSessions(user.id, { client })
      }
      await link(user.id)
      return done(user, false)
    }

    // 3. A new account. `on conflict do nothing`: another request may have just made it for the same address.
    ;[user] = await rows(
      `insert into users (email, password_hash, display_name, email_confirmed_at) values ($1, null, $2, now())
       on conflict do nothing returning *`,
      [email, name],
    )
    if (!user) {
      ;[user] = await rows('select * from users where lower(email) = $1', [email])
      refuseUnfit(user)
      await link(user.id)
      return done(user, false)
    }
    await link(user.id)
    return done(user, true)
  })
}

export const oauthSignIn = publicRoute(async (req, res) => {
  const body = req.body || {}
  const identity = await verifyOauthProof(req, body.provider, body.idToken, { nonce: body.nonce })
  // Apple's token never holds the name; the app passes on what Apple's sheet gave it (the first time only).
  if (identity.provider === 'apple') identity.name = nameFrom(body.fullName)
  const { user, isNewAccount, providers } = await resolveAccount(identity)
  // Always an app session: the admin panel signs in with a password only.
  const session = await createSession({ ...user, providers }, { userAgent: req.headers['user-agent'] || null, scope: 'app' })
  noStore(res)
  res.json({ session, isNewAccount })
})
