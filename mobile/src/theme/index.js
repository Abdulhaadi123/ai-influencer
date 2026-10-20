/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Theme — the "Influenza" look: white pages with soft lavender and pink glows,
 * frosted-glass cards, one deep violet for actions, and a navy floating tab bar.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The colour VALUES come from the approved Figma design (the light frames), measured from
 * its screenshots: primary violet #5B49B2, navy #080353, black auth buttons, #E4E4E4 auth
 * fields. The light design is the one that was approved; the dark palette is derived from
 * the same hues (deep indigo ground, the same violet, a navy bar with a lit edge) so the
 * Light / Dark choice in Settings has something to switch to.
 *
 * Names are kept from the previous theme (`bg`, `surface`, `textPrimary`, `brand`…) so a
 * screen that has not been touched still gets the new colours. New tokens are the glass
 * set (`glass`, `field`), the action colours (`primary`, `ink`, `navy`) and the glows.
 *
 * The preference itself is persisted through the SHARED core storage.
 */

import { createContext, useContext, useMemo, useState, useCallback } from 'react'
import * as storage from '@core/platform/storage'

const THEME_KEY = 'theme_preference' // 'light' | 'dark'

const light = {
  // Ground
  bg: '#FFFFFF',
  bgSecondary: '#FFFFFF',
  glowLavender: '#9F95FA',
  glowPink: '#F6A6FE',
  glowLavenderOpacity: 0.85,
  glowPinkOpacity: 0.75,

  // Frosted glass: translucent so the glows show through, like the design's cards.
  sheet: '#FFFFFF',                         // opaque: dialogs and sheets, which sit over a dimmed page
  surface: 'rgba(255,255,255,0.66)',        // near-white cards (Home's feature cards)
  surfaceAlt: 'rgba(91,73,178,0.09)',       // a faint violet wash: inactive chips, tracks
  glass: 'rgba(167,152,255,0.30)',          // lavender cards (Profile, Settings, Create)
  glassStrong: 'rgba(108,96,165,0.92)',     // the influencer rows, #6C60A5 in the design
  glassEdge: 'rgba(255,255,255,0.75)',      // the light rim on a glass card
  field: 'rgba(168,153,255,0.26)',          // the pill inputs inside the app
  fieldAuth: '#E4E4E4',                     // the grey pill inputs on the sign-in screens
  placeholder: '#8F8AC4',

  border: 'rgba(91,73,178,0.30)',
  borderSubtle: 'rgba(91,73,178,0.14)',

  textPrimary: '#0B0A1E',
  textSecondary: '#4B4770',
  textTertiary: '#8782B0',

  // Actions
  primary: '#5B49B2',
  primaryPressed: '#4B3AA0',
  onPrimary: '#FFFFFF',
  ink: '#000000',                           // the black pill buttons on the auth screens
  onInk: '#FFFFFF',
  navy: '#080353',                          // the floating tab bar, the logo
  onNavy: '#FFFFFF',
  link: '#6A4FE6',
  chip: '#6C35F0',                          // the little pill at the top right of Home

  accent: '#5B49B2',
  accentSoft: 'rgba(91,73,178,0.12)',
  success: '#16A34A',
  danger: '#E0142E',
  dangerSoft: 'rgba(255,60,110,0.16)',
  warning: '#B45309',
  warningSoft: 'rgba(245,158,11,0.16)',

  // Kept names (see the header).
  brand: '#5B49B2',
  brandDeep: '#4B3AA0',
  brandAlt: '#C45FF8',
  brandSoft: 'rgba(91,73,178,0.12)',
  brandGradient: ['#C45FF8', '#2715CB'],
  heroGradient: ['#C45FF8', '#2715CB', '#110877'],   // the Home banner

  isDark: false,
}

