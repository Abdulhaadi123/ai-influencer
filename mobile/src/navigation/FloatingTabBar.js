/**
 * The tab bar: a navy pill that floats above the page, four icons and the orb.
 *
 * Home, Influencers, [Create — the orb], Queue, Settings, in the design's order. The tab you
 * are on is drawn solid; the others are outlines. It is absolutely positioned, so it never
 * pushes a screen up — screens keep clear of it with `useBottomInset`.
 *
 * It hides while the keyboard is open: on Android the window resizes for the keyboard, and a
 * bar that rode up with it would sit on top of the very field being typed in.
 */

import { useEffect, useState } from 'react'
import { View, Text, Pressable, StyleSheet, Keyboard, Platform } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useTheme, layout } from '../theme'
import Icon from '../components/icons'
import { Orb } from '../components/brand'

const ICONS = { Home: 'home', Influencers: 'star', Queue: 'queue', Settings: 'settings' }
const ORB_SIZE = 52

function useKeyboardOpen() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setOpen(true))
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setOpen(false))
    return () => { show.remove(); hide.remove() }
  }, [])
  return open
}

export default function FloatingTabBar({ state, descriptors, navigation }) {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const keyboardOpen = useKeyboardOpen()
  if (keyboardOpen) return null

  return (
    <View
      pointerEvents="box-none"
      style={[styles.wrap, { bottom: Math.max(insets.bottom, 8) + layout.tabBarGap }]}
    >
      <View style={[styles.bar, { backgroundColor: colors.navy, borderColor: colors.isDark ? 'rgba(170,155,255,0.28)' : 'transparent' }]}>
        {state.routes.map((route, index) => {
          const { options } = descriptors[route.key]
          const focused = state.index === index
          const label = options.tabBarLabel ?? options.title ?? route.name
          const badge = options.tabBarBadge

          const onPress = () => {
            const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true })
            if (!focused && !event.defaultPrevented) navigation.navigate(route.name, route.params)
          }
          const onLongPress = () => navigation.emit({ type: 'tabLongPress', target: route.key })

          return (
            <Pressable
              key={route.key}
              onPress={onPress}
              onLongPress={onLongPress}
              accessibilityRole="button"
              accessibilityLabel={typeof label === 'string' ? label : route.name}
              accessibilityState={{ selected: focused }}
              hitSlop={6}
              style={({ pressed }) => [styles.item, { opacity: pressed ? 0.7 : 1 }]}
            >
              {route.name === 'Create' ? (
                <View style={[styles.orbWrap, focused && styles.orbFocused]}>
                  <Orb size={ORB_SIZE} id={`tabOrb${index}`} />
                </View>
              ) : (
                <Icon name={ICONS[route.name] || 'home'} size={28} color={colors.onNavy} filled={focused} />
              )}
              {badge ? (
                <View style={[styles.badge, { backgroundColor: colors.chip }]}>
                  <Text style={styles.badgeText}>{badge}</Text>
                </View>
              ) : null}
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: layout.gutter, right: layout.gutter },
  bar: {
    height: layout.tabBarHeight, borderRadius: layout.tabBarHeight / 2, borderWidth: 1,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', paddingHorizontal: 10,
    shadowColor: '#080353', shadowOpacity: 0.28, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 10,
  },
  item: { flex: 1, height: layout.tabBarHeight, alignItems: 'center', justifyContent: 'center' },
  orbWrap: { width: ORB_SIZE, height: ORB_SIZE, borderRadius: ORB_SIZE / 2 },
  // The Create tab has no outline/solid pair to show "you are here", so it gets a lit rim.
  orbFocused: { shadowColor: '#C45FF8', shadowOpacity: 0.9, shadowRadius: 12, shadowOffset: { width: 0, height: 0 }, elevation: 6 },
  badge: { position: 'absolute', top: 14, right: '22%', minWidth: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  badgeText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700' },
})
