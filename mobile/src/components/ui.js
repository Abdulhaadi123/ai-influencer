/**
 * Shared UI primitives — the Influenza look in one place.
 *
 * Deliberately plain React Native plus expo-linear-gradient: no styling library, so every
 * piece stays obvious and every screen ends up visually consistent. The vocabulary is the
 * design's own:
 *
 *   • GlassCard / Section  frosted, translucent cards over the page's glows
 *   • Button               fully rounded pills: violet (primary), black (auth), white, lavender, red
 *   • PillInput            the rounded, tinted text field
 *   • Segmented            the rounded bar of pills (influencer tabs, appearance)
 *   • Chip                 a small filter pill
 *
 * Names and props of the pieces that existed before (Section, Row, StatusPill, Segmented,
 * Collapsible, Field, Button) are unchanged, so a screen written against them keeps working.
 */

import { forwardRef, useState } from 'react'
import {
  View, Text, Pressable, TextInput, ActivityIndicator, StyleSheet,
  LayoutAnimation, Platform, UIManager,
} from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'

import { useTheme, space, radius, layout, font } from '../theme'
import Icon from './icons'
import PulseBadge from './PulseBadge'

// LayoutAnimation needs opting in on Android for the collapse to animate.
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true)
}

/* ── Cards ─────────────────────────────────────────────────────────────── */

/**
 * A frosted card. `tone`: 'glass' (lavender, the default), 'surface' (near-white) or
 * 'strong' (the deep violet rows of the influencer list).
 */
export function GlassCard({ children, tone = 'glass', style, radiusSize = radius.lg }) {
  const { colors } = useTheme()
  const fill = tone === 'surface' ? colors.surface : tone === 'strong' ? colors.glassStrong : colors.glass
  return (
    <View style={[styles.card, { backgroundColor: fill, borderColor: colors.glassEdge, borderRadius: radiusSize }, style]}>
      {tone !== 'strong' ? (
        // The sheen: a soft light coming from the top left, which is what makes it glass.
        <LinearGradient
          pointerEvents="none"
          colors={[colors.isDark ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.42)', 'rgba(255,255,255,0)']}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      {children}
    </View>
  )
}

/** A titled group: a small label above a glass card. */
export function Section({ title, footer, children, tone }) {
  const { colors } = useTheme()
  return (
    <View style={styles.sectionWrap}>
      {title ? (
        <Text style={[styles.sectionTitle, font('medium'), { color: colors.textPrimary }]}>{title}</Text>
      ) : null}
      <GlassCard tone={tone}>{children}</GlassCard>
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
    <View style={styles.row}>
      <Text style={[styles.rowLabel, font('regular'), { color: colors.textPrimary }]} numberOfLines={1}>{label}</Text>
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
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [pressed && { opacity: 0.7 }]}>
      {body}
    </Pressable>
  )
}

/** A small coloured status dot + label. */
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

/* ── Choosing ──────────────────────────────────────────────────────────── */

/**
 * The rounded bar of pills: the influencer's Profile / Videos / Motion / Gallery, and the
 * Light / Dark choice. The chosen pill is tinted and outlined; the others are white.
 */
export function Segmented({ options, value, onChange }) {
  const { colors } = useTheme()
  return (
    <View style={[styles.segment, { backgroundColor: colors.glass, borderColor: colors.glassEdge }]}>
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
              // An option may carry its own fill (the Appearance choice shows Dark as a dark pill).
              active
                ? { backgroundColor: opt.fill || colors.accentSoft, borderColor: colors.primary }
                : { backgroundColor: opt.fill || (colors.isDark ? 'rgba(255,255,255,0.10)' : '#FFFFFF'), borderColor: 'transparent' },
            ]}
          >
            <Text
              numberOfLines={1}
              style={[
                styles.segmentLabel,
                active ? font('semibold') : font('regular'),
                { color: opt.onFill || (active ? colors.primary : colors.textPrimary) },
              ]}
            >
              {opt.label}
            </Text>
            {/* A count of what is new in this tab since it was last opened (the Gallery's results). */}
            {opt.badge > 0 ? <PulseBadge count={opt.badge} style={styles.segmentBadge} /> : null}
          </Pressable>
        )
      })}
    </View>
  )
}

