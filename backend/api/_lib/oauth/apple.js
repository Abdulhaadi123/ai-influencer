/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Sign in with Apple: checking it, and ending it.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The iPhone asks Apple to sign the person in and gets back an identity token: a signed statement, made by
 * Apple, of who they are. The app sends it here; this file decides whether to believe it. It is the same
 * job as api/_lib/oauth/google.js, with two differences that come from how Apple works.
 *
 * ── What is believed ─────────────────────────────────────────────────────────
 *
 * A token is believed only if ALL of these hold:
 *
 *   • its signature is Apple's: checked against Apple's published public keys (fetched, cached and rotated
 *     by jose), with the algorithm pinned to RS256 so a token cannot pick a weaker one;
 *   • it was issued by Apple (`iss`);
 *   • it was issued FOR THIS APP (`aud` is one of our own client ids, APPLE_CLIENT_IDS: for an iPhone app,
 *     its bundle id). A token Apple made for some other app is a real token and still not ours to accept;
 *   • it has not expired (`exp`);
 *   • it carries the NONCE this sign-in was started with (see below);
 *   • if it names an email address, Apple says the address is verified (`email_verified`), because the
 *     email is what joins this sign-in to an existing account.
 *
 * What comes out is the person's stable id at Apple (`sub`: it never changes, and it is per developer team, so
 * it is the same on every one of our apps), and their email if there is one. Nothing else in the token is used.
 * Apple gives the person's NAME only to the app, once, on the very first sign-in, and never inside the token:
 * the app sends it separately and api/auth/oauth.js decides what to do with it.
 *
 * ── The nonce ────────────────────────────────────────────────────────────────
 *
 * Before asking Apple, the app invents a random string and keeps it, and hands Apple the SHA-256 of it (hex).
 * Apple writes that value into the token as `nonce`. The app then sends us the token AND the random string, and
 * we check that the hash of the string is what is in the token. A token lifted from somewhere else (a log, a
 * proxy, another sign-in) is useless without the string only the phone that asked for it holds.
 *
 * ── The email can be missing, and it can be a relay ──────────────────────────
 *
 * A person may hide their address ("Hide My Email"): Apple then gives an address of its own that forwards to the
 * real one (…@privaterelay.appleid.com). That is a verified address like any other and is used as it is. It will
 * not match an existing account made with the real address, so that person gets a new account: no way is
 * offered to prove they are the same person, and none is guessed. Apple can also leave the email out of a token
 * altogether; the account is then found by `sub`, and a person with no account yet is told what to do
 * (api/auth/oauth.js).
 *
 * ── Ending it (account deletion) ─────────────────────────────────────────────
 *
 * The App Store requires an app that offers Sign in with Apple to REVOKE the person's Apple tokens when it
 * deletes their account (guideline 5.1.1(v)). That is the one thing here that needs a secret of ours: a private
 * key made for Sign in with Apple, which signs a short-lived client secret. revokeAppleSignIn() trades the
 * one-time authorization code the app got at a fresh sign-in for Apple's tokens, then revokes them. It is best
 * effort and never throws: a person must always be able to delete their account, key or no key, Apple up or down.
 *
 *   APPLE_CLIENT_IDS    our client ids, comma-separated, the app's bundle id FIRST (the one used to revoke)
 *   APPLE_TEAM_ID       the 10-character team id (Membership in the Apple Developer account)
 *   APPLE_KEY_ID        the id of the Sign in with Apple key
 *   APPLE_PRIVATE_KEY   that key's .p8 file, contents as they are (new lines may be written as \n)
 *
 * Nothing here talks to Apple except the key fetch and the two revocation calls. APPLE_JWKS_URL and
 * APPLE_AUTH_BASE_URL exist only so tests can stand in for Apple; production leaves them unset.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify, SignJWT, importPKCS8, errors as joseErrors } from 'jose'

import { normalizeEmail } from '../validate.js'

