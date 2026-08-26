// ── KIE.AI engine status ─────────────────────────────────────────────────────
// Reports whether the configured KIE key works, so the UI can show it.
// Where the key lives depends on the platform: on mobile it is bundled from
// EXPO_PUBLIC_KIE_API_KEY, on web it stays server-side behind the /api/kie
// proxy. Either way, users never log in — one account's credits serve everyone.

import { kieFetch } from '../platform/kieTransport'
import * as storage from '../platform/storage'

const KIE_CONNECTED_KEY = 'kie_connected'

// Called once at app start to confirm the backend key is configured.
// Lightweight, read-only credit check — costs no credits.
//
// Goes through the platform transport: direct to api.kie.ai on mobile, via the
// /api/kie proxy on web.
export async function checkKieConnection() {
  try {
    const res = await kieFetch('/api/v1/chat/credit')
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