/** A small filter pill (the gallery's All / Videos / Images). */
export function Chip({ label, active, onPress, disabled }) {
  const { colors } = useTheme()
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active, disabled: !!disabled }}
      style={[
        styles.chip,
        active
          ? { backgroundColor: colors.accentSoft, borderColor: colors.primary }
          : { backgroundColor: colors.surfaceAlt, borderColor: 'transparent' },
        disabled && { opacity: 0.45 },
      ]}
    >
      <Text style={[styles.chipLabel, font(active ? 'semibold' : 'medium'), { color: active ? colors.primary : colors.textSecondary }]}>
        {label}
      </Text>
    </Pressable>
  )
}

/**
 * The design's large two-way choice (Male / Female): a pill as tall as an input, and the
 * chosen one is white with a violet outline.
 */
export function ChoicePill({ label, active, onPress, disabled }) {
  const { colors } = useTheme()
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active, disabled: !!disabled }}
      style={[
        styles.choice,
        active
          ? { backgroundColor: colors.isDark ? 'rgba(255,255,255,0.92)' : '#FFFFFF', borderColor: colors.primary }
          : { backgroundColor: colors.field, borderColor: colors.glassEdge },
        disabled && { opacity: 0.5 },
      ]}
    >
      <Text style={[styles.choiceLabel, font(active ? 'medium' : 'regular'), { color: active ? colors.primary : colors.textTertiary }]}>
        {label}
      </Text>
    </Pressable>
  )
}

/**
 * A collapsed group of secondary settings. The studio has more knobs than fit comfortably
 * on a phone, so only the essentials stay visible and the rest live behind this.
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
      <GlassCard>
        <Pressable
          onPress={toggle}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          style={({ pressed }) => [styles.collapsibleHead, { opacity: pressed ? 0.8 : 1 }]}
        >
          <View style={styles.flex}>
            <Text style={[styles.collapsibleTitle, font('semibold'), { color: colors.textPrimary }]}>{title}</Text>
            {subtitle ? (
              <Text style={[styles.collapsibleSub, { color: colors.textSecondary }]} numberOfLines={1}>{subtitle}</Text>
            ) : null}
          </View>
          <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}>
            <Icon name="chevron" size={18} color={colors.textSecondary} />
          </View>
        </Pressable>
        {open ? <View style={styles.collapsibleBody}>{children}</View> : null}
      </GlassCard>
    </View>
  )
}

/** A labelled row inside a Collapsible — keeps the groups visually even. */
export function Field({ label, hint, children }) {
  const { colors } = useTheme()
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, font('medium'), { color: colors.textPrimary }]}>{label}</Text>
      {hint ? <Text style={[styles.fieldHint, { color: colors.textSecondary }]}>{hint}</Text> : null}
      <View style={styles.fieldBody}>{children}</View>
    </View>
  )
}

/**
 * A titled block WITHOUT a card around it: the label above, the field itself (which is its
 * own tinted shape) and a quiet note below. The label sits in line with the text typed
 * inside the field, as in the design's forms.
 */
export function Block({ title, footer, children }) {
  const { colors } = useTheme()
  return (
    <View style={styles.block}>
      {title ? <Text style={[styles.blockTitle, font('regular'), { color: colors.textPrimary }]}>{title}</Text> : null}
      {children}
      {footer ? <Text style={[styles.blockFooter, { color: colors.textTertiary }]}>{footer}</Text> : null}
    </View>
  )
}

/** A message in a rounded box: `tone` is 'error', 'info' (the default) or 'warn'. */
export function Notice({ tone = 'info', children, style }) {
  const { colors } = useTheme()
  const look = {
    error: { bg: colors.dangerSoft, border: colors.danger, fg: colors.danger },
    warn: { bg: colors.surfaceAlt, border: colors.border, fg: colors.textSecondary },
    info: { bg: colors.glass, border: colors.glassEdge, fg: colors.textPrimary },
  }[tone]
  return (
    <View style={[styles.notice, { backgroundColor: look.bg, borderColor: look.border }, style]}>
      <Text style={[styles.noticeText, { color: look.fg }]}>{children}</Text>
    </View>
  )
}

/** A thin progress bar; `value` is 0-100. */
export function ProgressBar({ value }) {
  const { colors } = useTheme()
  return (
    <View style={[styles.track, { backgroundColor: colors.surfaceAlt }]}>
      <View style={[styles.fill, { width: `${Math.max(3, Math.min(100, value || 0))}%`, backgroundColor: colors.primary }]} />
    </View>
  )
}

