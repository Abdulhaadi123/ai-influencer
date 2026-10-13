/**
 * The shared credits state (core/data/billing.js), as a hook.
 *
 * `visible` says whether the app should bring credits up at all — see creditsVisible.
 */

import { useSyncExternalStore } from 'react'

import { getCredits, subscribeCredits } from '@core/data/billing'
import { creditsVisible } from '@core/billing/packs'

export function useCredits() {
  const state = useSyncExternalStore(subscribeCredits, getCredits)
  return { ...state, visible: creditsVisible(state, __DEV__) }
}