const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys'
const APPLE_ISSUER = 'https://appleid.apple.com'
const APPLE_AUTH_BASE_URL = 'https://appleid.apple.com'

/** A real identity token is about 1 KB. Anything longer than this is not one. */
const MAX_TOKEN_LENGTH = 4096

/** The phone's own random string is 64 hex characters; a short one carries too little to be a secret. */
const MIN_NONCE_LENGTH = 16
const MAX_NONCE_LENGTH = 256

/** How long Apple is given to answer a revocation call before the deletion goes on without it. */
const REVOKE_TIMEOUT_MS = 8000

/** Our own client ids, from the server's settings. The first is the iPhone app's bundle id. */
export function appleAudiences() {
  return String(process.env.APPLE_CLIENT_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

export const appleConfigured = () => appleAudiences().length > 0

/** The token is not acceptable (forged, expired, made for another app, wrong nonce, not a token). */
export class InvalidAppleTokenError extends Error {
  constructor(reason) {
    super('The Apple sign-in could not be verified.')
    this.name = 'InvalidAppleTokenError'
    /** For the server's log only: never sent to the caller. */
    this.reason = reason
  }
}

/** Apple's keys could not be fetched, so nothing could be checked: the caller may try again. */
export class AppleUnavailableError extends Error {
  constructor() {
    super('Apple could not be reached to check the sign-in.')
    this.name = 'AppleUnavailableError'
  }
}

// One key set per address, kept for the life of the process: jose caches the keys and refetches on a
// key id it has not seen (Apple rotates its keys now and then).
const keySets = new Map()
function keysFor(url) {
  if (!keySets.has(url)) keySets.set(url, createRemoteJWKSet(new URL(url), { timeoutDuration: 5000, cooldownDuration: 30_000 }))
  return keySets.get(url)
}

/** What the app hands Apple, and what Apple puts in the token as `nonce`: the SHA-256 of the app's own random string, in hex. */
export function nonceClaimFor(rawNonce) {
  return createHash('sha256').update(String(rawNonce)).digest('hex')
}

function nonceMatches(rawNonce, claim) {
  if (typeof rawNonce !== 'string' || rawNonce.length < MIN_NONCE_LENGTH || rawNonce.length > MAX_NONCE_LENGTH) return false
  if (typeof claim !== 'string') return false
  const expected = Buffer.from(nonceClaimFor(rawNonce))
  const given = Buffer.from(claim.toLowerCase())
  return expected.length === given.length && timingSafeEqual(expected, given)
}

/**
 * @param {unknown} idToken   the identity token the iPhone got from Apple
 * @param {unknown} rawNonce  the random string whose hash the app gave Apple
 * @returns {Promise<{subject: string, email: string|null, name: null}>}
 * @throws {InvalidAppleTokenError | AppleUnavailableError}
 */
export async function verifyAppleIdToken(idToken, rawNonce) {
  if (typeof idToken !== 'string' || !idToken || idToken.length > MAX_TOKEN_LENGTH) throw new InvalidAppleTokenError('not a token')
  const audience = appleAudiences()
  if (!audience.length) throw new InvalidAppleTokenError('no client ids configured')

  let payload
  try {
    ;({ payload } = await jwtVerify(idToken, keysFor(process.env.APPLE_JWKS_URL || APPLE_JWKS_URL), {
      issuer: APPLE_ISSUER,
      audience,
      algorithms: ['RS256'],
      clockTolerance: 30,
    }))
  } catch (e) {
    // jose's errors say the TOKEN is wrong (expired, bad signature, wrong audience, unknown key…), except
    // the ones about getting Apple's keys: a timeout, or an answer from Apple that was not the keys (jose
    // reports that one as a generic error). Anything that is not a jose error at all (the network failed) is
    // the same: the keys were not there to check against, so nothing can be said of the token.
    if (e instanceof joseErrors.JWKSTimeout) throw new AppleUnavailableError()
    if (e instanceof joseErrors.JOSEError && e.code !== 'ERR_JOSE_GENERIC') throw new InvalidAppleTokenError(e.code)
    throw new AppleUnavailableError()
  }

  if (!nonceMatches(rawNonce, payload.nonce)) throw new InvalidAppleTokenError('nonce missing or not the one this sign-in started with')

  const subject = typeof payload.sub === 'string' ? payload.sub : ''
  if (!subject || subject.length > 255) throw new InvalidAppleTokenError('no subject')

  let email = null
  if (payload.email !== undefined && payload.email !== null && payload.email !== '') {
    if (!(payload.email_verified === true || payload.email_verified === 'true')) throw new InvalidAppleTokenError('email not verified')
    email = normalizeEmail(payload.email)
    if (!email || !email.includes('@')) throw new InvalidAppleTokenError('no usable email')
  }

  return { subject, email, name: null }
}

// ── Revoking, when an account is deleted ─────────────────────────────────────

/** Whether the server holds what it takes to revoke: the team, the key, its private half, and the app's client id. */
export function appleRevocationConfigured() {
  return Boolean(process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID && process.env.APPLE_PRIVATE_KEY && appleAudiences().length)
}

/** The secret Apple wants in place of a password: a JWT signed (ES256) with our Sign in with Apple key, good for five minutes. */
async function clientSecret(clientId) {
  const pem = String(process.env.APPLE_PRIVATE_KEY).replace(/\\n/g, '\n')
  const key = await importPKCS8(pem, 'ES256')
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: process.env.APPLE_KEY_ID })
    .setIssuer(process.env.APPLE_TEAM_ID)
    .setIssuedAt()
    .setExpirationTime('5m')
    .setAudience(APPLE_ISSUER)
    .setSubject(clientId)
    .sign(key)
}

