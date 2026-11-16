/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Signing in with Apple — the iPhone.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Asks Apple's own sheet (Face ID / passcode, the Apple Account already on the phone) who the person is and gets
 * back an identity token: a statement, signed by Apple, that this is them. The app does nothing with it but hand
 * it, with the nonce it started with, to our server (core/auth/index.js signInWithApple), which checks the
 * signature and decides what it is worth. No Apple password is ever involved.
 *
 * iPhone only: Apple's native sheet does not exist on Android, so there is no button there and nothing here
 * touches the libraries. They are required inside the function, not at the top: a build made without their native
 * part (an old development build) then only loses the Apple button's work instead of failing to start.
 *
 * The capability: the build needs the "Sign in with Apple" entitlement (app.json: `ios.usesAppleSignIn`), and the
 * App ID at Apple needs the capability switched on; EAS does that while it makes the signing credentials. Without
 * either, Apple answers "unknown failure" (core/auth/appleErrors.js says what the person is told).
 *
 * Nothing secret lives in the app. The server holds the key it needs to REVOKE a person's Apple tokens when they
 * delete their account; the app only hands over the one-time authorization code for that.
 */

import { Platform } from 'react-native'

import { AppError } from '../errors'
import { explainAppleError, APPLE_FAILED } from '../auth/appleErrors'
import { hexOf, appleSignInPayload, NONCE_BYTES } from '../auth/appleCredential'

/** Whether this phone can offer Sign in with Apple: an iPhone (every iOS this app runs on has it). */
export function appleSignInAvailable() {
  return Platform.OS === 'ios'
}

/**
 * Show Apple's sheet and return what the server needs: the identity token, the nonce it was made with,
 * the one-time authorization code, and — only the first time ever — the person's name.
 *
 * @returns {Promise<{idToken: string, nonce: string, authorizationCode: string|null, fullName: {givenName: string|null, familyName: string|null}|null}>}
 * @throws {AppError} code APPLE_CANCELLED (the person closed the sheet: show nothing) or APPLE_FAILED
 */
export async function requestAppleCredential() {
  if (!appleSignInAvailable()) {
    throw new AppError('Signing in with Apple is only available in the iPhone app.', { code: APPLE_FAILED })
  }

  let AppleAuthentication
  let Crypto
  try {
    AppleAuthentication = require('expo-apple-authentication')
    Crypto = require('expo-crypto')
  } catch (e) {
    console.warn('[apple] the sign-in library is not in this build:', e?.message ?? e)
    throw new AppError('Sign in with Apple is not available in this version of the app.', { code: APPLE_FAILED, cause: e })
  }

  try {
    // Apple is given the HASH; the server is given the string. See core/auth/appleCredential.js.
    const rawNonce = hexOf(await Crypto.getRandomBytesAsync(NONCE_BYTES))
    const hashedNonce = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, rawNonce)
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: hashedNonce,
    })
    return appleSignInPayload(credential, rawNonce)
  } catch (e) {
    const explained = explainAppleError(e)
    if (!explained.cancelled) console.warn('[apple] sign-in failed:', explained.reason)
    throw new AppError(explained.message, { code: explained.code, cause: e })
  }
}
