/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Theme — native counterpart of the web app's CSS custom properties.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The web theme (src/context/theme.jsx) drives colours through CSS variables on
 * <html> and animates the swap with the DOM view-transition API. Neither exists
 * in React Native, so this is a deliberate re-implementation rather than a port
 * — but the colour VALUES are the same, so the two apps stay visually related.
 *
 * The preference itself is persisted through the SHARED core storage, so it
 * lives in the same place on both platforms.
 */

import { createContext, useContext, useMemo, useState, useCallback } from 'react'
import { useColorScheme } from 'react-native'
import * as storage from '@core/platform/storage'

const THEME_KEY = 'theme_preference' // 'system' | 'light' | 'dark'

const light = {
  bg: '#F8FAFC',
  bgSecondary: '#FFFFFF',
  surface: '#FFFFFF',
  surfaceAlt: '#F1F5F9',
  border: 'rgba(15, 23, 42, 0.10)',
  borderSubtle: 'rgba(15, 23, 42, 0.06)',
  textPrimary: '#0F172A',
  textSecondary: '#475569',
  textTertiary: '#94A3B8',
  accent: '#2563EB',
  accentSoft: 'rgba(37, 99, 235, 0.10)',
  success: '#16A34A',
  danger: '#DC2626',
  isDark: false,
}

const dark = {
  bg: '#0B0F19',
  bgSecondary: '#111827',
  surface: '#131C2E',
  surfaceAlt: '#1E293B',
  border: 'rgba(56, 189, 248, 0.18)',
  borderSubtle: 'rgba(255, 255, 255, 0.08)',
  textPrimary: '#F8FAFC',
  textSecondary: '#94A3B8',
  textTertiary: '#64748B',
  accent: '#38BDF8',
  accentSoft: 'rgba(56, 189, 248, 0.16)',
  success: '#4ADE80',
  danger: '#F87171',
  isDark: true,
}

const ThemeCtx = createContext(null)

export function ThemeProvider({ children }) {
  const systemScheme = useColorScheme()

  const [preference, setPreferenceState] = useState(() => {
    const stored = storage.getItem(THEME_KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  })

  const setPreference = useCallback(next => {
    setPreferenceState(next)
    try { storage.setItem(THEME_KEY, next) } catch {}
  }, [])

  const value = useMemo(() => {
    const resolved = preference === 'system' ? (systemScheme || 'light') : preference
    return {
      colors: resolved === 'dark' ? dark : light,
      scheme: resolved,
      preference,
      setPreference,
    }
  }, [preference, systemScheme, setPreference])

  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>
}

export function useTheme() {
  const ctx = useContext(ThemeCtx)
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>')
  return ctx
}

/** Shared spacing/radius scale so screens stay consistent. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 }
export const radius = { sm: 8, md: 12, lg: 16, pill: 999 }
