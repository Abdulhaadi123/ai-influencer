// In-memory rate limiting.
//
// State lives in this process and resets when it restarts. That is enough for
// one API container: it stops a script hammering sign-in or an endpoint, which
// is the case worth stopping. Several API containers would each count
// separately — at that point move this to a shared store (Postgres or Redis).
//
// A refused request is not counted, so waiting out the window always works.

const LONGEST_DEFAULT = 60_000

/**
 * @param {Array<{windowMs: number, max: number}>} rules  all must pass
 * @returns {(key: string) => {ok: true} | {ok: false, retryAfter: number}}
 */
export function createRateLimiter(rules) {
  const hits = new Map() // key -> number[] of recent request timestamps (ms)
  const longest = Math.max(LONGEST_DEFAULT, ...rules.map(r => r.windowMs))

  return function limit(callerKey) {
    const now = Date.now()
    const key = callerKey || 'unknown'
    const times = (hits.get(key) || []).filter(t => now - t < longest)

    for (const rule of rules) {
      const inWindow = times.filter(t => now - t < rule.windowMs)
      if (inWindow.length >= rule.max) {
        hits.set(key, times)
        // Seconds until the oldest hit in this window stops counting.
        const retryAfter = Math.max(1, Math.ceil((rule.windowMs - (now - inWindow[0])) / 1000))
        return { ok: false, retryAfter }
      }
    }

    times.push(now)
    hits.set(key, times)

    // Opportunistic cleanup so the map cannot grow without bound.
    if (hits.size > 5000) {
      for (const [k, v] of hits) {
        if (v.every(t => now - t >= longest)) hits.delete(k)
      }
    }

    return { ok: true }
  }
}

// Generous general-purpose limit for authenticated API use: invisible to a
// person, even one tapping fast, but it trips on a script.
export const rateLimit = createRateLimiter([
  { windowMs: 3000, max: 30 },    // up to 30 requests in any 3 seconds
  { windowMs: 60000, max: 300 },  // up to 300 requests in any 60 seconds
])
