// ── KIE.AI Authentication helper ─────────────────────────────────────────────
// The API key is stored SERVER-SIDE in .env (KIE_API_KEY).
// On the client side we only expose a flag so UI can show connection status.
// Users never need to connect/login — the company's key is used for everyone.

import { getApiUrl } from './apiUrl'

const KIE_CONNECTED_KEY = 'kie_connected'

// Called once at app start to confirm the backend key is configured.
// We do a lightweight credit-check ping; if it succeeds we cache the flag.
export async function checkKieConnection() {
  try {
    const res = await fetch(getApiUrl('/api/kie/api/v1/chat/credit'), { method: 'GET' })
    const connected = res.ok
    try { localStorage.setItem(KIE_CONNECTED_KEY, connected ? '1' : '0') } catch {}
    return connected
  } catch {
    return false
  }
}

export function isKieConnected() {
  try { return localStorage.getItem(KIE_CONNECTED_KEY) === '1' } catch { return false }
}

// ── Legacy stubs so old imports from higgsfieldAuth don't crash ──────────────
// Pages that still reference the old auth functions get these no-ops.
export const isHFConnected           = () => true   // always "connected" — company key
export const startHiggsfieldOAuthPopup = async () => {}  // no-op
export const disconnectHF            = () => {}          // no-op
export const handleOAuthCallback     = async () => {}    // no-op
export const silentRefreshHFToken    = async () => {}    // no-op
export const getHFToken              = () => ''          // unused
export const refreshHFToken          = async () => {}    // unused
