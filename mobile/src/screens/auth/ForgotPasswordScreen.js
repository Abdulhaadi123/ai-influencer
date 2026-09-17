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
      setError(userMessage(e, 'Could not send the reset link. Please try again.'))
    } finally {
      setBusy(false)
    }
  }, [busy, email, requestPasswordReset])

  if (sent) {
    return (
      <AuthShell
        title="Check your inbox"
        subtitle="Follow the link in the email to choose a new password. It expires in an hour."
        footer={<LinkButton title="Back to sign in" onPress={() => navigation.navigate('SignIn')} />}
      >
        <FormNotice>
          If there is an account for {email.trim()}, a reset link is on its way.
          Nothing arrived? Check spam, then try again in a minute.
        </FormNotice>
        <View>
          <PrimaryButton title="Send it again" onPress={() => { setSent(false) }} />
        </View>
      </AuthShell>
    )
  }

  return (
    <AuthShell
      title="Reset your password"
      subtitle="Tell us the address on your account and we will email you a link."
      footer={<LinkButton title="Back to sign in" onPress={() => navigation.navigate('SignIn')} />}
    >
      <FormError>{error}</FormError>

      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        placeholder="you@example.com"
        returnKeyType="go"
        onSubmitEditing={submit}
        {...emailProps}
      />

      <View>
        <PrimaryButton title="Email me a link" onPress={submit} loading={busy} disabled={!email.trim()} />
      </View>
    </AuthShell>
  )
}
