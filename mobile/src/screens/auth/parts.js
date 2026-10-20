/**
 * Shared pieces for the authentication screens.
 *
 * Four screens with the same skeleton — the logo, a title, a couple of fields, one primary
 * action, one error line. Keeping the skeleton here means they cannot drift into four slightly
 * different treatments of the same form. The look is the design's: a plain white page, the
 * logo, centred titles and labels, grey pill fields and black pill buttons.
 *
 * The input defaults matter more than they look. `autoCapitalize="none"` on an
 * email field is the difference between a working sign-in and a mystifying
 * "credentials are not right", because iOS will happily capitalise the first
 * letter of an address and the server is case-sensitive about nothing except
 * the fact that it does not match.
 */

import { forwardRef } from 'react'
import {
  View, Text, ScrollView, Pressable, StyleSheet, KeyboardAvoidingView, Platform,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useTheme, space, radius, font, layout } from '../../theme'
import { Button, PillInput } from '../../components/ui'
import { Logo } from '../../components/brand'

/**
 * Page frame: keyboard-aware, scrollable. Content at the top, the footer at the bottom.
 * `hero` is a picture between the logo and the title (the tick of the "check your email" page);
 * `subtitle` may be text with parts in bold.
 */
export function AuthShell({ title, subtitle, hero, children, footer }) {
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
          { paddingTop: insets.top + space.xxl + space.md, paddingBottom: insets.bottom + space.xl },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View>
          <View style={[styles.logo, hero && styles.logoAboveHero]}><Logo height={30} /></View>
          {hero ? <View style={styles.hero}>{hero}</View> : null}

          <View style={styles.header}>
            <Text style={[styles.title, font('bold'), { color: colors.textPrimary }]} accessibilityRole="header">{title}</Text>
            {subtitle ? (
              <Text style={[styles.subtitle, { color: colors.textSecondary }]}>{subtitle}</Text>
            ) : null}
          </View>

          <View style={styles.body}>{children}</View>
        </View>

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
      <Text style={[styles.label, font('medium'), { color: colors.textPrimary }]}>{label}</Text>
      <PillInput ref={ref} tone="auth" error={!!error} style={styles.input} {...props} />
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

/** The screen's one main action: the design's black pill. */
export function PrimaryButton({ title, onPress, loading, disabled }) {
  return (
    <View style={styles.primary}>
      <Button title={title} onPress={onPress} loading={loading} disabled={disabled} variant="dark" />
    </View>
  )
}

/**
 * A text link. With `prefix` it is the design's two-line footer: a plain sentence and, under
 * it, the violet underlined action ("Don't have an account?" / "Sign up").
 */
export function LinkButton({ title, onPress, prefix, align = 'center' }) {
  const { colors } = useTheme()
  return (
    <View style={{ alignItems: align === 'center' ? 'center' : 'flex-start' }}>
      {prefix ? <Text style={[styles.prefix, { color: colors.textPrimary }]}>{prefix}</Text> : null}
      <Pressable onPress={onPress} hitSlop={10} accessibilityRole="link">
        <Text style={[styles.link, font('medium'), { color: colors.link }]}>{title}</Text>
      </Pressable>
    </View>
  )
}

/** Form-level error. Kept visually distinct from a per-field error. */
export function FormError({ children }) {
  const { colors } = useTheme()
  if (!children) return null
  return (
    <View style={[styles.box, { borderColor: colors.danger, backgroundColor: colors.dangerSoft }]}>
      <Text style={[styles.boxText, { color: colors.danger }]}>{children}</Text>
    </View>
  )
}

/** Confirmation, for the "check your inbox" states. */
export function FormNotice({ children }) {
  const { colors } = useTheme()
  if (!children) return null
  return (
    <View style={[styles.box, { borderColor: colors.primary, backgroundColor: colors.accentSoft }]}>
      <Text style={[styles.boxText, { color: colors.textPrimary }]}>{children}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: layout.gutter + 16, flexGrow: 1, justifyContent: 'space-between' },
  logo: { alignItems: 'center', marginBottom: space.xxl + space.md },
  logoAboveHero: { marginBottom: space.xl },
  hero: { alignItems: 'center', marginBottom: space.xl },
  header: { marginBottom: space.lg, alignItems: 'center' },
  title: { fontSize: 22, letterSpacing: -0.3, textAlign: 'center' },
  subtitle: { fontSize: 14, lineHeight: 20, marginTop: space.sm, textAlign: 'center' },
  body: { gap: space.xs },
  footer: { marginTop: space.xxl, gap: space.md, alignItems: 'center' },

  field: { marginBottom: space.md },
  label: { fontSize: 15, marginBottom: space.sm, textAlign: 'center' },
  input: {},
  hint: { fontSize: 12, marginTop: 6, lineHeight: 16, textAlign: 'center' },
  fieldError: { fontSize: 12, marginTop: 6, lineHeight: 16, fontWeight: '500', textAlign: 'center' },

  primary: { marginTop: space.md },

  prefix: { fontSize: 15, marginBottom: 2 },
  link: { fontSize: 15, textDecorationLine: 'underline', paddingVertical: space.xs },

  box: { borderWidth: 1, borderRadius: radius.md, padding: space.md, marginBottom: space.md },
  boxText: { fontSize: 13.5, lineHeight: 19, textAlign: 'center' },
})
