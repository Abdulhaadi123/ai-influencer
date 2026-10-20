/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The tick: a violet disc that pops in, a ring that ripples out, and a white tick drawn stroke
 * by stroke. It is what the app shows when something it asked for has been done and the person
 * has only to read a line and go on (the verification email is on its way).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Drawn in SVG, so it is sharp at any size and takes the theme's violet. The animation is the
 * JS driver's, because the properties it moves (a radius, a dash offset) belong to the SVG and
 * not to a view; it is a second long and plays once.
 *
 * A person who has asked their phone to reduce motion gets the finished tick at once.
 */

import { useEffect, useRef } from 'react'
import { AccessibilityInfo, Animated, Easing, View } from 'react-native'
import Svg, { Circle, Path } from 'react-native-svg'

import { useTheme } from '../theme'

const AnimatedCircle = Animated.createAnimatedComponent(Circle)
const AnimatedPath = Animated.createAnimatedComponent(Path)

/** The tick's own geometry in a 120 × 120 box, and the length of its two strokes together. */
const TICK = 'M37 62 L54 79 L85 43'
const TICK_LENGTH = 24.1 + 48.4   // √(17²+17²) + √(31²+36²), rounded up a little below

export default function SuccessTick({ size = 128, color }) {
  const { colors } = useTheme()
  const fill = color || colors.primary

  const pop = useRef(new Animated.Value(0)).current    // the disc grows into place
  const draw = useRef(new Animated.Value(0)).current   // the tick is drawn
  const ripple = useRef(new Animated.Value(0)).current // a ring leaves the disc

  useEffect(() => {
    let cancelled = false
    let run = null

    AccessibilityInfo.isReduceMotionEnabled().then(reduced => {
      if (cancelled) return
      if (reduced) {
        pop.setValue(1); draw.setValue(1); ripple.setValue(1)
        return
      }
      run = Animated.sequence([
        Animated.spring(pop, { toValue: 1, friction: 6, tension: 80, useNativeDriver: false }),
        Animated.parallel([
          Animated.timing(draw, { toValue: 1, duration: 420, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
          Animated.timing(ripple, { toValue: 1, duration: 900, easing: Easing.out(Easing.quad), useNativeDriver: false }),
        ]),
      ])
      run.start()
    }).catch(() => { pop.setValue(1); draw.setValue(1); ripple.setValue(1) })

    return () => { cancelled = true; run?.stop() }
  }, [pop, draw, ripple])

  const discRadius = pop.interpolate({ inputRange: [0, 1], outputRange: [0, 44] })
  const haloRadius = pop.interpolate({ inputRange: [0, 1], outputRange: [20, 58] })
  const haloOpacity = pop.interpolate({ inputRange: [0, 1], outputRange: [0, 0.16] })
  const tickOffset = draw.interpolate({ inputRange: [0, 1], outputRange: [TICK_LENGTH + 2, 0] })
  const ringRadius = ripple.interpolate({ inputRange: [0, 1], outputRange: [44, 60] })
  const ringOpacity = ripple.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 0.45, 0] })

  return (
    <View accessible accessibilityRole="image" accessibilityLabel="Done" style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox="0 0 120 120">
        <AnimatedCircle cx="60" cy="60" r={haloRadius} fill={fill} fillOpacity={haloOpacity} />
        <AnimatedCircle cx="60" cy="60" r={ringRadius} fill="none" stroke={fill} strokeWidth="2.5" strokeOpacity={ringOpacity} />
        <AnimatedCircle cx="60" cy="60" r={discRadius} fill={fill} />
        <AnimatedPath
          d={TICK}
          fill="none"
          stroke="#FFFFFF"
          strokeWidth="9"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={[TICK_LENGTH + 2, TICK_LENGTH + 2]}
          strokeDashoffset={tickOffset}
        />
      </Svg>
    </View>
  )
}
