/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The Supabase client — one instance for the whole app, both platforms.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This is the only place a client is constructed. Two clients would each run
 * their own token-refresh timer against the same session, and the loser of that
 * race signs the user out.
 *
 * Every table is behind Row Level Security keyed on auth.uid(), so this client
 * can only ever see the signed-in user's rows. There is no "admin" path from
 * the app — the service-role key exists only on the server.
 */

import 'react-native-url-polyfill/auto'
import { createClient, isAuthRetryableFetchError } from '@supabase/supabase-js'

import { SUPABASE_URL, SUPABASE_ANON_KEY, isSupabaseConfigured } from './config/env'
import * as authStorage from './platform/authStorage'
import { AppError, ERROR_CODES, NETWORK_MESSAGE, signedOutError } from './errors'

/**
 * Stand-ins used only when the build has no Supabase settings.
 *
 * createClient throws on an empty URL, and it runs while this module loads —
 * before any screen exists — so a build without its settings crashed on launch
 * and the "Not configured" screen (AuthContext → navigation) could never show.
 * `.invalid` is reserved and never resolves, so nothing is ever sent anywhere;
 * AuthContext sees isSupabaseConfigured() false and stops before using this.
 */
const UNCONFIGURED_URL = 'https://unconfigured.invalid'
const UNCONFIGURED_KEY = 'unconfigured'

/**
 * `detectSessionInUrl` is off deliberately.
 *
 * It exists for the browser, where Supabase reads the tokens an email link
 * leaves in the URL fragment. React Native has no such URL, and on web we want
 * to control exactly when a recovery link is consumed (see the reset-password
 * screen) rather than have it swallowed during module import.
 *
 * `flowType: 'pkce'` means the email link carries a short-lived code that is
 * exchanged for a session, instead of the tokens themselves. The code is
 * single-use and bound to this client, so a link leaked from an inbox or a
 * proxy log is far less useful to an attacker.
 */
export const supabase = createClient(SUPABASE_URL || UNCONFIGURED_URL, SUPABASE_ANON_KEY || UNCONFIGURED_KEY, {
  auth: {
    storage: authStorage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    flowType: 'pkce',
    // No `lock` option: auth-js 2.116 coordinates session refreshes itself and
    // deprecates the option, logging a warning on every launch if it is set.
  },
})

export { isSupabaseConfigured }

/**
 * The current access token, or null.
 *
 * Our own /api endpoints authenticate by verifying this JWT, so anything
 * calling them needs it. Read through the client rather than from storage:
 * the client owns refresh, and reading storage directly would hand out a token
 * that expired thirty seconds ago.
 */
export async function getAccessToken() {
  const { data, error } = await supabase.auth.getSession()
  const token = data?.session?.access_token ?? null
  if (token) return token
  // An expired token that could not be refreshed because the connection is down
  // is not a signed-out user. Returning null here signed people out over a weak
  // signal; this throws a network error instead and leaves the session alone.
  if (error && isAuthRetryableFetchError(error)) {
    throw new AppError(NETWORK_MESSAGE, { code: ERROR_CODES.NETWORK, cause: error })
  }
  return null
}

/**
 * The signed-in user's id, for stamping the owner on a write.
 *
 * Read from the session on the device, not from `auth.getUser()`. That one is a
 * network request, and when it failed — a dropped connection, a tunnel — it
 * answered "no user", which every writer treated as signed out: the app signed
 * people out while they typed, and a job KIE had already been paid for was
 * never recorded. The database checks the token on every write regardless, so
 * nothing is trusted that was not already checked.
 *
 * @returns {Promise<string>}
 * @throws {AppError} NETWORK when the session cannot be refreshed right now;
 *         NOT_AUTHENTICATED (and signs out) when there genuinely is no session
 */
export async function requireUserId() {
  const { data, error } = await supabase.auth.getSession()
  const id = data?.session?.user?.id
  if (id) return id
  if (error && isAuthRetryableFetchError(error)) {
    throw new AppError(NETWORK_MESSAGE, { code: ERROR_CODES.NETWORK, cause: error })
  }
  throw signedOutError()
}
