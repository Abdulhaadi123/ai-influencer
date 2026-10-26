/**
 * The pages the app links to from inside itself: privacy policy, terms, help.
 *
 * Google Play's User Data policy asks for the privacy policy in two places — the field in Play
 * Console and "a privacy policy link or text within the app itself" — so the website's pages are
 * reachable from Settings and from the sign-up and welcome screens (src/components/LegalNote.js).
 * The pages live on the marketing site (a separate project, influenza-site); its routes are fixed
 * there (src/app/<page>/page.tsx), and legal.test.js keeps this table honest.
 *
 * If the site moves to its own domain, change SITE_BASE here and in the Play Console fields.
 */

export const SITE_BASE = 'https://influenza-website.vercel.app'

/** id → what it is called in the app and where it is on the site. */
export const LEGAL_PAGES = Object.freeze([
  { id: 'privacy', label: 'Privacy Policy', path: '/privacy/' },
  { id: 'terms', label: 'Terms of Use', path: '/terms/' },
  { id: 'support', label: 'Help and support', path: '/support/' },
  { id: 'deleteAccount', label: 'How to delete your account', path: '/delete-account/' },
])

/**
 * The address of one page.
 * @param {'privacy'|'terms'|'support'|'deleteAccount'} id
 * @throws for an id nothing is registered under: a typo here would open nothing, silently
 */
export function legalUrl(id) {
  const page = LEGAL_PAGES.find(p => p.id === id)
  if (!page) throw new Error(`No legal page is registered as "${id}".`)
  return `${SITE_BASE}${page.path}`
}
