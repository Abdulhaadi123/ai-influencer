/**
 * The credit packs the store offers, and buying one — shared by every screen that sells credits
 * (the Credits screen, and the "Get credits" / "Choose a pack" offer).
 *
 * The store confirms a purchase at once, but the credits are added by the SERVER when RevenueCat
 * tells it, so after a purchase this WAITS for the balance to rise (`waitForCredits`) rather than
 * adding anything itself. What a pack is worth comes from the server, what it costs from the store
 * (in the person's own currency) — see core/billing/packs.js.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { useAuth } from '@core/auth/AuthContext'
import { userMessage } from '@core/errors'
import { refreshCredits, waitForCredits } from '@core/data/billing'
import { buyPackage, loadStorePackages, purchasesAvailable, startPurchases, syncPurchases } from '@core/platform/purchases'
import { joinPacks } from '@core/billing/packs'

import { useCredits } from './useCredits'
import { showError } from '../lib/alerts'

/**
 * @returns {{
 *   store: {status: 'loading'|'ready'|'unavailable'|'failed', packages: any[], message: string|null},
 *   packs: ReturnType<typeof joinPacks>,
 *   credits: ReturnType<typeof useCredits>,
 *   buying: string|null, waiting: boolean, busy: boolean,
 *   buy: (pack: any) => Promise<{bought: boolean, arrived: boolean}>,
 *   reload: () => Promise<void>,
 *   refresh: () => Promise<void>,
 * }}
 */
export function usePackStore() {
  const { userId } = useAuth()
  const credits = useCredits()

  /** What the store offers: loading, ready, unavailable (no key in this build) or failed. */
  const [store, setStore] = useState({ status: purchasesAvailable() ? 'loading' : 'unavailable', packages: [], message: null })
  const [buying, setBuying] = useState(null)         // the pack being bought
  const [waiting, setWaiting] = useState(false)      // bought; the credits have not arrived yet

  const reload = useCallback(async () => {
    if (!purchasesAvailable()) { setStore({ status: 'unavailable', packages: [], message: null }); return }
    try {
      await startPurchases(userId)
      setStore({ status: 'ready', packages: await loadStorePackages(), message: null })
    } catch (e) {
      setStore({ status: 'failed', packages: [], message: userMessage(e, 'The credit packs could not be loaded. Please try again.') })
    }
  }, [userId])

  useEffect(() => {
    reload()
    refreshCredits()
  }, [reload])

  const packs = useMemo(() => joinPacks(store.packages, credits.packs), [store.packages, credits.packs])
  const busy = buying !== null || waiting

  /** Buy one. Resolves `{bought, arrived}`; a cancelled or failed purchase is `bought: false`. */
  const buy = useCallback(async pack => {
    if (busy) return { bought: false, arrived: false }
    const before = credits.balance ?? 0
    setBuying(pack.id)
    try {
      const { cancelled } = await buyPackage(pack.native)
      if (cancelled) return { bought: false, arrived: false }
      setBuying(null)
      setWaiting(true)
      const arrived = await waitForCredits(before)
      return { bought: true, arrived }
    } catch (e) {
      showError('Purchase failed', e, 'The purchase could not be completed. Please try again.')
      return { bought: false, arrived: false }
    } finally {
      setBuying(null)
      setWaiting(false)
    }
  }, [busy, credits.balance])

  /** Pull to refresh: a purchase made while the app was closed is re-sent to RevenueCat first, then the balance is read. */
  const refresh = useCallback(async () => {
    await syncPurchases()
    await Promise.all([refreshCredits(), reload()])
  }, [reload])

  return { store, packs, credits, buying, waiting, busy, buy, reload, refresh }
}
