/**
 * Resolving media paths that came from the web app.
 *
 * The seeded influencers were authored for the Vite app, where an image was
 * written as "/camila/main.jpg" and the browser resolved it against the site
 * origin. React Native has no origin: such a path resolves to nothing, and
 * <Image> renders a silent blank box. That is why four of the seeded
 * influencers showed no avatar.
 *
 * The four avatars that matter are bundled as app assets and mapped below —
 * about 4MB, which is worth it for the list and profile to look right.
 *
 * The rest of the seed media cannot come along: the referenced files add up to
 * roughly 285MB of full-resolution stills and clips, most of it close-ups and
 * character sheets. Those paths stay unservable, so `isServable` reports false
 * and callers hide the item instead of rendering an empty frame. That matters
 * most in the Gallery, where Camila's 15 seed clips would otherwise appear as
 * 15 black tiles that can never load.
 */

const BUNDLED = {
  '/camila/main.jpg': require('../../assets/seeds/camila-main.jpg'),
  '/kayla/main.jpg': require('../../assets/seeds/kayla-main.jpg'),
  '/jake/main.jpeg': require('../../assets/seeds/jake-main.jpeg'),
  '/marcus/main.png': require('../../assets/seeds/marcus-main.png'),
}

/** True when this URI can actually be displayed on the device. */
export function isServable(uri) {
  if (!uri || typeof uri !== 'string') return false
  if (BUNDLED[uri]) return true
  // A bare leading slash is a web-origin path with no origin to resolve against.
  return !uri.startsWith('/')
}

/**
 * An <Image>/<VideoView> source, or null when the path cannot be displayed.
 * Callers should treat null as "show the placeholder", never pass it through.
 */
export function mediaSource(uri) {
  if (!uri || typeof uri !== 'string') return null
  if (BUNDLED[uri]) return BUNDLED[uri]
  if (uri.startsWith('/')) return null
  return { uri }
}
