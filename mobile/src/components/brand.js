/**
 * The brand marks: the Influenza logo and the glowing orb.
 *
 * Drawn in SVG from the approved design's geometry, so they are crisp at any size and can be
 * recoloured. They stand in for the designer's own export: when those files are added, replace
 * the bodies below and nothing else changes — every screen asks for `<Logo />` and `<Orb />`.
 */

import Svg, { Defs, RadialGradient, Stop, Path, Rect, Circle } from 'react-native-svg'
import { View, Text } from 'react-native'

import { useTheme, font } from '../theme'

/** The mark's own box, taken from the design: 151 × 103. */
const MARK_W = 151
const MARK_H = 103

/**
 * The little sphere that dots the "i" — and, larger, the centre of the tab bar.
 * A radial gradient with its light source up and to the right, as in the design.
 */
export function Orb({ size = 52, id = 'orb' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <RadialGradient id={id} cx="62%" cy="30%" rx="75%" ry="75%" fx="66%" fy="26%">
          <Stop offset="0" stopColor="#F4A6FF" />
          <Stop offset="0.28" stopColor="#A56BFF" />
          <Stop offset="0.62" stopColor="#4A2BD8" />
          <Stop offset="1" stopColor="#14096B" />
        </RadialGradient>
      </Defs>
      <Circle cx="50" cy="50" r="50" fill={`url(#${id})`} />
    </Svg>
  )
}

/** The mark alone: the stem, the quarter ring, and the orb above the stem. */
export function LogoMark({ height = 36, color }) {
  const { colors } = useTheme()
  const fill = color || (colors.isDark ? colors.textPrimary : colors.navy)
  const width = (height * MARK_W) / MARK_H
  return (
    <Svg width={width} height={height} viewBox={`0 0 ${MARK_W} ${MARK_H}`}>
      <Defs>
        <RadialGradient id="logoOrb" cx="64%" cy="28%" rx="80%" ry="80%" fx="68%" fy="24%">
          <Stop offset="0" stopColor="#F4A6FF" />
          <Stop offset="0.35" stopColor="#8F5BFF" />
          <Stop offset="1" stopColor="#2A1BB0" />
        </RadialGradient>
      </Defs>
      {/* the stem of the "i" */}
      <Rect x="0" y="50" width="48" height="53" fill={fill} />
      {/* the quarter ring of the "n" */}
      <Path d="M48 0 A103 103 0 0 1 151 103 L99 103 A51 51 0 0 0 48 52 Z" fill={fill} />
      {/* the dot of the "i" */}
      <Circle cx="24" cy="25" r="18" fill="url(#logoOrb)" />
    </Svg>
  )
}

/**
 * The mark with "influenza AI" beside it (the design's second splash and its auth screens).
 * `height` is the mark's height; the wordmark scales with it.
 */
export function Logo({ height = 36, wordmark = true, color }) {
  const { colors } = useTheme()
  const ink = color || (colors.isDark ? colors.textPrimary : colors.navy)
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: height * 0.3 }}>
      <LogoMark height={height} color={color} />
      {wordmark ? (
        <Text
          accessibilityRole="header"
          style={[{ color: ink, fontSize: height * 0.66, letterSpacing: -0.4 }, font('light')]}
        >
          influenza AI
        </Text>
      ) : null}
    </View>
  )
}