function postToApple(path, fields) {
  const base = String(process.env.APPLE_AUTH_BASE_URL || APPLE_AUTH_BASE_URL).replace(/\/+$/, '')
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
  })
}

/**
 * Revoke the person's Sign in with Apple authorization, using the one-time code the app received at a FRESH sign-in.
 * Never throws and never blocks a deletion for long; the answer says what happened, for the log.
 *
 * @param {unknown} authorizationCode
 * @returns {Promise<{revoked: boolean, reason?: string}>}
 */
export async function revokeAppleSignIn(authorizationCode) {
  if (!appleRevocationConfigured()) return { revoked: false, reason: 'not configured (APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY)' }
  if (typeof authorizationCode !== 'string' || !authorizationCode || authorizationCode.length > 2048) {
    return { revoked: false, reason: 'the app sent no authorization code' }
  }
  try {
    const clientId = appleAudiences()[0]
    const secret = await clientSecret(clientId)

    // 1. The code buys Apple's tokens for this person and this app. It works once, for a few minutes.
    const exchanged = await postToApple('/auth/token', {
      client_id: clientId, client_secret: secret, code: authorizationCode, grant_type: 'authorization_code',
    })
    if (!exchanged.ok) return { revoked: false, reason: `Apple refused the authorization code (${exchanged.status})` }
    const tokens = await exchanged.json().catch(() => null)
    const refresh = typeof tokens?.refresh_token === 'string' && tokens.refresh_token ? tokens.refresh_token : null
    const token = refresh || (typeof tokens?.access_token === 'string' ? tokens.access_token : null)
    if (!token) return { revoked: false, reason: 'Apple gave no token to revoke' }

    // 2. Revoking the refresh token ends the person's link between this app and their Apple account.
    const revoked = await postToApple('/auth/revoke', {
      client_id: clientId, client_secret: secret, token, token_type_hint: refresh ? 'refresh_token' : 'access_token',
    })
    return revoked.ok ? { revoked: true } : { revoked: false, reason: `Apple refused the revocation (${revoked.status})` }
  } catch (e) {
    // Never the key, never the code: just what went wrong.
    return { revoked: false, reason: `the revocation could not be made (${e?.name || 'error'}: ${String(e?.message || e).slice(0, 120)})` }
  }
}
