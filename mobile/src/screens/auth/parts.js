/**
 * Shared pieces for the authentication screens.
 *
 * Four screens with the same skeleton — a title, a couple of fields, one
 * primary action, one error line. Keeping the skeleton here means they cannot
 * drift into four slightly different treatments of the same form.
 *
 * The input defaults matter more than they look. `autoCapitalize="none"` on an
 * email field is the difference between a working sign-in and a mystifying
 * "credentials are not right", because iOS will happily capitalise the first
 * letter of an address and the server is case-sensitive about nothing except
 * the fact that it does not match.
 */

import { forwardRef } from 'react'
import {
  View, Text, TextInput, ScrollView, Pressable, ActivityIndicator,
  StyleSheet, KeyboardAvoidingView, Platform,
} from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useTheme, space, radius } from '../../theme'

/** Page frame: keyboard-aware, scrollable, centred. */
export function AuthShell({ title, subtitle, children, footer }) {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + space.xxl, paddingBottom: insets.bottom + space.xxl },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.textPrimary }]}>{title}</Text>
          {subtitle ? (
            <Text style={[styles.subtitle, { color: colors.textSecondary }]}>{subtitle}</Text>
          ) : null}
        </View>

        <View style={styles.body}>{children}</View>

        {footer ? <View style={styles.footer}>{footer}</View> : null}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

export const Field = forwardRef(function Field(
  { label, hint, error, ...props },
  ref,
) {
  const { colors } = useTheme()
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: colors.textSecondary }]}>{label}</Text>
      <TextInput
        ref={ref}
        placeholderTextColor={colors.textTertiary}
        {...props}
        style={[
          styles.input,
          {
            color: colors.textPrimary,
            borderColor: error ? colors.danger : colors.border,
            backgroundColor: colors.surface,
          },
        ]}
      />
      {error ? (
        <Text style={[styles.fieldError, { color: colors.danger }]}>{error}</Text>
      ) : hint ? (
        <Text style={[styles.hint, { color: colors.textTertiary }]}>{hint}</Text>
      ) : null}
    </View>
  )
})

/** Sensible defaults for an email input, so no screen has to remember them. */
export const emailProps = {
  keyboardType: 'email-address',
  autoCapitalize: 'none',
  autoCorrect: false,
  autoComplete: 'email',
  textContentType: 'emailAddress',
  spellCheck: false,
}

/**
 * `textContentType` is what lets the OS offer a strong password on sign-up and
 * autofill on sign-in. Getting it wrong (or omitting it) quietly disables the
 * password manager, which pushes people towards weaker, memorable passwords.
 */
export const passwordProps = {
  secureTextEntry: true,
  autoCapitalize: 'none',
  autoCorrect: false,
  spellCheck: false,
}

export function PrimaryButton({ title, onPress, loading, disabled }) {
  const { colors } = useTheme()
  const off = disabled || loading

  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      // `busy: false` is still announced as "busy" on Android; only set it when true.
      accessibilityState={loading ? { disabled: true, busy: true } : { disabled: !!off }}
      style={({ pressed }) => ({ opacity: off ? 0.5 : pressed ? 0.85 : 1, marginTop: space.md })}
    >
      <LinearGradient
        colors={colors.brandGradient}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.button}
      >
        {loading
          ? <ActivityIndicator color="#FFFFFF" />
          : <Text style={styles.buttonLabel}>{title}</Text>}
      </LinearGradient>
    </Pressable>
  )
}

export function LinkButton({ title, onPress, align = 'center' }) {
  const { colors } = useTheme()
  return (
    <Pressable onPress={onPress} hitSlop={10} accessibilityRole="link" style={{ alignSelf: align === 'center' ? 'center' : 'flex-start' }}>
      <Text style={[styles.link, { color: colors.brandDeep }]}>{title}</Text>
    </Pressable>
  )
}

/** Form-level error. Kept visually distinct from a per-field error. */
export function FormError({ children }) {
  const { colors } = useTheme()
  if (!children) return null
  return (
    <View style={[styles.errorBox, { borderColor: colors.danger }]}>
      <Text style={[styles.errorText, { color: colors.danger }]}>{children}</Text>
    </View>
  )
}

/** Confirmation, for the "check your inbox" states. */
export function FormNotice({ children }) {
  const { colors } = useTheme()
  if (!children) return null
  return (
    <View style={[styles.errorBox, { borderColor: colors.brand, backgroundColor: colors.brandSoft }]}>
      <Text style={[styles.errorText, { color: colors.textPrimary }]}>{children}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: space.xl, flexGrow: 1, justifyContent: 'center' },
  header: { marginBottom: space.xl },
  title: { fontSize: 28, fontWeight: '800', letterSpacing: -0.6 },
  subtitle: { fontSize: 15, lineHeight: 21, marginTop: space.sm },
  body: { gap: space.xs },
  footer: { marginTop: space.xl, gap: space.md, alignItems: 'center' },

  field: { marginBottom: space.md },
  label: { fontSize: 13, fontWeight: '600', marginBottom: space.xs },
  input: {
    borderWidth: 1.5, borderRadius: radius.md,
    paddingHorizontal: space.md, paddingVertical: space.md,
    fontSize: 16, minHeight: 50,
  },
  hint: { fontSize: 12, marginTop: 4, lineHeight: 16 },
  fieldError: { fontSize: 12, marginTop: 4, lineHeight: 16, fontWeight: '500' },

  button: { paddingVertical: space.md, borderRadius: radius.md, alignItems: 'center', minHeight: 50, justifyContent: 'center' },
  buttonLabel: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },

  link: { fontSize: 14, fontWeight: '600', paddingVertical: space.xs },

  errorBox: { borderWidth: 1, borderRadius: radius.md, padding: space.md, marginBottom: space.md },
  errorText: { fontSize: 13.5, lineHeight: 19 },
})
