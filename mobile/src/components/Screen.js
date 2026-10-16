/**
 * The page every screen sits on, and the header it opens with.
 *
 * The design's pages are white with two soft glows — lavender in the lower left, pink on the
 * right — that the frosted cards sit over. `Screen` draws them (a radial gradient each, so
 * there is no blur library and nothing native beyond SVG) and puts the content on top.
 *
 * Every screen paints its OWN page rather than the navigator painting one behind them all:
 * a stack that slides one screen over another would otherwise show two translucent pages
 * through each other mid-transition.
 */

import { View, Text, Pressable, StyleSheet } from 'react-native'
import Svg, { Defs, RadialGradient, Stop, Rect } from 'react-native-svg'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useTheme, font, layout, space } from '../theme'
import Icon from './icons'

/** The two glows. Fractions of the page, so it fits any phone. */
export function Backdrop() {
  const { colors } = useTheme()
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg width="100%" height="100%" preserveAspectRatio="none">
        <Defs>
          <RadialGradient id="glowLavender" cx="0" cy="0.76" rx="0.95" ry="0.26" gradientUnits="objectBoundingBox">
            <Stop offset="0" stopColor={colors.glowLavender} stopOpacity={colors.glowLavenderOpacity} />
            <Stop offset="0.55" stopColor={colors.glowLavender} stopOpacity={colors.glowLavenderOpacity * 0.4} />
            <Stop offset="1" stopColor={colors.glowLavender} stopOpacity="0" />
          </RadialGradient>
          <RadialGradient id="glowPink" cx="1" cy="0.36" rx="0.7" ry="0.22" gradientUnits="objectBoundingBox">
            <Stop offset="0" stopColor={colors.glowPink} stopOpacity={colors.glowPinkOpacity} />
            <Stop offset="0.55" stopColor={colors.glowPink} stopOpacity={colors.glowPinkOpacity * 0.4} />
            <Stop offset="1" stopColor={colors.glowPink} stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#glowPink)" />
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#glowLavender)" />
      </Svg>
    </View>
  )
}

export default function Screen({ children, style }) {
  const { colors } = useTheme()
  return (
    <View style={[{ flex: 1, backgroundColor: colors.bg }, style]}>
      <Backdrop />
      {children}
    </View>
  )
}

/**
 * The top of a screen: an optional back arrow, a title, and whatever goes at the right
 * (the credits chip on the tabs, an avatar on an influencer).
 */
export function ScreenHeader({ title, onBack, right, left, size = 24, gutter = layout.pageGutter }) {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.header, { paddingTop: insets.top + space.md, paddingHorizontal: gutter }]}>
      <View style={styles.titleRow}>
        {onBack ? (
          <Pressable onPress={onBack} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back" style={styles.back}>
            <Icon name="back" size={22} color={colors.textPrimary} />
          </Pressable>
        ) : null}
        {left}
        {title ? (
          <Text numberOfLines={1} accessibilityRole="header" style={[styles.title, font('bold'), { color: colors.textPrimary, fontSize: size }]}>
            {title}
          </Text>
        ) : null}
      </View>
      {right ? <View style={styles.right}>{right}</View> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: layout.gutter, paddingBottom: space.md, minHeight: 56,
  },
  titleRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.md },
  back: { paddingVertical: 4 },
  title: { flexShrink: 1, letterSpacing: -0.4 },
  right: { marginLeft: space.md },
})
