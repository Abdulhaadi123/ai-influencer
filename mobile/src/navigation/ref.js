/**
 * The navigation container's handle, for code that has no screen of its own.
 *
 * Kept in its own file so the places that need it (the "not enough credits" alert in
 * src/hooks/useBilling.js) can import it without importing the navigator, which imports
 * every screen — a loop waiting to happen.
 */

import { createNavigationContainerRef } from '@react-navigation/native'

export const navigationRef = createNavigationContainerRef()

/** Open the Credits screen from anywhere, if the app is ready to. */
export function openCredits() {
  if (navigationRef.isReady()) navigationRef.navigate('Credits')
}

/**
 * Open an influencer's Gallery from anywhere — the "Saved to Gallery" toast's button. `at` makes
 * each request a new one, so asking twice for the same gallery still switches the tab back to it.
 */
export function openGallery(influencerId) {
  if (!navigationRef.isReady() || !influencerId) return
  navigationRef.navigate('Influencers', {
    screen: 'InfluencerDetail',
    params: { id: influencerId, tab: 'gallery', at: Date.now() },
  })
}
