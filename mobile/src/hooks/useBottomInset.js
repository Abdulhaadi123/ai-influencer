/**
 * Bottom padding that clears the tab bar, not just the gesture area.
 *
 * Every screen used to pad by `insets.bottom`, which is only the system
 * gesture inset (~24px). The bottom tab bar floats over the content and is
 * roughly 80px tall, so the last stretch of any full-height scroll view was
 * hidden behind it — the "Generate video" button was half-swallowed.
 *
 * BottomTabBarHeightContext already carries the real height, INCLUDING the
 * safe-area inset, so it is the right number to pad by. Read through the
 * context rather than useBottomTabBarHeight() because the hook throws outside
 * a tab screen, and these components are also rendered inside a Modal, where
 * the provider may not be reachable. Falling back to the safe-area inset keeps
 * them working anywhere.
 */

import { useContext } from 'react'
import { BottomTabBarHeightContext } from '@react-navigation/bottom-tabs'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { space } from '../theme'

export function useBottomInset(extra = space.xxl) {
  const insets = useSafeAreaInsets()
  const tabBarHeight = useContext(BottomTabBarHeightContext)
  return (tabBarHeight ?? insets.bottom) + extra
}
