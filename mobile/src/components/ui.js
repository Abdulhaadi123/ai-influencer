/**
 * Small shared UI primitives for the native screens.
 *
 * Deliberately plain React Native — no styling library — so the pieces stay
 * obvious and every screen ends up visually consistent.
 */

import { useState } from 'react'
import { View, Text, Pressable, StyleSheet, LayoutAnimation, Platform, UIManager } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import { useTheme, space, radius } from '../theme'

// LayoutAnimation needs opting in on Android for the collapse to animate.
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true)
}

/** A grouped settings-style section, the standard iOS/Android list idiom. */
export function Section({ title, footer, children }) {
  const { colors } = useTheme()
  return (
    <View style={styles.sectionWrap}>
      {title ? (
        <Text style={[styles.sectionTitle, { color: colors.textTertiary }]}>
          {title.toUpperCase()}
        </Text>
      ) : null}
      <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.borderSubtle }]}>
        {children}
      </View>
      {footer ? (
        <Text style={[styles.sectionFooter, { color: colors.textTertiary }]}>{footer}</Text>
      ) : null}
    </View>
  )
}

/** One row inside a Section. Becomes tappable when `onPress` is supplied. */
export function Row({ label, value, right, onPress, last = false }) {
  const { colors } = useTheme()
  const body = (
    <View style={[styles.row, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSubtle }]}>
      <Text style={[styles.rowLabel, { color: colors.textPrimary }]} numberOfLines={1}>{label}</Text>
      <View style={styles.rowRight}>
        {value != null ? (
          <Text style={[styles.rowValue, { color: colors.textSecondary }]} numberOfLines={1}>{value}</Text>
        ) : null}
        {right}
      </View>
    </View>
  )

  if (!onPress) return body
  return (
    <Pressable onPress={onPress} android_ripple={{ color: colors.borderSubtle }}
      style={({ pressed }) => [pressed && { backgroundColor: colors.surfaceAlt }]}>
      {body}
    </Pressable>
  )
}

/** A small coloured status dot + label, used for the engine state. */
export function StatusPill({ ok, children }) {
  const { colors } = useTheme()
  const tint = ok ? colors.success : colors.danger
  return (
    <View style={styles.statusWrap}>
      <View style={[styles.dot, { backgroundColor: tint }]} />
      <Text style={[styles.statusText, { color: tint }]}>{children}</Text>
    </View>
  )
}

