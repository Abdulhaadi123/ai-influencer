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
 * assuming one. When one is required the whole page changes to "Email sent" (VerifyEmailScreen).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, StyleSheet } from 'react-native'

import { useAuth } from '@core/auth/AuthContext'
import { validatePassword, MIN_PASSWORD_LENGTH, EMAIL_TAKEN } from '@core/auth'
import { userMessage } from '@core/errors'

import { space } from '../../theme'
import {
  AuthShell, Field, PrimaryButton, LinkButton, FormError,
  emailProps, passwordProps,
} from './parts'

const styles = StyleSheet.create({
  takenActions: { marginTop: space.md, gap: space.xs },
})

export default function SignUpScreen({ navigation, route }) {
  const { signUp } = useAuth()

  // Forgot-password passes along an address that has no account, so it need not be typed again.
  const passedEmail = route?.params?.email
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState(passedEmail || '')
  useEffect(() => { if (passedEmail) setEmail(passedEmail) }, [passedEmail])
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  // The address that was refused because it already has an account. Kept as the address, not a
  // flag, so editing it clears the message and typing it back brings nothing stale.
  const [takenEmail, setTakenEmail] = useState(null)
  const taken = takenEmail !== null && takenEmail === email.trim().toLowerCase()

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

  // The confirmation has to be typed, not just "not wrong": left empty, a typo
  // in the password went straight into the account and locked its owner out.
  const canSubmit =
    email.trim().length > 0 && password.length > 0 && !passwordProblem && confirm === password

  const submit = useCallback(async () => {
    if (busy || !canSubmit) return
    setBusy(true)
    setError(null)
    setTakenEmail(null)
    try {
      const { needsEmailConfirmation } = await signUp({ email, password, displayName })

      // `replace`, not `navigate`: going back must not land on this form, still filled in.
      if (needsEmailConfirmation) navigation.replace('VerifyEmail', { email: email.trim() })
      // Otherwise the session arrives and the auth gate swaps the navigator —
      // nothing to do here.
    } catch (e) {
      // Said on the email field itself, with the two ways forward below the button.
      if (e?.code === EMAIL_TAKEN) setTakenEmail(email.trim().toLowerCase())
      else setError(userMessage(e, 'Unable to create your account. Please try again.'))
    } finally {
      setBusy(false)
    }
  }, [busy, canSubmit, email, password, displayName, signUp, navigation])

  return (
    <AuthShell
      title="Sign up"
      footer={<LinkButton prefix="Already have an account?" title="Sign in" onPress={() => navigation.navigate('SignIn')} />}
    >
      <FormError>{error}</FormError>

      <Field
        label="Name"
        hint="Optional"
        value={displayName}
        onChangeText={setDisplayName}
        placeholder="Enter your name"
        autoCapitalize="words"
        returnKeyType="next"
        onSubmitEditing={() => emailRef.current?.focus()}
      />

      <Field
        ref={emailRef}
        label="Email"
        error={taken ? 'An account with this email already exists.' : null}
        value={email}
        onChangeText={setEmail}
        placeholder="name@example.com"
        returnKeyType="next"
        onSubmitEditing={() => passwordRef.current?.focus()}
        {...emailProps}
      />

      <Field
        ref={passwordRef}
        label="Password"
        hint={`Must be at least ${MIN_PASSWORD_LENGTH} characters and include a letter and a number.`}
        error={passwordProblem}
        value={password}
        onChangeText={setPassword}
        placeholder="Create a password"
        returnKeyType="next"
        onSubmitEditing={() => confirmRef.current?.focus()}
        textContentType="newPassword"
        autoComplete="new-password"
        {...passwordProps}
      />

      <Field
        ref={confirmRef}
        label="Confirm password"
        error={mismatch ? 'Passwords do not match.' : null}
        value={confirm}
        onChangeText={setConfirm}
        placeholder="Re-enter your password"
        returnKeyType="go"
        onSubmitEditing={submit}
        textContentType="newPassword"
        autoComplete="new-password"
        {...passwordProps}
      />

      <View>
        <PrimaryButton title="Continue" onPress={submit} loading={busy} disabled={!canSubmit || taken} />
      </View>

      {taken ? (
        <View style={styles.takenActions}>
          <LinkButton title="Sign in instead" onPress={() => navigation.navigate('SignIn', { email: email.trim() })} />
          <LinkButton title="Forgot password?" onPress={() => navigation.navigate('ForgotPassword', { email: email.trim() })} />
        </View>
      ) : null}

    </AuthShell>
  )
}
