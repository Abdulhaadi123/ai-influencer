/**
 * What a failed Sign in with Apple means, in words a person can use.
 *
 * Apple's sheet fails in a handful of ways. The one that is not a failure at all is the person closing it
 * (ERR_REQUEST_CANCELED): that is changing one's mind, and nothing is shown. The rest are mostly not the
 * person's fault: the phone is not signed in to an Apple Account, the network dropped, Apple answered
 * oddly — or this build was made without the Sign in with Apple capability, which Apple reports as an
 * "unknown" failure and which only a developer can fix. People are told something plain; the log gets the cause.
 *
 * Pure: it only reads the error's `code` and `message`, so it runs and is tested without the native module.
 */

/** `code` on the error the app throws when the person closes Apple's sheet. Not shown. */
export const APPLE_CANCELLED = 'APPLE_CANCELLED'

/** `code` on every other Apple failure the app throws; the message is for the person. */
export const APPLE_FAILED = 'APPLE_FAILED'

/**
 * @param {unknown} error   what the native module threw
 * @returns {{cancelled: boolean, code: string, message: string, reason: string}}
 *          `reason` is for the log only
 */
export function explainAppleError(error) {
  const code = String(error?.code ?? '')
  const text = String(error?.message ?? error ?? '')

  if (code === 'ERR_REQUEST_CANCELED' || code === '1001' || /user canceled|user cancelled/i.test(text)) {
    return { cancelled: true, code: APPLE_CANCELLED, message: '', reason: 'closed by the person' }
  }
  if (code === 'ERR_APPLE_AUTHENTICATION_UNAVAILABLE' || /not available|unavailable/i.test(code)) {
    return {
      cancelled: false, code: APPLE_FAILED, reason: 'Sign in with Apple is not available on this device',
      message: 'Sign in with Apple is not available on this iPhone. Please use your email instead.',
    }
  }
  if (code === 'ERR_REQUEST_FAILED' || /network|connection/i.test(text)) {
    return {
      cancelled: false, code: APPLE_FAILED, reason: `Apple could not be reached or refused (${code || 'no code'})`,
      message: 'Could not reach Apple. Check your connection and try again.',
    }
  }
  if (code === 'ERR_REQUEST_NOT_INTERACTIVE' || code === 'ERR_REQUEST_NOT_HANDLED') {
    return {
      cancelled: false, code: APPLE_FAILED, reason: `the request was not shown or not handled (${code})`,
      message: 'Sign in with Apple could not open. Please try again, or use your email.',
    }
  }
  if (code === 'ERR_REQUEST_UNKNOWN' || code === '1000') {
    return {
      cancelled: false, code: APPLE_FAILED, reason: 'unknown failure: no Apple Account on the phone, or this build lacks the Sign in with Apple capability',
      message: 'Sign in with Apple did not work. Check that this iPhone is signed in to an Apple Account in Settings, or use your email instead.',
    }
  }
  return {
    cancelled: false, code: APPLE_FAILED, reason: `unexpected (${code || 'no code'}): ${text.slice(0, 120)}`,
    message: 'Could not sign in with Apple. Please try again, or use your email.',
  }
}