/* ── Inputs ────────────────────────────────────────────────────────────── */

/**
 * The design's text field: a tinted, fully rounded bar (a taller, softer box when it holds
 * more than a line). `tone="auth"` is the plain grey one the sign-in screens use.
 */
export const PillInput = forwardRef(function PillInput({ multiline, error, tone, style, secureTextEntry, ...props }, ref) {
  const { colors } = useTheme()
  const auth = tone === 'auth'
  // A password field has an eye at its end to show what was typed. (Every field takes the same
  // props as before; only one that asks for `secureTextEntry` is wrapped.)
  const [shown, setShown] = useState(false)

  const input = (
    <TextInput
      ref={ref}
      multiline={multiline}
      placeholderTextColor={auth ? colors.textTertiary : colors.placeholder}
      {...props}
      secureTextEntry={secureTextEntry ? !shown : undefined}
      style={[
        styles.input,
        multiline && styles.inputMultiline,
        {
          color: colors.textPrimary,
          backgroundColor: auth ? colors.fieldAuth : colors.field,
          borderColor: error ? colors.danger : auth ? 'transparent' : colors.glassEdge,
        },
        style,
        // An email address or a password is typed left to right, from the left, whatever the phone's
        // language. (The sign-in screens used to centre the text, so typing began in the middle.) Other
        // fields — a description in someone's own language — keep the platform's own direction.
        (auth || secureTextEntry) && styles.inputLeft,
        secureTextEntry && styles.inputWithEye,
      ]}
    />
  )
  if (!secureTextEntry) return input

  return (
    <View>
      {input}
      <Pressable
        onPress={() => setShown(s => !s)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={shown ? 'Hide password' : 'Show password'}
        style={styles.eye}
      >
        <Icon name={shown ? 'eyeOff' : 'eye'} size={21} color={colors.textTertiary} />
      </Pressable>
    </View>
  )
})

/* ── Buttons ───────────────────────────────────────────────────────────── */

/**
 * Fully rounded buttons. `variant`:
 *   primary    deep violet (the default action)
 *   dark       black — the sign-in screens' main action
 *   secondary  white
 *   soft       lavender, translucent (a quieter second action next to a primary)
 *   neutral    the plain grey of the sign-in screens' fields
 *   danger     red on a pink wash
 * `size="sm"` is the 40 px height used inside cards.
 */
export function Button({ title, onPress, variant = 'primary', disabled, loading, size, icon, style }) {
  const { colors } = useTheme()
  const look = {
    primary:   { bg: colors.primary, fg: colors.onPrimary, border: 'transparent' },
    dark:      { bg: colors.ink, fg: colors.onInk, border: 'transparent' },
    secondary: { bg: colors.isDark ? 'rgba(255,255,255,0.92)' : '#FFFFFF', fg: '#0B0A1E', border: 'transparent' },
    soft:      { bg: colors.glass, fg: colors.primary, border: colors.glassEdge },
    neutral:   { bg: colors.fieldAuth, fg: colors.textPrimary, border: 'transparent' },
    danger:    { bg: colors.dangerSoft, fg: colors.danger, border: colors.danger },
  }[variant] || { bg: colors.primary, fg: colors.onPrimary, border: 'transparent' }

  const off = disabled || loading
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={title}
      // `busy: false` is still announced as "busy" on Android; only set it when true.
      accessibilityState={loading ? { disabled: true, busy: true } : { disabled: !!off }}
      style={({ pressed }) => [
        styles.button,
        size === 'sm' && styles.buttonSmall,
        { backgroundColor: look.bg, borderColor: look.border, opacity: off ? 0.5 : pressed ? 0.85 : 1 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={look.fg} />
      ) : (
        <View style={styles.buttonInner}>
          {icon}
          <Text style={[styles.buttonLabel, size === 'sm' && styles.buttonLabelSmall, font('medium'), { color: look.fg }]} numberOfLines={1}>
            {title}
          </Text>
        </View>
      )}
    </Pressable>
  )
}

/* ── Empty / message states ────────────────────────────────────────────── */

/** A centred "nothing here" (or "could not load") block with an optional action. */
export function EmptyState({ icon = 'sparkle', title, body, actionTitle, onAction }) {
  const { colors } = useTheme()
  return (
    <View style={styles.empty}>
      <View style={[styles.emptyIcon, { backgroundColor: colors.glass, borderColor: colors.glassEdge }]}>
        <Icon name={icon} size={30} color={colors.primary} />
      </View>
      <Text style={[styles.emptyTitle, font('bold'), { color: colors.textPrimary }]}>{title}</Text>
      {body ? <Text style={[styles.emptyBody, { color: colors.textSecondary }]}>{body}</Text> : null}
      {actionTitle ? (
        <View style={styles.emptyAction}>
          <Button title={actionTitle} onPress={onAction} />
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, overflow: 'hidden' },

  sectionWrap: { marginBottom: space.xl },
  sectionTitle: { fontSize: 15, marginBottom: space.sm, marginLeft: space.xs },
  sectionFooter: { fontSize: 12, lineHeight: 17, marginTop: space.sm, marginHorizontal: space.xs },

  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.lg + 2, paddingVertical: space.sm + 2, minHeight: 40, gap: space.md },
  rowLabel: { fontSize: 14, flexShrink: 1 },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexShrink: 1 },
  rowValue: { fontSize: 14, flexShrink: 1 },

  statusWrap: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 14, fontWeight: '600' },

  segment: { flexDirection: 'row', borderRadius: 22, padding: 10, gap: 10, borderWidth: 1 },
  segmentItem: { flex: 1, height: 36, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', borderWidth: 1, paddingHorizontal: 4 },
  segmentLabel: { fontSize: 13 },
  segmentBadge: { top: -9, right: -3 },

  chip: { paddingVertical: 6, paddingHorizontal: 14, borderRadius: radius.pill, borderWidth: 1 },
  chipLabel: { fontSize: 12.5 },

  choice: { flex: 1, minHeight: layout.controlHeight, borderRadius: radius.pill, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  choiceLabel: { fontSize: 15 },

  block: { marginBottom: space.xl + 2 },
  blockTitle: { fontSize: 16, marginBottom: 10, marginLeft: space.xl - 2 },
  blockFooter: { fontSize: 12, lineHeight: 17, marginTop: space.sm, marginHorizontal: space.xl - 2 },

  notice: { borderWidth: 1, borderRadius: radius.md, padding: space.md + 2, marginBottom: space.xl },
  noticeText: { fontSize: 13, lineHeight: 19 },

  track: { height: 6, borderRadius: radius.pill, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: radius.pill },

  flex: { flex: 1 },
  collapsibleHead: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg + 2, paddingVertical: space.md, minHeight: 58 },
  collapsibleTitle: { fontSize: 15 },
  collapsibleSub: { fontSize: 12.5, marginTop: 2 },
  collapsibleBody: { paddingHorizontal: space.lg + 2, paddingBottom: space.lg },

  field: { paddingTop: space.lg },
  fieldLabel: { fontSize: 14 },
  fieldHint: { fontSize: 12, marginTop: 2, lineHeight: 16 },
  fieldBody: { marginTop: space.sm },

  input: {
    borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: space.xl - 2,
    fontSize: 15, minHeight: layout.controlHeight,
  },
  inputMultiline: { borderRadius: radius.lg, minHeight: 110, paddingTop: space.md + 2, paddingBottom: space.md, textAlignVertical: 'top' },
  inputLeft: { textAlign: 'left', writingDirection: 'ltr' },
  inputWithEye: { paddingRight: 54 },
  eye: { position: 'absolute', right: 8, top: 0, bottom: 0, width: 42, alignItems: 'center', justifyContent: 'center' },

  button: { minHeight: layout.controlHeight, borderRadius: radius.pill, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.xl },
  buttonSmall: { minHeight: 40, paddingHorizontal: space.lg },
  buttonInner: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  buttonLabel: { fontSize: 16 },
  buttonLabelSmall: { fontSize: 14 },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.xxl, gap: space.sm },
  emptyIcon: { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center', marginBottom: space.md, borderWidth: 1 },
  emptyTitle: { fontSize: 20, letterSpacing: -0.3, textAlign: 'center' },
  emptyBody: { fontSize: 14, lineHeight: 21, textAlign: 'center' },
  emptyAction: { alignSelf: 'stretch', marginTop: space.lg },
})
