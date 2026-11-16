/**
 * How an account signs in, as a choice and as words. Pure, so it is tested without a phone.
 *
 * An account made with Google or Apple has no password (backend migration 012). When it asks to be deleted it proves
 * itself the way it signed in — a fresh sign-in with that same provider — and Settings names the provider.
 * The server says which outside accounts are joined to the signed-in one (`user.providers`: 'apple', 'google'),
 * and it may be both. What the phone can actually show decides between two: Apple's sheet exists only on an
 * iPhone, and Google's picker is not offered there (core/platform/googleSignIn.native.js).
 */

/**
 * @param {{hasPassword: boolean, providers?: string[]|null, appleAvailable?: boolean}} account
 * @returns {'password'|'apple'|'google'}  what the person is asked for to confirm a deletion
 */
export function confirmMethod({ hasPassword, providers, appleAvailable = false }) {
  if (hasPassword) return 'password'
  const list = Array.isArray(providers) ? providers : []
  const apple = list.includes('apple')
  const google = list.includes('google')
  if (apple && google) return appleAvailable ? 'apple' : 'google'
  if (apple) return 'apple'
  if (google) return 'google'
  // Not known (a session kept by an older version of the app, before the server said): on an iPhone the only
  // account without a password is one made with Apple; anywhere else it was Google, as it always was.
  return appleAvailable ? 'apple' : 'google'
}

/** The provider as a person reads it. */
export function methodLabel(method) {
  if (method === 'apple') return 'Apple'
  if (method === 'google') return 'Google'
  return null
}

/**
 * What to add to "that email and password is not right" when this phone can sign in another way: an account made
 * with Google or Apple has no password, and the server answers it exactly as it answers a wrong one (it must not say
 * which addresses exist), so the hint is general, not about this address.
 *
 * @returns {string} empty, or a sentence starting with a space
 */
export function socialHint({ googleAvailable = false, appleAvailable = false }) {
  if (googleAvailable && appleAvailable) return ' Made your account with Google or Apple? Use the buttons below.'
  if (googleAvailable) return ' Made your account with Google? Use Continue with Google below.'
  if (appleAvailable) return ' Made your account with Apple? Use Continue with Apple below.'
  return ''
}
