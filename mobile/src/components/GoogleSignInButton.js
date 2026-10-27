/**
 * "Continue with Google": the button, and the one thing it does.
 *
 * Tapping it opens Google's account picker; the account chosen is signed in (or, the first time, made)
 * through the server (core/auth/index.js signInWithGoogle). It signs in AND signs up: there is no
 * separate "sign up with Google", because the person's Google address is all the server needs.
 *
 * Drawn only when this build was given the Web client ID (core/config/env.js GOOGLE_WEB_CLIENT_ID), so a build
 * without it simply has email sign-in, as before. Closing the picker is not an error and shows nothing; any
 * other failure is given to `onError` in words for the person, which the screen shows in its own error box.
 *
 * The white pill with the coloured "G" is Google's own look for this button (their branding guidelines allow
 * no other colours or letter forms), so it is the same in the light and dark themes.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import Svg, { Path } from 'react-native-svg'

import { useAuth } from '@core/auth/AuthContext'
import { GOOGLE_CANCELLED } from '@core/auth'
import { userMessage } from '@core/errors'

import { useTheme, space, font } from '../theme'
import { Button } from './ui'

/** Google's "G", in its four colours. */
export function GoogleG({ size = 20 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48" accessibilityElementsHidden importantForAccessibility="no">
      <Path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <Path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <Path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <Path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </Svg>
  )
}

/**
 * @param {{onError?: (message: string|null) => void, title?: string, divider?: boolean}} props
 *        divider  draw an "or" line above the button (under an email form)
 */
export default function GoogleSignInButton({ onError, title = 'Continue with Google', divider = false }) {
  const { colors } = useTheme()
  const { signInWithGoogle, googleAvailable } = useAuth()
  const [busy, setBusy] = useState(false)
  // Signing in swaps the whole navigator, so this button is usually gone by the time the call returns.
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const press = useCallback(async () => {
    if (busy) return
    setBusy(true)
    onError?.(null)
    try {
      await signInWithGoogle()
    } catch (e) {
      if (e?.code !== GOOGLE_CANCELLED) onError?.(userMessage(e, 'Could not sign in with Google. Please try again.'))
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [busy, onError, signInWithGoogle])

  if (!googleAvailable) return null

  return (
    <View>
      {divider ? (
        <View style={styles.divider} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <View style={[styles.rule, { backgroundColor: colors.border }]} />
          <Text style={[styles.or, font('regular'), { color: colors.textTertiary }]}>or</Text>
          <View style={[styles.rule, { backgroundColor: colors.border }]} />
        </View>
      ) : null}
      <Button
        title={title}
        variant="secondary"
        icon={<GoogleG />}
        onPress={press}
        loading={busy}
        style={styles.button}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  // Google's button has a thin grey edge, so the white pill is still there on a white page.
  button: { borderColor: '#DADCE0' },
  divider: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginVertical: space.lg },
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
  or: { fontSize: 13 },
})
