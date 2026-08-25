/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Platform capability: app lifecycle — WEB implementation.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Core code must never call `window` / `location` directly. Anything that needs
 * to restart the app goes through here, so the React Native build can supply an
 * equivalent (Metro resolves `app.native.js` ahead of this file automatically).
 */

/**
 * Restart the app so freshly-written store data is re-read from scratch.
 *
 * Used after seeding writes influencers straight to storage, bypassing React
 * state. On React Native the equivalent is Expo Updates' `reloadAsync()`.
 */
export function reloadApp() {
  if (typeof window !== 'undefined' && window.location) {
    window.location.reload()
  }
}
