/**
 * The one "Saved to Gallery" notice board of the app, and the hooks that read it.
 *
 * The rules are core/notices/galleryNotice.js; this is the single instance of it the screens share:
 *   • GalleryToastHost feeds it the store's announcements and draws its toast;
 *   • an influencer's screen tells it which gallery is open (so nothing is announced about a
 *     gallery the person is looking at) and reads the count for the Gallery tab's badge.
 */

import { useSyncExternalStore } from 'react'

import { createGalleryNotices } from '@core/notices/galleryNotice'

export const galleryNotices = createGalleryNotices()

/** The current toast (or null) and the unseen counts, as the board's snapshot: the same object until something changes. */
export function useGalleryNotices() {
  return useSyncExternalStore(galleryNotices.subscribe, galleryNotices.getSnapshot)
}

/** How many results have been filed in this influencer's gallery since it was last opened. */
export function useUnseenInGallery(influencerId) {
  const { unseen } = useGalleryNotices()
  return (influencerId && unseen[String(influencerId)]) || 0
}
