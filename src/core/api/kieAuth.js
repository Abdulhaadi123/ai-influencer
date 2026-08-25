// ── KIE.AI Authentication helper ─────────────────────────────────────────────
// The API key is stored SERVER-SIDE in .env (KIE_API_KEY).
// On the client side we only expose a flag so UI can show connection status.
// Users never need to connect/login — the company's key is used for everyone.

import { getApiUrl } from '../platform/apiUrl'
import * as storage from '../platform/storage'

const KIE_CONNECTED_KEY = 'kie_connected'

// Called once at app start to confirm the backend key is configured.
// Lightweight, read-only credit check — costs no credits.
//
// NOTE: the `__kiepath` param is REQUIRED. The proxy reads the upstream path
// from it; without it the request is forwarded to the api.kie.ai root and 404s,
// which would report a perfectly good key as "offline".
export async function checkKieConnection() {
  try {
    const res = await fetch(
      getApiUrl('/api/kie/api/v1/chat/credit?__kiepath=/api/v1/chat/credit'),
      { method: 'GET' }
    )
    if (!res.ok) {
      try { storage.setItem(KIE_CONNECTED_KEY, '0') } catch {}
      return false
    }
    // KIE answers 200 with a body-level code; only code 200 means the key worked.
    const json = await res.json().catch(() => null)
    const connected = json?.code === 200
    try { storage.setItem(KIE_CONNECTED_KEY, connected ? '1' : '0') } catch {}
    return connected
  } catch {
    return false
  }
}

export function isKieConnected() {
  try { return storage.getItem(KIE_CONNECTED_KEY) === '1' } catch { return false }
}
