/**
 * ─────────────────────────────────────────────────────────────────────────────
 * "Not enough credits" — told once, from wherever it is discovered.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The server answers a generation request it cannot afford with 402
 * `INSUFFICIENT_CREDITS` (and the balance and price). Several screens start
 * generations and each shows errors its own way — an alert here, a red line there — and
 * none of them can take the person to the place that fixes it.
 *
 * So the generation layer announces it here, once, and the navigation shell — which can
 * open the Credits screen — listens (src/navigation/index.js). Same shape as the "session
 * ended" notice in errors.js, and for the same reason: one place decides what happens.
 */

export const OUT_OF_CREDITS = 'INSUFFICIENT_CREDITS'

const listeners = new Set()

/** @param {(info: {balance: number|null, price: number|null}) => void} listener */
export function onOutOfCredits(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** @param {{balance?: unknown, price?: unknown}} [body]  the server's 402 body */
export function notifyOutOfCredits(body = {}) {
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const info = { balance: num(body?.balance), price: num(body?.price) }
  for (const listener of [...listeners]) {
    try { listener(info) } catch (e) { console.warn('[credits] listener failed:', e?.message ?? e) }
  }
}

/** Whether a failure is the server saying there are not enough credits. */
export function isOutOfCredits(e) {
  return e?.code === OUT_OF_CREDITS
}
