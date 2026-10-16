/**
 * The design's full-bleed photographs (the welcome screen's woman in the neon suit).
 *
 * They are not in the repository yet: the Figma file is private, and the photo has to be
 * exported from it by someone who can open it. Until then each is `null` and the screens
 * draw a gradient in the same colours. To switch one on, add the file under `mobile/assets/`
 * and replace the `null`, e.g.
 *
 *     export const welcomeHero = require('../../assets/welcome-hero.jpg')
 *
 * (Metro needs a literal path, so a missing file cannot be probed for at runtime.)
 */

export const welcomeHero = null
