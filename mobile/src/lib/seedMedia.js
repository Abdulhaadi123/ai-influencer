/**
 * Guarding against media paths that only ever worked in a browser.
 *
 * The app used to ship demo influencers authored for the old Vite site, where
 * an image was written as "/camila/main.jpg" and the browser resolved it
 * against the site origin. React Native has no origin: such a path resolves to
 * nothing and <Image> renders a silent blank box.
 *
 * Those influencers have been removed, so a fresh install never sees one. This
 * guard stays for two cases that still exist:
 *
 *  - an installed copy whose demo influencer was KEPT because the user had
 *    generated something on it (see the purge in core/store.jsx), and
 *  - any future record that somehow carries a bare path.
 *
 * Callers hide the item rather than render an empty frame. That matters most
 * in the Gallery, where a dead path would otherwise become a black tile with a
 * video player behind it trying to decode nothing.
 */

/** True when this URI can actually be displayed on the device. */
export function isServable(uri) {
  if (!uri || typeof uri !== 'string') return false
  // A bare leading slash is a web-origin path with no origin to resolve against.
  return !uri.startsWith('/')
}

/**
 * An <Image> source, or null when the path cannot be displayed. Callers should
 * treat null as "show the placeholder", never pass it through.
 */
export function mediaSource(uri) {
  return isServable(uri) ? { uri } : null
}
