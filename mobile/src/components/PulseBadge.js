/**
 * A small count badge that asks to be looked at: it pops in, bumps when the number rises, and a soft
 * ring spreads out of it every couple of seconds until it is gone. Used on the Gallery tab of an
 * influencer for results that have arrived since the person last looked there (components/ui.js
 * Segmented, fed by lib/galleryNotice.js).
 *
 * Everything moves on the native driver. A person who asked their phone for less motion gets the
 * still badge: no pop, no bump, no ring.
 */

import { useEffect, useRef } from 'react'
import { AccessibilityInfo, Animated, Easing, StyleSheet, Text, View } from 'react-native'

import { badgeText } from '@core/notices/galleryNotice'

import { useTheme } from '../theme'

const SIZE = 18

/**
 * @param {{count: number, style?: object}} props  `style` places it (the badge itself is absolute)
 */
export default function PulseBadge({ count, style }) {
  const { colors } = useTheme()
  const pop = useRef(new Animated.Value(0)).current    // 0 → 1 when it first appears
  const bump = useRef(new Animated.Value(1)).current   // swells when the number rises
  const ring = useRef(new Animated.Value(0)).current   // 0 → 1, over and over

  // Appearing, and the ring that follows.
  useEffect(() => {
    let cancelled = false
    let loop = null
    AccessibilityInfo.isReduceMotionEnabled().then(reduced => {
      if (cancelled) return
      if (reduced) { pop.setValue(1); return }
      Animated.spring(pop, { toValue: 1, friction: 5, tension: 120, useNativeDriver: true }).start()
      loop = Animated.loop(Animated.sequence([
        Animated.timing(ring, { toValue: 1, duration: 1400, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.delay(900),
        Animated.timing(ring, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]))
      loop.start()
    }).catch(() => pop.setValue(1))
    return () => { cancelled = true; loop?.stop() }
  }, [pop, ring])

  // A bump each time the number changes after the first showing.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    Animated.sequence([
      Animated.timing(bump, { toValue: 1.3, duration: 120, useNativeDriver: true }),
      Animated.spring(bump, { toValue: 1, friction: 4, useNativeDriver: true }),
    ]).start()
  }, [count, bump])

  if (!(count > 0)) return null
  return (
    <View style={[styles.wrap, style]} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Animated.View
        style={[
          styles.ring,
          {
            backgroundColor: colors.chip,
            opacity: ring.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
            transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [1, 2.3] }) }],
          },
        ]}
      />
      <Animated.View style={[styles.badge, { backgroundColor: colors.chip, transform: [{ scale: Animated.multiply(pop, bump) }] }]}>
        <Text style={styles.text}>{badgeText(count)}</Text>
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', minWidth: SIZE, height: SIZE, alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', width: SIZE, height: SIZE, borderRadius: SIZE / 2 },
  badge: { minWidth: SIZE, height: SIZE, borderRadius: SIZE / 2, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  text: { color: '#FFFFFF', fontSize: 11, fontWeight: '700', lineHeight: 14 },
})
