/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Signing in with Apple — WEB (see appleSignIn.native.js for the real thing).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The web build is a reference only. These stand-ins keep the shape of the native file so shared code
 * (core/auth/index.js) can import it without caring which platform it is on: Sign in with Apple is not
 * offered here.
 */

import { AppError } from '../errors'
import { APPLE_FAILED } from '../auth/appleErrors'

export const appleSignInAvailable = () => false

export async function requestAppleCredential() {
  throw new AppError('Signing in with Apple is only available in the iPhone app.', { code: APPLE_FAILED })
}
