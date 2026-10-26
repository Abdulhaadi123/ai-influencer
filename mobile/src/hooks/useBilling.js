/**
 * Credits, for as long as someone is signed in.
 *
 * Mounted once, in the signed-in shell (src/navigation/index.js). It:
 *
 *   • tells RevenueCat who is signed in (always OUR account id — see
 *     core/platform/purchases.native.js) so a purchase is credited to the right account;
 *   • loads the balance, and again whenever the app comes back to the front;
 *   • forgets it all on sign-out, so the next person never sees the last one's balance;
 *   • answers "not enough credits" — from whichever screen started the generation — with
 *     ONE dialog that says how many credits are missing and offers the Credits screen, instead
 *     of each screen showing its own red line with nowhere to go.
 */

import { useEffect } from 'react'
import { AppState } from 'react-native'

import { useAuth } from '@core/auth/AuthContext'
import { startPurchases } from '@core/platform/purchases'
import { refreshCredits, resetCredits } from '@core/data/billing'
import { onOutOfCredits } from '@core/billing/outOfCredits'
import { outOfCreditsDialog } from '@core/billing/shortfall'

import { openCredits } from '../navigation/ref'
import { showDialog } from '../lib/dialog'

/** Three images are started at once, and all three are refused: one alert, not three. */
const ALERT_COOLDOWN_MS = 6000
let lastAlertAt = 0

export function useBilling() {
  const { userId } = useAuth()

  useEffect(() => {
    if (!userId) return undefined
    startPurchases(userId)
    refreshCredits()
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') refreshCredits()
    })
    return () => {
      sub.remove()
      resetCredits()
    }
  }, [userId])

  useEffect(() => onOutOfCredits(({ balance, price }) => {
    const now = Date.now()
    if (now - lastAlertAt < ALERT_COOLDOWN_MS) return
    lastAlertAt = now

    // The app's own dialog, with what this needs, what there is and what is missing — not the system box.
    const { title, message, facts } = outOfCreditsDialog({ balance, price })
    showDialog({
      tone: 'warning',
      icon: 'sparkle',
      title,
      message,
      facts,
      dismissable: true,
      actions: [
        { label: 'Get credits', kind: 'primary', onPress: openCredits },
        { label: 'Not now', kind: 'cancel' },
      ],
    })
    refreshCredits()
  }), [])
}
