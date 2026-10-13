/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Credits — what the app knows about the account's balance.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * One small store, shared by every screen that shows credits (Settings, Home, the
 * Credits screen), so they cannot disagree. The numbers come from the server
 * (`GET /api/billing/me`) and nowhere else: the app never works out a balance, and a
 * balance it showed is never trusted by the server — the server counts for itself on
 * every request.
 *
 * It is refreshed when it is likely to have changed: on sign-in, when the app comes
 * back to the front, when a job changes (a failed one gives its credits back), after a
 * generation starts, and while waiting for a purchase to arrive.
 */

import { apiFetch } from '../api/client'

/**
 * @typedef {object} CreditsState
 * @property {number|null} balance   null until the first answer
 * @property {boolean} enforced      whether the server is refusing requests for lack of credits yet
 * @property {Array<{model: string, label: string|null, unit: string, credits: number}>} prices
 * @property {Array<{productId: string, credits: number, label: string|null}>} packs
 * @property {boolean} loaded        true once an answer has arrived
 */

/** @type {CreditsState} */
const EMPTY = Object.freeze({ balance: null, enforced: false, prices: [], packs: [], loaded: false })

let state = EMPTY
let inFlight = null
const listeners = new Set()

export const getCredits = () => state

/** For useSyncExternalStore: calls `listener` on every change; returns the unsubscribe. */
export function subscribeCredits(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function set(next) {
  state = next
  for (const listener of [...listeners]) {
    try { listener() } catch (e) { console.warn('[credits] listener failed:', e?.message ?? e) }
  }
}

/**
 * Ask the server. Never rejects: a refresh that fails leaves what was known, and the next
 * trigger tries again. Overlapping calls share one request.
 *
 * @returns {Promise<CreditsState>}
 */
export function refreshCredits() {
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const json = await apiFetch('/api/billing/me')
      const balance = Number(json?.balance)
      set({
        balance: Number.isFinite(balance) ? balance : state.balance,
        enforced: json?.enforced === true,
        prices: Array.isArray(json?.prices) ? json.prices : [],
        packs: Array.isArray(json?.packs) ? json.packs : [],
        loaded: true,
      })
    } catch (e) {
      console.warn('[credits] could not refresh:', e?.message ?? e)
    } finally {
      inFlight = null
    }
    return state
  })()
  return inFlight
}

/** Forget everything — another account is about to be signed in. */
export function resetCredits() {
  inFlight = null
  set(EMPTY)
}

/**
 * Wait for credits to arrive after a purchase. The store confirms the purchase to the
 * app at once, but the credits are added when RevenueCat's webhook reaches the server —
 * usually within seconds, so this asks again every `everyMs` until the balance is above
 * `above`, for at most `timeoutMs`.
 *
 * @returns {Promise<boolean>} whether the balance rose
 */
export async function waitForCredits(above, { timeoutMs = 45_000, everyMs = 2_000, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now } = {}) {
  const end = now() + timeoutMs
  for (;;) {
    await refreshCredits()
    if ((state.balance ?? -Infinity) > above) return true
    if (now() + everyMs > end) return false
    await sleep(everyMs)
  }
}
