/**
 * The pack offer, opened once.
 *
 * Mounted in the signed-in shell beside useBilling (src/navigation/index.js). When the server has
 * said the account holds no credits — and credits matter in this build, and it can sell them — it
 * opens the "Get credits" screen. It does so ONCE per install: the flag is a device preference, like
 * the theme, and is set before the screen opens so that a crash or a swipe away cannot bring it back.
 *
 * WHEN is core/billing/offer.js (shouldOfferPacks, with tests); this only reads the facts and acts.
 */

import { useEffect } from 'react'
import { useNavigation } from '@react-navigation/native'

import * as storage from '@core/platform/storage'
import { purchasesAvailable } from '@core/platform/purchases'
import { OFFER_SEEN_KEY, shouldOfferPacks } from '@core/billing/offer'

import { useCredits } from './useCredits'

/** A flag that cannot be read counts as "seen": better no offer than one at every launch. */
function seenBefore() {
  try { return storage.getItem(OFFER_SEEN_KEY) === 'true' } catch { return true }
}

export function useOfferPacks() {
  const navigation = useNavigation()
  const { loaded, visible, balance } = useCredits()

  useEffect(() => {
    if (!shouldOfferPacks({ loaded, visible, available: purchasesAvailable(), balance, seen: seenBefore() })) return
    // If it cannot be remembered it cannot be offered once, so it is not offered.
    try { storage.setItem(OFFER_SEEN_KEY, 'true') } catch { return }
    navigation.navigate('GetCredits')
  }, [loaded, visible, balance, navigation])
}
