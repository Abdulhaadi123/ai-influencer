/**
 * Create an account.
 *
 * The password rule is checked as the user types rather than on submit. Being
 * told the requirement after a failed round trip is the reliable way to make
 * someone pick the shortest thing that passes; showing it live lets them get it
 * right the first time.
 *
 * Whether a confirmation email is required is a server setting (REQUIRE_EMAIL_CONFIRMATION), not
 * something this screen decides — so it handles both outcomes rather than
 * assuming one.
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import { View } from 'react-native'

import { useAuth } from '@core/auth/AuthContext'
import { validatePassword, MIN_PASSWORD_LENGTH } from '@core/auth'
import { userMessage } from '@core/errors'

import {
  AuthShell, Field, PrimaryButton, LinkButton, FormError, FormNotice,
  emailProps, passwordProps,
} from './parts'

export default function SignUpScreen({ navigation }) {
  const { signUp, resendConfirmation } = useAuth()

  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState(false)
  /** The address a confirmation email went to, once one has. */
  const [sentTo, setSentTo] = useState(null)
  const [resending, setResending] = useState(false)

  const emailRef = useRef(null)
  const passwordRef = useRef(null)
  const confirmRef = useRef(null)

  // Only complain once there is something to complain about — an empty field
  // is not yet a mistake.
  const passwordProblem = useMemo(
    () => (password ? validatePassword(password) : null),
    [password],
  )
  const mismatch = confirm.length > 0 && confirm !== password

  const canSubmit =
    email.trim().length > 0 && password.length > 0 && !passwordProblem && !mismatch

  const submit = useCallback(async () => {
    if (busy || !canSubmit) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const { needsEmailConfirmation } = await signUp({ email, password, displayName })

      if (needsEmailConfirmation) {
        setSentTo(email.trim())
        setNotice(`Account created. Check ${email.trim()} for a confirmation link, then come back here and sign in.`)
      }
      // Otherwise the session arrives and the auth gate swaps the navigator —
      // nothing to do here.
    } catch (e) {
      setError(userMessage(e, 'Could not create the account. Please try again.'))
    } finally {
      setBusy(false)
    }
  }, [busy, canSubmit, email, password, displayName, signUp])

  return (
    <AuthShell
      title="Create your account"
      subtitle="Your influencers, generations and files are private to you."
      footer={<LinkButton title="Already have an account? Sign in" onPress={() => navigation.navigate('SignIn')} />}
    >
      <FormError>{error}</FormError>
      <FormNotice>{notice}</FormNotice>

      <Field
        label="Name"
        hint="Optional — what we call you in the app."
        value={displayName}
        onChangeText={setDisplayName}
        placeholder="Your name"
        autoCapitalize="words"
        returnKeyType="next"
        onSubmitEditing={() => emailRef.current?.focus()}
      />

      <Field
        ref={emailRef}
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
        hint={`At least ${MIN_PASSWORD_LENGTH} characters, with a letter and a number.`}
        error={passwordProblem}
        value={password}
        onChangeText={setPassword}
        placeholder="Choose a password"
        returnKeyType="next"
        onSubmitEditing={() => confirmRef.current?.focus()}
        textContentType="newPassword"
        autoComplete="new-password"
        {...passwordProps}
      />

      <Field
        ref={confirmRef}
        label="Confirm password"
        error={mismatch ? 'These do not match.' : null}
        value={confirm}
        onChangeText={setConfirm}
        placeholder="Type it again"
        returnKeyType="go"
        onSubmitEditing={submit}
        textContentType="newPassword"
        autoComplete="new-password"
        {...passwordProps}
      />

      <View>
        <PrimaryButton title="Create account" onPress={submit} loading={busy} disabled={!canSubmit} />
      </View>

      {sentTo ? (
        <LinkButton
          title={resending ? 'Sending…' : 'Nothing arrived? Send it again'}
          onPress={async () => {
            if (resending) return
            setResending(true)
            setError(null)
            try {
              await resendConfirmation(sentTo)
              setNotice(`A new confirmation link is on its way to ${sentTo}. Check spam too.`)
            } catch (e) {
              setError(userMessage(e, 'Could not send the email. Please try again.'))
            } finally {
              setResending(false)
            }
          }}
        />
      ) : null}
    </AuthShell>
  )
}
