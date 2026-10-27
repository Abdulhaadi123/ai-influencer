/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Checking a Google sign-in.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The app asks Google to sign the person in and gets back an ID token: a signed statement, made by
 * Google, of who they are. The phone sends it here; this file decides whether to believe it.
 *
 * A token is believed only if ALL of these hold:
 *
 *   • its signature is Google's: checked against Google's published public keys (fetched, cached and
 *     rotated by jose), with the algorithm pinned to RS256 so a token cannot pick a weaker one;
 *   • it was issued by Google (`iss`);
 *   • it was issued FOR THIS APP (`aud` is one of our own client IDs, GOOGLE_CLIENT_IDS) — a token that
 *     Google made for some other app is a real token and still not ours to accept;
 *   • it has not expired (`exp`);
 *   • Google says the email is verified (`email_verified`), because the email is what joins this
 *     sign-in to an existing account — an unverified address would let anyone claim someone else's.
 *
 * What comes out is the person's stable id at Google (`sub`: never changes, unlike the email), their
 * email and their name. Nothing else in the token is used.
 *
 * Nothing here talks to Google except the key fetch. GOOGLE_JWKS_URL exists only so tests can stand in
 * for it; production leaves it unset.
 */

import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose'

import { normalizeEmail, displayNameOf } from '../validate.js'

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

/** A real ID token is about 1 KB. Anything longer than this is not one. */
const MAX_TOKEN_LENGTH = 4096

/** Our own client IDs, from the server's settings: the Web client ID (the one the app passes as its server client). */
export function googleAudiences() {
  return String(process.env.GOOGLE_CLIENT_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

export const googleConfigured = () => googleAudiences().length > 0

/** The token is not acceptable (forged, expired, made for another app, email not verified, not a token). */
export class InvalidGoogleTokenError extends Error {
  constructor(reason) {
    super('The Google sign-in could not be verified.')
    this.name = 'InvalidGoogleTokenError'
    /** For the server's log only: never sent to the caller. */
    this.reason = reason
  }
}

/** Google's keys could not be fetched, so nothing could be checked: the caller may try again. */
export class GoogleUnavailableError extends Error {
  constructor() {
    super('Google could not be reached to check the sign-in.')
    this.name = 'GoogleUnavailableError'
  }
}

// One key set per address, kept for the life of the process: jose caches the keys and refetches on a
// key id it has not seen (Google rotates its keys every few days).
const keySets = new Map()
function keysFor(url) {
  if (!keySets.has(url)) keySets.set(url, createRemoteJWKSet(new URL(url), { timeoutDuration: 5000, cooldownDuration: 30_000 }))
  return keySets.get(url)
}

/**
 * @param {unknown} idToken
 * @returns {Promise<{subject: string, email: string, name: string|null}>}
 * @throws {InvalidGoogleTokenError | GoogleUnavailableError}
 */
export async function verifyGoogleIdToken(idToken) {
  if (typeof idToken !== 'string' || !idToken || idToken.length > MAX_TOKEN_LENGTH) throw new InvalidGoogleTokenError('not a token')
  const audience = googleAudiences()
  if (!audience.length) throw new InvalidGoogleTokenError('no client ids configured')

  let payload
  try {
    ;({ payload } = await jwtVerify(idToken, keysFor(process.env.GOOGLE_JWKS_URL || GOOGLE_JWKS_URL), {
      issuer: GOOGLE_ISSUERS,
      audience,
      algorithms: ['RS256'],
      clockTolerance: 30,
    }))
  } catch (e) {
    // jose's errors say the TOKEN is wrong (expired, bad signature, wrong audience, unknown key…), except
    // the ones about getting Google's keys: a timeout, or an answer from Google that was not the keys
    // (jose reports that one as a generic error). Anything that is not a jose error at all (the network
    // failed) is the same: the keys were not there to check against, so nothing can be said of the token.
    if (e instanceof joseErrors.JWKSTimeout) throw new GoogleUnavailableError()
    if (e instanceof joseErrors.JOSEError && e.code !== 'ERR_JOSE_GENERIC') throw new InvalidGoogleTokenError(e.code)
    throw new GoogleUnavailableError()
  }

  const subject = typeof payload.sub === 'string' ? payload.sub : ''
  if (!subject || subject.length > 255) throw new InvalidGoogleTokenError('no subject')
  if (!(payload.email_verified === true || payload.email_verified === 'true')) throw new InvalidGoogleTokenError('email not verified')
  const email = normalizeEmail(payload.email)
  if (!email || !email.includes('@')) throw new InvalidGoogleTokenError('no email')

  return { subject, email, name: displayNameOf(payload.name) }
}
