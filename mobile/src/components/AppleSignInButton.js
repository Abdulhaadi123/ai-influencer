/**
 * "Continue with Apple": the button, and the one thing it does.
 *
 * Tapping it opens Apple's own sheet; the Apple Account chosen is signed in (or, the first time, made) through
 * the server (core/auth/index.js signInWithApple). It signs in AND signs up: there is no separate "sign up with
 * Apple", because the address Apple shares (or its private relay for it) is all the server needs.
 *
 * Drawn only on an iPhone. The button itself is Apple's own native control (expo-apple-authentication): the App
 * Store requires Apple's look for it, so only the style (black on a light page, white on a dark one) and the corner
 * radius are ours. It is as tall as the other buttons on the page and sits above them, as the guidelines ask.
 * Closing the sheet is not an error and shows nothing; any other failure is given to `onError` in words for the
 * person, which the screen shows in its own error box.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { View, StyleSheet } from 'react-native'

import { useAuth } from '@core/auth/AuthContext'
import { APPLE_CANCELLED } from '@core/auth'
import { userMessage } from '@core/errors'

import { useTheme, layout } from '../theme'

/** The native library, or null in a build that does not have it (it is only linked into an iPhone build made after it was added). */
function loadLibrary() {
  try {
    return require('expo-apple-authentication')
  } catch (e) {
    console.warn('[apple] the button library is not in this build:', e?.message ?? e)
    return null
  }
}

/**
 * @param {{onError?: (message: string|null) => void}} props
 */
export default function AppleSignInButton({ onError }) {
  const { scheme } = useTheme()
  const { signInWithApple, appleAvailable } = useAuth()
  const [busy, setBusy] = useState(false)
  // Signing in swaps the whole navigator, so this button is usually gone by the time the call returns.
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const press = useCallback(async () => {
    if (busy) return
    setBusy(true)
    onError?.(null)
    try {
      await signInWithApple()
    } catch (e) {
      if (e?.code !== APPLE_CANCELLED) onError?.(userMessage(e, 'Could not sign in with Apple. Please try again.'))
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [busy, onError, signInWithApple])

  if (!appleAvailable) return null
  const lib = loadLibrary()
  if (!lib) return null

  return (
    <View style={busy ? styles.busy : null} pointerEvents={busy ? 'none' : 'auto'}>
      <lib.AppleAuthenticationButton
        buttonType={lib.AppleAuthenticationButtonType.CONTINUE}
        buttonStyle={scheme === 'dark' ? lib.AppleAuthenticationButtonStyle.WHITE : lib.AppleAuthenticationButtonStyle.BLACK}
        cornerRadius={layout.controlHeight / 2}
        style={styles.button}
        onPress={press}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  button: { width: '100%', height: layout.controlHeight },
  busy: { opacity: 0.5 },
})
