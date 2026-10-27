/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Signing in with Google — the phone.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Asks Google's own account picker who the person is and gets back an ID token: a statement, signed by
 * Google, that this is them. The app does nothing with it but hand it to our server (core/auth/index.js
 * signInWithGoogle), which checks the signature and decides what it is worth. No Google password or
 * access to the person's Google data is ever involved: the app asks for the basic profile and nothing else.
 *
 * `webClientId` is the Web application client ID from Google Cloud Console, not the Android one: it is
 * what makes Google address the token to OUR SERVER (its `aud`), which is the only reader that matters.
 * The Android client — package name plus the signing key's SHA-1 — is how Google recognises the app
 * itself; it never appears in the code. Settings that are wrong there make Google answer DEVELOPER_ERROR
 * (core/auth/googleErrors.js says what the person is told).
 *
 * The library is required inside the functions, not at the top: a build made without its native part
 * (an old development build) then only loses the Google button's work instead of failing to start.
 */

import { AppError, NETWORK_MESSAGE } from '../errors'
import { GOOGLE_WEB_CLIENT_ID, GOOGLE_DEV_TOKEN_URL } from '../config/env'
import { explainGoogleError, GOOGLE_CANCELLED, GOOGLE_FAILED } from '../auth/googleErrors'

/** Whether this build can offer Google sign-in: it was given the Web client ID (or the development stand-in). */
export function googleSignInAvailable() {
  return GOOGLE_WEB_CLIENT_ID !== '' || GOOGLE_DEV_TOKEN_URL !== ''
}

let configured = false
function sdk() {
  const lib = require('@react-native-google-signin/google-signin')
  if (!configured) {
    // Only the basic profile (name, email, id): the token is the point, not any access to the person's Google.
    lib.GoogleSignin.configure({ webClientId: GOOGLE_WEB_CLIENT_ID, scopes: ['profile', 'email'] })
    configured = true
  }
  return lib
}

/** The failure as the app's own error: silent when the person closed the picker, a plain message otherwise. */
function failure(error, codes) {
  const explained = explainGoogleError(error, codes)
  if (!explained.cancelled) console.warn('[google] sign-in failed:', explained.reason)
  return new AppError(explained.message, { code: explained.code, cause: error })
}

/**
 * Show Google's account picker and return the ID token of the account chosen.
 * @returns {Promise<string>}
 * @throws {AppError} code GOOGLE_CANCELLED (the person closed the picker: show nothing) or GOOGLE_FAILED
 */
export async function requestGoogleIdToken() {
  if (GOOGLE_DEV_TOKEN_URL) {
    // Development only: a local test server hands out a token, in place of the picker (core/config/env.js).
    try {
      const res = await fetch(GOOGLE_DEV_TOKEN_URL)
      const body = await res.json()
      if (!res.ok || typeof body?.idToken !== 'string') throw new Error(`the test token server answered ${res.status}`)
      return body.idToken
    } catch (e) {
      throw new AppError(e?.message === 'Network request failed' ? NETWORK_MESSAGE : 'The development token server did not answer.', { code: GOOGLE_FAILED, cause: e })
    }
  }

  let lib
  try {
    lib = sdk()
  } catch (e) {
    console.warn('[google] the sign-in library is not in this build:', e?.message ?? e)
    throw new AppError('Google sign-in is not available in this version of the app.', { code: GOOGLE_FAILED, cause: e })
  }
  const { GoogleSignin, isSuccessResponse, statusCodes } = lib

  try {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true })
    const response = await GoogleSignin.signIn()
    if (!isSuccessResponse(response)) throw new AppError('', { code: GOOGLE_CANCELLED })
    const idToken = response.data?.idToken
    if (!idToken) throw new Error('Google returned no ID token (is the Web client ID right?)')
    return idToken
  } catch (e) {
    if (e?.code === GOOGLE_CANCELLED) throw e
    throw failure(e, statusCodes)
  }
}

/**
 * Forget the Google account on this phone, so the next "Continue with Google" shows the picker again
 * instead of quietly reusing it. Best effort: signing out of the app must not wait on it.
 */
export async function signOutOfGoogle() {
  if (GOOGLE_DEV_TOKEN_URL) return
  try {
    await sdk().GoogleSignin.signOut()
  } catch (e) {
    // Not signed in to Google here, or the library is not in this build: nothing to forget.
  }
}
