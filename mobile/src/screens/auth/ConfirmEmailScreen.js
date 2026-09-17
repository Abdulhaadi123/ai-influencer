/**
 * Finish a sign-up confirmation link.
 *
 * The email opens `aiinfluencer://confirm-email?code=…`. By the time it does,
 * Supabase has already confirmed the address — the code only signs the user in,
 * so a successful exchange takes them straight into the app: the auth gate
 * swaps navigators on SIGNED_IN and this screen unmounts.
 *
 * Three other outcomes, and they must not be confused:
 *
 *   • the code cannot be used on this phone (opened on another device, or a
 *     newer email request replaced the one-time check) — the account IS
 *     confirmed, so the screen says "sign in", not "that failed";
 *   • Supabase refused the link itself (expired, already used) and sent
 *     `error_code` instead of a code — a new link is offered;
 *   • no connection — the same code can simply be tried again.
 *
 * This used to be the reset-password screen: sign-up shared its link, so
 * confirming an account opened "Choose a new password".
 */

import { useCallback, useEffect, useState } from 'react'
import { View, ActivityIndicator } from 'react-native'

import { useAuth } from '@core/auth/AuthContext'
import { completeEmailConfirmation } from '@core/auth'
import { userMessage } from '@core/errors'

import { useTheme } from '../../theme'
import {
  AuthShell, Field, PrimaryButton, LinkButton, FormError, FormNotice, emailProps,
} from './parts'

export default function ConfirmEmailScreen({ navigation, route }) {
  const { colors } = useTheme()
  const { resendConfirmation } = useAuth()

  const code = route?.params?.code ?? null
  // Supabase redirects with these instead of a code when it refused the link.
  const linkRefused = !!(route?.params?.error_code || route?.params?.error_description || route?.params?.error)

  /** working | confirmed | refused | offline */
  const [status, setStatus] = useState(linkRefused ? 'refused' : 'working')
  const [attempt, setAttempt] = useState(0)
  const [error, setError] = useState(null)

  const [email, setEmail] = useState('')
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (linkRefused) return
    let cancelled = false
    setStatus('working')
    setError(null)
    ;(async () => {
      try {
        const outcome = await completeEmailConfirmation(code)
        // 'signed-in' needs nothing here: the navigator is already swapping.
        if (!cancelled && outcome === 'confirmed') setStatus('confirmed')
      } catch (e) {
        if (cancelled) return
        setError(userMessage(e, 'That confirmation link could not be opened.'))
        // With a code, the failure was the connection and the same code can be
        // tried again. Without one there is nothing to retry.
        setStatus(code ? 'offline' : 'refused')
      }
    })()
    return () => { cancelled = true }
  }, [code, linkRefused, attempt])

  const resend = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await resendConfirmation(email)
      // Worded for both cases on purpose — see resendConfirmation.
      setNotice(`If ${email.trim()} still needs confirming, a new link is on its way.`)
    } catch (e) {
      setError(userMessage(e, 'Could not send a new link. Please try again.'))
    } finally {
      setBusy(false)
    }
  }, [busy, email, resendConfirmation])

  const toSignIn = <LinkButton title="Go to sign in" onPress={() => navigation.navigate('SignIn')} />

  if (status === 'working') {
    return (
      <AuthShell title="Confirming your email" subtitle="One moment…">
        <ActivityIndicator size="large" color={colors.brand} />
      </AuthShell>
    )
  }

  if (status === 'confirmed') {
    return (
      <AuthShell
        title="Email confirmed"
        subtitle="Your account is ready. Sign in with your email and password to continue."
      >
        <View>
          <PrimaryButton title="Sign in" onPress={() => navigation.navigate('SignIn')} />
        </View>
      </AuthShell>
    )
  }

  if (status === 'offline') {
    return (
      <AuthShell title="Could not finish confirming" subtitle="Your link is fine — the app just could not reach the server." footer={toSignIn}>
        <FormError>{error}</FormError>
        <View>
          <PrimaryButton title="Try again" onPress={() => setAttempt(n => n + 1)} />
        </View>
      </AuthShell>
    )
  }

  return (
    <AuthShell
      title="That link did not work"
      subtitle="Confirmation links expire and work only once. If you already confirmed, just sign in. Otherwise we can send a new one."
      footer={toSignIn}
    >
      <FormError>{error}</FormError>
      <FormNotice>{notice}</FormNotice>

      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        placeholder="you@example.com"
        returnKeyType="go"
        onSubmitEditing={resend}
        {...emailProps}
      />

      <View>
        <PrimaryButton title="Send a new link" onPress={resend} loading={busy} disabled={!email.trim()} />
      </View>
    </AuthShell>
  )
}
