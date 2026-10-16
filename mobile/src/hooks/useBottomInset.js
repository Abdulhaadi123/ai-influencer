/**
 * Bottom padding that clears the floating tab bar, not just the gesture area.
 *
 * The bar floats over the content (it is an absolutely positioned pill, not a strip that
 * pushes the screen up), so the last stretch of any full-height scroll view would sit behind
 * it. Inside the tabs this returns the space the bar covers; elsewhere — a pushed screen, a
 * Modal, where there is no bar — only the safe-area inset, so those screens do not leave a
 * gap for a bar that is not there.
 *
 * Whether we are inside the tabs is read from BottomTabBarHeightContext, which is
 * `undefined` outside a tab navigator. It is read through the context rather than
 * useBottomTabBarHeight() because that hook THROWS outside a tab screen, and these
 * components are also rendered inside a Modal.
 */

import { useContext } from 'react'
import { BottomTabBarHeightContext } from '@react-navigation/bottom-tabs'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { space, tabBarFootprint } from '../theme'

export function useBottomInset(extra = space.xl) {
  const insets = useSafeAreaInsets()
  const inTabs = useContext(BottomTabBarHeightContext) !== undefined
  return (inTabs ? tabBarFootprint(insets) : insets.bottom) + extra
}
