/**
 * The store's announcement that something was filed in a gallery — a few lines, so the store
 * (which knows nothing of screens) can tell the interface (which knows nothing of the store's
 * internals) without either importing the other. Listeners are the interface's; a listener that
 * throws is reported and does not stop the others.
 */

/** @typedef {{influencerId: string, entry: object}} GalleryAdded */

/** @type {Set<(added: GalleryAdded) => void>} */
const listeners = new Set()

/** Listen for entries filed in any gallery. Returns the way to stop listening. */
export function onGalleryAdded(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Said by the store once for each entry newly added to a gallery. */
export function emitGalleryAdded(added) {
  for (const listener of [...listeners]) {
    try { listener(added) } catch (e) { console.warn('[gallery] a listener failed:', e?.message ?? e) }
  }
}
