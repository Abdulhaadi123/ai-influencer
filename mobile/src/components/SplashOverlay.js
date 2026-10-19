/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The splash: the design's two splash frames, played once at launch.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   1. the mark on white         (Figma "splash 1": the mark, 151 × 103, in the middle)
 *   2. the mark and the wordmark (Figma "splash 2": "influenza AI", centred)
 *
 * It is the second half of a hand-over. The phone's own launch screen (set in app.json,
 * expo-splash-screen) already shows frame 1 — the same mark, the same size, the same place —
 * while the app starts. When this overlay has drawn its first frame it tells the system to
 * take that one down (`SplashScreen.hideAsync`), and nothing moves: the mark simply goes on
 * from there into the wordmark.
 *
 * It is a fixed show, not a wait. The session coming out of the Keychain takes a few
 * milliseconds, and a splash that lasted that long would never be seen, so frame 1 is held
 * for a moment and frame 2 for another before the overlay fades away — and it keeps showing
 * for as long as the app is not ready (`ready`), whichever is longer.
 *
 * Light only, whatever the phone's theme: the design's splash is white with a navy mark, and
 * the system's launch screen it follows is white too. A dark splash after a white one would flash.
 */

import { useEffect, useRef, useState } from 'react'
import { Animated, Easing, StyleSheet, View, useWindowDimensions } from 'react-native'
import * as SplashScreen from 'expo-splash-screen'

import { Logo, LogoMark } from './brand'

const NAVY = '#080353'

/** Frame 1: the mark is 103 tall in the design (151 wide). */
export const MARK_HEIGHT = 104

/** Frame 2: the mark is about 49 tall beside the wordmark in the design (402 wide frame) — scaled down on a narrow phone. */
export function wordmarkHeight(screenWidth) {
  return Math.round(Math.min(48, Math.max(34, screenWidth * 0.12)))
}

/** How long each frame stays, in milliseconds. */
export const TIMING = Object.freeze({ holdMark: 550, toWordmark: 450, holdWordmark: 650, fadeOut: 250 })

/**
 * @param {object} props
 * @param {boolean} props.ready  the app can be shown (the session has been read)
 * @param {() => void} props.onGone  called once the overlay has faded out and can be removed
 */
export default function SplashOverlay({ ready, onGone }) {
  const { width } = useWindowDimensions()
  const settle = useRef(new Animated.Value(0)).current   // 0 = the mark alone, 1 = the mark with its wordmark
  const fade = useRef(new Animated.Value(1)).current     // 1 = fully there, 0 = gone
  const [played, setPlayed] = useState(false)
  const handedOver = useRef(false)

  // The two frames, one after the other.
  useEffect(() => {
    const run = Animated.sequence([
      Animated.delay(TIMING.holdMark),
      Animated.timing(settle, { toValue: 1, duration: TIMING.toWordmark, easing: Easing.inOut(Easing.cubic), useNativeDriver: true }),
      Animated.delay(TIMING.holdWordmark),
    ])
    run.start(({ finished }) => { if (finished) setPlayed(true) })
    return () => run.stop()
  }, [settle])

  // Away, once both frames have played and the app is ready underneath.
  useEffect(() => {
    if (!played || !ready) return
    Animated.timing(fade, { toValue: 0, duration: TIMING.fadeOut, easing: Easing.out(Easing.quad), useNativeDriver: true })
      .start(({ finished }) => { if (finished) onGone() })
  }, [played, ready, fade, onGone])

  /** First frame drawn: the system's own launch screen (the same mark) can go. */
  const onLayout = () => {
    if (handedOver.current) return
    handedOver.current = true
    SplashScreen.hideAsync().catch(() => {})
  }

  const markFades = settle.interpolate({ inputRange: [0, 1], outputRange: [1, 0] })
  const logoHeight = wordmarkHeight(width)

  return (
    <Animated.View pointerEvents="auto" onLayout={onLayout} style={[styles.root, { opacity: fade }]}>
      <View style={styles.centre} accessibilityLabel="influenza AI" accessible accessibilityRole="image">
        <Animated.View style={[styles.layer, { opacity: markFades }]}>
          <LogoMark height={MARK_HEIGHT} color={NAVY} />
        </Animated.View>
        <Animated.View style={{ opacity: settle }}>
          <Logo height={logoHeight} color={NAVY} />
        </Animated.View>
      </View>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  root: { ...StyleSheet.absoluteFill, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', zIndex: 100 },
  centre: { alignItems: 'center', justifyContent: 'center' },
  // Frame 1's mark sits exactly where the wordmark layer's centre is.
  layer: { position: 'absolute', alignSelf: 'center' },
})
