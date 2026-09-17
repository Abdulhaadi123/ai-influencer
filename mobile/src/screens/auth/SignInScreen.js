/**
 * Sign in.
 *
 * The error copy here is deliberately vague — "that email and password
 * combination is not right" rather than "no account with that email". Telling
 * someone which half was wrong turns the form into a way to test whether an
 * address is registered, which is the first step of a credential-stuffing run.
 */

import { useCallback, useRef, useState } from 'react'
import { View } from 'react-native'

import { useAuth } from '@core/auth/AuthContext'
import { EMAIL_NOT_CONFIRMED } from '@core/auth'

import { userMessage } from '@core/errors'

import { AuthShell, Field, PrimaryButton, LinkButton, FormError, FormNotice, emailProps, passwordProps } from './parts'

export default function SignInScreen({ navigation }) {
  // `notice` explains a sign-out the app did, not the user — a session that ended.
  const { signIn, notice, clearNotice, resendConfirmation } = useAuth()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  // Set when sign-in failed only because the email is not confirmed yet. Without
  // a way to ask for the email again, someone whose message never arrived had
  // no way into their account.
  const [unconfirmed, setUnconfirmed] = useState(false)
  const [resent, setResent] = useState(null)
  const [resending, setResending] = useState(false)

  const passwordRef = useRef(null)

  const submit = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    setUnconfirmed(false)
    setResent(null)
    clearNotice()
    try {
      await signIn({ email, password })
      // No navigation call. The auth gate swaps the whole navigator once the
      // session lands, so pushing a route here would fight it.
    } catch (e) {
      setUnconfirmed(e?.code === EMAIL_NOT_CONFIRMED)
      setError(userMessage(e, 'Could not sign in. Please try again.'))
    } finally {
      setBusy(false)
    }
  }, [busy, email, password, signIn])

  const resend = useCallback(async () => {
    if (resending) return
    setResending(true)
    setError(null)
    try {
      await resendConfirmation(email)
      setResent(`A new confirmation link is on its way to ${email.trim()}. Open it, then sign in here.`)
    } catch (e) {
      setError(userMessage(e, 'Could not send the email. Please try again.'))
    } finally {
      setResending(false)
    }
  }, [resending, email, resendConfirmation])

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to reach your influencers, generations and gallery."
      footer={
        <>
          <LinkButton title="Forgot your password?" onPress={() => navigation.navigate('ForgotPassword')} />
          <LinkButton title="No account? Create one" onPress={() => navigation.navigate('SignUp')} />
        </>
      }
    >
      <FormNotice>{notice}</FormNotice>
      <FormError>{error}</FormError>
      <FormNotice>{resent}</FormNotice>
      {unconfirmed && !resent ? (
        <LinkButton
          title={resending ? 'Sending…' : 'Send the confirmation email again'}
          onPress={resend}
        />
      ) : null}

      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        placeholder="you@example.com"
        returnKeyType="next"
        onSubmitEditing={() => passwordRef.current?.focus()}
        {...emailProps}
      />

      <Field
        ref={passwordRef}
        label="Password"
        value={password}
        onChangeText={setPassword}
        placeholder="Your password"
        returnKeyType="go"
        onSubmitEditing={submit}
        textContentType="password"
        autoComplete="current-password"
        {...passwordProps}
      />

      <View>
        <PrimaryButton
          title="Sign in"
          onPress={submit}
          loading={busy}
          disabled={!email.trim() || !password}
        />
      </View>
    </AuthShell>
  )
}
