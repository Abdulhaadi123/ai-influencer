// ── Generation engine status ─────────────────────────────────────────────────
//
// Reports whether generation is currently working, so Settings can show it.
//
// The client no longer holds an API key — the request goes through our
// authenticated proxy, which attaches the server-side key. So this checks three
// things at once without distinguishing between them: the user is signed in,
// our API is reachable, and the upstream key is valid.
//
// The result used to be cached in device storage under `kie_connected`. It is
// not any more: a cached "connected" is stale the moment the key is rotated or
// the credits run out, and the check is one cheap request.

import { kieFetch } from '../platform/kieTransport'
import { generatorMessage, userMessage } from '../errors'

/**
 * Lightweight, read-only credit check that also says WHY generation is down.
 * "Engine offline" on its own sends someone hunting; "the server is not set up
 * yet" or "check your connection" tells them where to look. Costs no credits.
 *
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
export async function checkEngine() {
  try {
    const res = await kieFetch('/api/v1/chat/credit')
    if (!res.ok) {
      // Our own API's refusal already carries a sentence; the generator's does not.
      if (res.error && (typeof res.error.code === 'string' || !res.status)) {
        return { ok: false, reason: userMessage(res.error, 'The server could not check the generator.') }
      }
      const body = await res.json().catch(() => null)
      return { ok: false, reason: generatorMessage(body?.code ?? res.status) }
    }
    // KIE answers 200 with a body-level code; only code 200 means it worked.
    const json = await res.json().catch(() => null)
    return json?.code === 200
      ? { ok: true, reason: null }
      : { ok: false, reason: generatorMessage(json?.code ?? 'unknown') }
  } catch (e) {
    return { ok: false, reason: userMessage(e, 'The generator could not be checked.') }
  }
}

/** The yes/no form, for callers that only need that. */
export async function checkKieConnection() {
  return (await checkEngine()).ok
}