/** iOS-style segmented control — the native idiom for a small exclusive choice. */
export function Segmented({ options, value, onChange }) {
  const { colors } = useTheme()
  return (
    <View style={[styles.segment, { backgroundColor: colors.surfaceAlt, borderColor: colors.borderSubtle }]}>
      {options.map(opt => {
        const active = opt.value === value
        return (
          <Pressable
            key={opt.value}
            onPress={() => onChange(opt.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            style={[
              styles.segmentItem,
              active && { backgroundColor: colors.surface, borderColor: colors.brand },
            ]}
          >
            <Text
              style={[
                styles.segmentLabel,
                { color: active ? colors.brandDeep : colors.textSecondary },
                active && styles.segmentLabelActive,
              ]}
            >
              {opt.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

/**
 * A collapsed group of secondary settings.
 *
 * The studio has more knobs than fit comfortably on a phone, so only the
 * essentials stay visible and the rest live behind this — the same call the
 * web studio makes with its "Advanced Settings" disclosure.
 */
export function Collapsible({ title, subtitle, children, initiallyOpen = false }) {
  const { colors } = useTheme()
  const [open, setOpen] = useState(initiallyOpen)

  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
    setOpen(o => !o)
  }

  return (
    <View style={styles.sectionWrap}>
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [
          styles.collapsibleHead,
          {
            backgroundColor: colors.surface,
            borderColor: colors.borderSubtle,
            borderBottomLeftRadius: open ? 0 : radius.lg,
            borderBottomRightRadius: open ? 0 : radius.lg,
            opacity: pressed ? 0.9 : 1,
          },
        ]}
      >
        <View style={styles.flex}>
          <Text style={[styles.collapsibleTitle, { color: colors.textPrimary }]}>{title}</Text>
          {subtitle ? (
            <Text style={[styles.collapsibleSub, { color: colors.textTertiary }]} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        <Text style={[styles.caret, { color: colors.textTertiary }]}>{open ? '⌄' : '›'}</Text>
      </Pressable>

      {open ? (
        <View style={[styles.collapsibleBody, { backgroundColor: colors.surface, borderColor: colors.borderSubtle }]}>
          {children}
        </View>
      ) : null}
    </View>
  )
}

/** A labelled row inside a Collapsible — keeps the groups visually even. */
export function Field({ label, hint, children }) {
  const { colors } = useTheme()
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{label}</Text>
      {hint ? <Text style={[styles.fieldHint, { color: colors.textTertiary }]}>{hint}</Text> : null}
      <View style={styles.fieldBody}>{children}</View>
    </View>
  )
}

export function Button({ title, onPress, variant = 'primary', disabled }) {
  const { colors } = useTheme()
  const isPrimary = variant === 'primary'
  const isDanger = variant === 'danger'

  const label = (
    <Text style={[styles.buttonLabel, {
      color: isPrimary ? '#FFFFFF' : isDanger ? colors.danger : colors.textPrimary,
    }]}>
      {title}
    </Text>
  )

  // Primary actions carry the brand gradient the web uses on its CTAs.
  if (isPrimary) {
    return (
      <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button"
        style={({ pressed }) => ({ opacity: disabled ? 0.45 : pressed ? 0.85 : 1 })}>
        <LinearGradient
          colors={colors.brandGradient}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.button}
        >
          {label}
        </LinearGradient>
      </Pressable>
    )
  }

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: isDanger ? 'transparent' : colors.surfaceAlt,
          borderColor: isDanger ? colors.danger : 'transparent',
          borderWidth: isDanger ? StyleSheet.hairlineWidth : 0,
          opacity: disabled ? 0.45 : pressed ? 0.85 : 1,
        },
      ]}
    >
      {label}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  sectionWrap: { marginBottom: space.xl },
  sectionTitle: { fontSize: 12, fontWeight: '600', letterSpacing: 0.6, marginBottom: space.sm, marginLeft: space.xs },
  section: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  sectionFooter: { fontSize: 12, lineHeight: 17, marginTop: space.sm, marginHorizontal: space.xs },

  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.lg, paddingVertical: space.md, minHeight: 48, gap: space.md },
  rowLabel: { fontSize: 15, flexShrink: 1 },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexShrink: 1 },
  rowValue: { fontSize: 15, flexShrink: 1 },

  statusWrap: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 14, fontWeight: '600' },

  segment: { flexDirection: 'row', borderRadius: radius.md, padding: 3, gap: 3, borderWidth: StyleSheet.hairlineWidth },
  segmentItem: { flex: 1, paddingVertical: space.sm, borderRadius: radius.sm, alignItems: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: 'transparent' },
  segmentLabel: { fontSize: 14 },
  segmentLabelActive: { fontWeight: '600' },

  button: { paddingVertical: space.md, paddingHorizontal: space.xl, borderRadius: radius.md, alignItems: 'center' },
  buttonLabel: { fontSize: 15, fontWeight: '600' },

  flex: { flex: 1 },
  collapsibleHead: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingHorizontal: space.lg, paddingVertical: space.md, minHeight: 54,
    borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth,
  },
  collapsibleTitle: { fontSize: 15, fontWeight: '600' },
  collapsibleSub: { fontSize: 12.5, marginTop: 2 },
  caret: { fontSize: 18, lineHeight: 20 },
  collapsibleBody: {
    borderWidth: StyleSheet.hairlineWidth, borderTopWidth: 0,
    borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg,
    paddingHorizontal: space.lg, paddingBottom: space.lg,
  },

  field: { paddingTop: space.lg },
  fieldLabel: { fontSize: 13, fontWeight: '600' },
  fieldHint: { fontSize: 12, marginTop: 2, lineHeight: 16 },
  fieldBody: { marginTop: space.sm },
})
