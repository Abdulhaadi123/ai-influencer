/**
 * Shaping what Apple's sheet gives the app into what our server wants (backend api/_lib/oauth/apple.js).
 *
 * Pure, so it runs and is tested without the native module.
 *
 * ── The nonce ────────────────────────────────────────────────────────────────
 *
 * Before asking Apple, the app invents a random string (`rawNonce`) and keeps it. Apple is handed the SHA-256
 * of it, and writes that hash into the identity token. The server is then sent the token AND the string, and
 * checks the hash of the string against the token. A token taken from anywhere else is useless without the
 * string that only this phone holds.
 *
 * ── The name ─────────────────────────────────────────────────────────────────
 *
 * Apple gives the person's name to the app ONCE, on the very first sign-in with this Apple Account, and never
 * again (and never inside the token). So it is passed on to the server the moment it is seen; later sign-ins
 * have none, and the server keeps the one it was given.
 */

/** 32 random bytes = a 64-character hex string: far more than a nonce needs, and what the server expects at least 16 characters of. */
export const NONCE_BYTES = 32

/** Bytes as lower-case hex, two characters each. */
export function hexOf(bytes) {
  let out = ''
  for (const byte of bytes) out += (byte & 0xff).toString(16).padStart(2, '0')
  return out
}

/** A name part as Apple's sheet gave it: some text, or nothing. */
const part = value => (typeof value === 'string' && value.trim() ? value.trim() : null)

/**
 * @param {{identityToken?: string|null, authorizationCode?: string|null, fullName?: {givenName?: string|null, familyName?: string|null}|null}} credential
 *        what `signInAsync` resolved with
 * @param {string} rawNonce  the random string whose SHA-256 was given to Apple
 * @returns {{idToken: string, nonce: string, authorizationCode: string|null, fullName: {givenName: string|null, familyName: string|null}|null}}
 * @throws {Error} when Apple returned no identity token
 */
export function appleSignInPayload(credential, rawNonce) {
  const idToken = credential?.identityToken
  if (typeof idToken !== 'string' || !idToken) throw new Error('Apple returned no identity token')
  const givenName = part(credential.fullName?.givenName)
  const familyName = part(credential.fullName?.familyName)
  return {
    idToken,
    nonce: rawNonce,
    // One-time, short-lived: the server trades it for Apple's tokens only when an account is being deleted.
    authorizationCode: typeof credential.authorizationCode === 'string' && credential.authorizationCode ? credential.authorizationCode : null,
    fullName: givenName || familyName ? { givenName, familyName } : null,
  }
}
