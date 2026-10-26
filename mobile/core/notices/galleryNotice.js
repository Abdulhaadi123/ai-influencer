/**
 * ─────────────────────────────────────────────────────────────────────────────
 * "Saved to Gallery" — telling someone where a finished result went.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A video or an image finishes, is filed in the influencer's gallery, and nothing on screen says
 * so: the person is left to wonder whether it was made, and where. Two things say it now, both
 * driven from here:
 *
 *   • a toast — a card that slides in with the picture (or a video tile), "Saved to Gallery"
 *     and a button that opens the Gallery;
 *   • a badge on the Gallery tab of that influencer, counting what has been added since the
 *     person last looked there.
 *
 * This file is the rules and nothing else (no React, no native modules; galleryNotice.test.js):
 * when a toast appears, when several results become one, when to stay quiet (the person is
 * looking at that very gallery, where the result appears on its own), and what has not been seen.
 * The store announces each entry it files (galleryEvents.js); src/lib/galleryNotice.js feeds those
 * announcements in and src/components/GalleryToastHost.js draws the result.
 */

/** How long the toast stays up. A result that arrives while it is up joins it and starts the clock again. */
export const TOAST_MS = 6500

/** An entry announced twice (the same result filed by two routes) counts once for this long. */
const REMEMBER_MS = 60_000

/**
 * @typedef {object} Toast
 * @property {number} id
 * @property {string} influencerId
 * @property {number} count          results in this toast
 * @property {{image: number, video: number}} kinds
 * @property {{id: string, type: 'image'|'video', thumbUrl: string|null, url: string|null, label: string|null}} latest
 * @property {number} at             when the newest one arrived
 */

/** What the toast needs to draw one result: its kind and the picture, if there is one. */
function summarise(entry) {
  return {
    id: String(entry.id),
    type: entry.type === 'video' ? 'video' : 'image',
    thumbUrl: typeof entry.thumbUrl === 'string' && entry.thumbUrl ? entry.thumbUrl : null,
    url: typeof entry.url === 'string' && entry.url ? entry.url : null,
    label: typeof entry.label === 'string' && entry.label ? entry.label : null,
  }
}

/**
 * The toast's headline: what was saved, said once for however many there are.
 * @param {Pick<Toast, 'count'|'kinds'>} toast
 */
export function toastTitle({ count, kinds }) {
  if (count <= 1) return kinds.video >= 1 ? 'Video saved to Gallery' : 'Image saved to Gallery'
  if (kinds.image === 0) return `${count} videos saved to Gallery`
  if (kinds.video === 0) return `${count} images saved to Gallery`
  return `${count} items saved to Gallery`
}

/** The number on the Gallery tab's badge: 1–9, then "9+". */
export function badgeText(count) {
  return count > 9 ? '9+' : String(count)
}

/**
 * @param {{now?: () => number}} [deps]  the clock, so a test can move it
 */
export function createGalleryNotices({ now = Date.now } = {}) {
  /** @type {Toast|null} */
  let toast = null
  /** @type {Map<string, number>} */
  let unseen = new Map()
  /** @type {string|null} */
  let viewing = null
  /** @type {Map<string, number>} entry id → when it was announced */
  const announced = new Map()
  const listeners = new Set()
  let nextToastId = 1

  // The snapshot is replaced, never edited, so a subscriber can tell "nothing changed" by identity.
  let snapshot = { toast: null, unseen: Object.freeze({}) }
  const publish = () => {
    snapshot = { toast, unseen: Object.freeze(Object.fromEntries(unseen)) }
    for (const l of [...listeners]) l()
  }

  /** Everything in this gallery has been seen: no badge, and no toast about it. */
  function markSeen(influencerId) {
    const key = String(influencerId)
    let changed = false
    if (unseen.has(key)) { unseen = new Map(unseen); unseen.delete(key); changed = true }
    if (toast && toast.influencerId === key) { toast = null; changed = true }
    if (changed) publish()
  }

  return {
    /**
     * An entry was filed in an influencer's gallery.
     * @param {{influencerId: string, entry: {id: string, type?: string, thumbUrl?: string|null, url?: string|null, label?: string|null}}} added
     */
    add({ influencerId, entry }) {
      if (!influencerId || !entry || entry.id === undefined || entry.id === null) return
      const at = now()
      for (const [id, when] of announced) if (at - when > REMEMBER_MS) announced.delete(id)
      const entryId = String(entry.id)
      if (announced.has(entryId)) return
      announced.set(entryId, at)

      // Looking at that gallery: the result is appearing in front of them. Nothing to announce.
      if (viewing === String(influencerId)) return

      const key = String(influencerId)
      unseen = new Map(unseen).set(key, (unseen.get(key) || 0) + 1)

      const latest = summarise(entry)
      if (toast && toast.influencerId === key && at - toast.at < TOAST_MS) {
        toast = {
          ...toast, count: toast.count + 1, latest, at,
          kinds: { ...toast.kinds, [latest.type]: toast.kinds[latest.type] + 1 },
        }
      } else {
        toast = {
          id: nextToastId++, influencerId: key, count: 1, latest, at,
          kinds: { image: latest.type === 'image' ? 1 : 0, video: latest.type === 'video' ? 1 : 0 },
        }
      }
      publish()
    },

    /** The toast was closed (by its button, its timer or the person). A newer toast is left alone. */
    dismissToast(id) {
      if (!toast || toast.id !== id) return
      toast = null
      publish()
    },

    /** The person is looking at this influencer's gallery (or has left it: null). */
    setViewing(influencerId) {
      viewing = influencerId ? String(influencerId) : null
      if (viewing) markSeen(viewing)
    },

    markSeen,

    /** A different person is signed in: nothing of the last one's carries over. */
    reset() {
      toast = null
      unseen = new Map()
      viewing = null
      announced.clear()
      publish()
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
  }
}
