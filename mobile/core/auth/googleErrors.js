/**
 * What a failed Google sign-in means, in words a person can use.
 *
 * Google's sign-in library fails in a handful of ways, each with a status code in a string, and most
 * are not the person's fault: they closed the account picker (not an error at all), the phone has no
 * Google Play services, the network dropped, or this build is not registered with Google.
 *
 * The last one is the one a developer meets: Google answers DEVELOPER_ERROR (10) when the app's package
 * name + signing certificate are not among the Android client IDs in Google Cloud Console. The most common
 * cause is an app installed from Google Play, which signs it with its own key (that key's SHA-1 has to be
 * registered too). People are told something plain; the log gets the cause.
 *
 * Pure: the library's own codes are passed in (`codes`, its `statusCodes`), so this runs and is tested
 * without it.
 */

/** `code` on the error the app throws when the person closes the Google account picker. Not shown. */
export const GOOGLE_CANCELLED = 'GOOGLE_CANCELLED'

/** `code` on every other Google failure the app throws; the message is for the person. */
export const GOOGLE_FAILED = 'GOOGLE_FAILED'

/** Google's own numbers for the two it does not name in the library's statusCodes (Android). */
const NETWORK_ERROR = '7'
const DEVELOPER_ERROR = '10'

/**
 * @param {unknown} error   what the library threw
 * @param {{SIGN_IN_CANCELLED?: string, IN_PROGRESS?: string, PLAY_SERVICES_NOT_AVAILABLE?: string}} [codes]
 *        the library's statusCodes
 * @returns {{cancelled: boolean, code: string, message: string, reason: string}}
 *          `reason` is for the log only
 */
export function explainGoogleError(error, codes = {}) {
  const code = String(error?.code ?? '')
  const text = String(error?.message ?? error ?? '')

  if ((codes.SIGN_IN_CANCELLED && code === codes.SIGN_IN_CANCELLED) || code === '12501') {
    return { cancelled: true, code: GOOGLE_CANCELLED, message: '', reason: 'closed by the person' }
  }
  if ((codes.IN_PROGRESS && code === codes.IN_PROGRESS) || code === '12502') {
    return { cancelled: true, code: GOOGLE_CANCELLED, message: '', reason: 'already in progress' }
  }
  if ((codes.PLAY_SERVICES_NOT_AVAILABLE && code === codes.PLAY_SERVICES_NOT_AVAILABLE) || /play services/i.test(text)) {
    return {
      cancelled: false, code: GOOGLE_FAILED, reason: 'no Google Play services',
      message: 'Google sign-in needs Google Play services, which this phone does not have or has switched off. Sign in with your email instead.',
    }
  }
  if (code === DEVELOPER_ERROR || /DEVELOPER_ERROR/.test(text)) {
    return {
      cancelled: false, code: GOOGLE_FAILED, reason: 'DEVELOPER_ERROR: package + signing key not registered with Google',
      message: 'Google sign-in is not set up correctly for this version of the app. Please sign in with your email, and tell us about it.',
    }
  }
  if (code === NETWORK_ERROR || /network/i.test(text)) {
    return {
      cancelled: false, code: GOOGLE_FAILED, reason: 'network',
      message: 'Could not reach Google. Check your connection and try again.',
    }
  }
  return {
    cancelled: false, code: GOOGLE_FAILED, reason: `unexpected (${code || 'no code'}): ${text.slice(0, 120)}`,
    message: 'Could not sign in with Google. Please try again, or use your email.',
  }
}
