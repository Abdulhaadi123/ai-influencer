/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Signing in with Google — WEB (see googleSignIn.native.js for the real thing).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The web build is a reference only. These stand-ins keep the shape of the native file so shared code
 * (core/auth/index.js) can import it without caring which platform it is on: Google sign-in is not
 * offered here.
 */

import { AppError } from '../errors'
import { GOOGLE_FAILED } from '../auth/googleErrors'

export const googleSignInAvailable = () => false

export async function requestGoogleIdToken() {
  throw new AppError('Signing in with Google is only available in the mobile app.', { code: GOOGLE_FAILED })
}

export async function signOutOfGoogle() {}