const dark = {
  bg: '#07061C',
  bgSecondary: '#0C0A2A',
  glowLavender: '#3B2BA6',
  glowPink: '#8A1FB5',
  glowLavenderOpacity: 0.7,
  glowPinkOpacity: 0.4,

  sheet: '#15123F',
  surface: 'rgba(255,255,255,0.07)',
  surfaceAlt: 'rgba(255,255,255,0.08)',
  glass: 'rgba(120,100,255,0.20)',
  glassStrong: 'rgba(120,104,210,0.55)',
  glassEdge: 'rgba(255,255,255,0.16)',
  field: 'rgba(255,255,255,0.09)',
  fieldAuth: '#1B1A36',
  placeholder: '#7C77AE',

  border: 'rgba(170,155,255,0.34)',
  borderSubtle: 'rgba(170,155,255,0.16)',

  textPrimary: '#F4F2FF',
  textSecondary: '#BAB5DD',
  textTertiary: '#8B86B8',

  primary: '#7B66E8',
  primaryPressed: '#6A55D8',
  onPrimary: '#FFFFFF',
  ink: '#EDEBFF',
  onInk: '#0B0A1E',
  navy: '#100B52',
  onNavy: '#FFFFFF',
  link: '#A593FF',
  chip: '#7B4DF5',

  accent: '#9A87FF',
  accentSoft: 'rgba(154,135,255,0.18)',
  success: '#4ADE80',
  danger: '#FF6B81',
  dangerSoft: 'rgba(255,90,120,0.18)',
  warning: '#FBBF24',
  warningSoft: 'rgba(251,191,36,0.16)',

  brand: '#9A87FF',
  brandDeep: '#B7A9FF',
  brandAlt: '#C45FF8',
  brandSoft: 'rgba(154,135,255,0.18)',
  brandGradient: ['#C45FF8', '#2715CB'],
  heroGradient: ['#C45FF8', '#2715CB', '#110877'],

  isDark: true,
}

const ThemeCtx = createContext(null)

export function ThemeProvider({ children }) {
  // Light unless the person chose Dark. The design has an explicit Light / Dark choice
  // (no "follow the phone"), and only the light screens are the approved ones.
  const [preference, setPreferenceState] = useState(() => (storage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'))

  const setPreference = useCallback(next => {
    setPreferenceState(next === 'dark' ? 'dark' : 'light')
    try { storage.setItem(THEME_KEY, next === 'dark' ? 'dark' : 'light') } catch {}
  }, [])

  const value = useMemo(() => ({
    colors: preference === 'dark' ? dark : light,
    scheme: preference,
    preference,
    setPreference,
  }), [preference, setPreference])

  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>
}

export function useTheme() {
  const ctx = useContext(ThemeCtx)
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>')
  return ctx
}

/** Shared spacing/radius scale so screens stay consistent. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 22, xxl: 36 }
export const radius = { sm: 10, md: 16, lg: 24, xl: 32, pill: 999 }

/** Screen-level layout constants of the design (a 402-wide frame, 20 px gutters). */
export const layout = {
  gutter: 20,
  pageGutter: 34,          // forms and lists: Settings, Create, the influencer tabs
  tabBarHeight: 72,
  tabBarGap: 12,           // between the bar and the bottom edge (plus the safe-area inset)
  controlHeight: 52,       // pill buttons and inputs
}

/**
 * Type. The design's typeface is a geometric grotesque; its exact name has not been
 * supplied, so the system font is used and every weight goes through `font()`. When the
 * font files are added, fill in `families` (and load them in App.js) and the whole app
 * changes at once.
 */
export const families = { light: null, regular: null, medium: null, semibold: null, bold: null }
const WEIGHT = { light: '300', regular: '400', medium: '500', semibold: '600', bold: '700' }

export function font(weight = 'regular') {
  const family = families[weight]
  // A custom family already IS its weight; asking Android for fontWeight on top of it
  // synthesises a second, wrong one.
  return family ? { fontFamily: family } : { fontWeight: WEIGHT[weight] || '400' }
}

/** How much of the screen's bottom the floating tab bar covers (bar + its gap + the safe area). */
export const tabBarFootprint = insets => layout.tabBarHeight + layout.tabBarGap + Math.max(insets.bottom, 8)
