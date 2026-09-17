/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Client configuration.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Everything the client is allowed to know, in one place, read through
 * `process.env` on BOTH platforms:
 *
 *   • Expo inlines EXPO_PUBLIC_* at build time.
 *   • Vite has no process.env, so vite.config.js `define`s these same three
 *     names from the server-side .env. That is why core reads EXPO_PUBLIC_*
 *     even in the browser — one accessor, no platform fork, no `import.meta`
 *     (which Metro cannot parse).
 *
 * ── What may and may not appear here ─────────────────────────────────────────
 *
 * The Supabase anon key BELONGS in a client bundle. It is not a secret: it only
 * says "I am a browser talking to this project", and every table is protected
 * by Row Level Security, so the key alone grants nothing. Supabase publishes it
 * on purpose.
 *
 * The Supabase SERVICE ROLE key must never appear here — it bypasses RLS
 * entirely. Nor may the KIE key, the OpenAI key, or any AWS credential. Those
 * live on the server and are reached through /api. The app previously shipped
 * the KIE key inside the bundle; that is what the backend proxy replaces.
 */

/** Supabase project URL, e.g. https://abcdefgh.supabase.co */
export const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL || ''

/** Public anon key. Safe to ship — see the note above. */
export const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || ''

/**
 * Absolute base URL of our own API (the Vercel deployment).
 *
 * The browser can use a relative path because it is served from the same
 * origin; React Native has no origin to resolve against, so a native build
 * must have this set or every /api call fails.
 */
export const API_BASE = process.env.EXPO_PUBLIC_API_BASE || ''

/**
 * Where a password-reset email should land the user.
 *
 * Supabase requires the exact URL to be allow-listed in the dashboard, and it
 * differs per platform: the web app uses an https route, the native app a deep
 * link on the `aiinfluencer` scheme registered in app.json.
 */
export const PASSWORD_RESET_REDIRECT =
  process.env.EXPO_PUBLIC_PASSWORD_RESET_REDIRECT || ''

/**
 * Where a sign-up confirmation email lands the user — its own screen, not the
 * reset-password one it used to share. Must also be allow-listed in Supabase →
 * Authentication → URL Configuration → Redirect URLs.
 *
 * Defaults to the app's deep link, so a build missing the variable (an EAS
 * build without it, say) still sends people back into the app rather than to
 * Supabase's placeholder site URL.
 */
export const EMAIL_CONFIRM_REDIRECT =
  process.env.EXPO_PUBLIC_EMAIL_CONFIRM_REDIRECT || 'aiinfluencer://confirm-email'

export function isSupabaseConfigured() {
  return SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0
}

/**
 * A single, readable failure instead of a stack trace from deep inside the
 * Supabase client. Misconfiguration is the most likely first-run problem, so
 * it is worth naming the exact variables.
 */
export function assertSupabaseConfigured() {
  if (isSupabaseConfigured()) return
  throw new Error(
    'Supabase is not configured. Set EXPO_PUBLIC_SUPABASE_URL and ' +
    'EXPO_PUBLIC_SUPABASE_ANON_KEY in mobile/.env (native) or SUPABASE_URL / ' +
    'SUPABASE_ANON_KEY in the root .env (web), then restart the dev server.',
  )
}
