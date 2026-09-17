/**
 * Forgot password — request a reset link.
 *
 * This screen reports the same thing whether or not an account exists. That is
 * not vagueness for its own sake: a forgot-password form that says "no account
 * with that email" is a free account-enumeration oracle, and enumerating which
 * addresses are registered is the reconnaissance step before a targeted
 * phishing or credential-stuffing attempt.
 *
 * So the confirmation is phrased carefully — "if there is an account, a link is
 * on its way" — which is honest to a real user and useless to someone probing.
 */

import { useCallback, useState } from 'react'
import { View } from 'react-native'

import { useAuth } from '@core/auth/AuthContext'
import { userMessage } from '@core/errors'

import { AuthShell, Field, PrimaryButton, LinkButton, FormError, FormNotice, emailProps } from './parts'

export default function ForgotPasswordScreen({ navigation }) {
  const { requestPasswordReset } = useAuth()

  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const submit = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await requestPasswordReset(email)
      setSent(true)
    } catch (e) {
      // Only genuine problems reach here — a malformed address, or this device
      // being rate limited. "No such user" deliberately does not.
      setError(userMessage(e, 'Unable to send the reset link. Please try again.'))
    } finally {
      setBusy(false)
    }
  }, [busy, email, requestPasswordReset])

  if (sent) {
    return (
      <AuthShell
        title="Check your email"
        subtitle="Follow the link in the email to set a new password, then sign in with it."
        footer={<LinkButton title="Back to sign in" onPress={() => navigation.navigate('SignIn')} />}
      >
        <FormNotice>
          If an account exists for {email.trim()}, you will receive a password reset link
          shortly. If you don't see it, check your spam folder.
        </FormNotice>
        <View>
          <PrimaryButton title="Resend link" onPress={() => { setSent(false) }} />
        </View>
      </AuthShell>
    )
  }

  return (
    <AuthShell
      title="Reset password"
      subtitle="Enter the email address for your account and we will send you a link to reset your password."
      footer={<LinkButton title="Back to sign in" onPress={() => navigation.navigate('SignIn')} />}
    >
      <FormError>{error}</FormError>

      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        placeholder="name@example.com"
        returnKeyType="go"
        onSubmitEditing={submit}
        {...emailProps}
      />

      <View>
        <PrimaryButton title="Send reset link" onPress={submit} loading={busy} disabled={!email.trim()} />
      </View>
    </AuthShell>
  )
}
