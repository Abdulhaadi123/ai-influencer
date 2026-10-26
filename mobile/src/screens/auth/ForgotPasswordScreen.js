/**
 * Forgot password — request a reset link.
 *
 * An address with no account is refused here, on the email field, with a way to
 * sign up — the owner's decision. Saying "if there is an account, a link is on its
 * way" left someone who mistyped their address waiting for an email that would
 * never come. The cost is that this form tells anyone whether an address is
 * registered; the server's limits (per address and per device, counted before it
 * looks) keep that slow.
 */

import { useCallback, useEffect, useState } from 'react'
import { View, StyleSheet } from 'react-native'

import { useAuth } from '@core/auth/AuthContext'
import { ACCOUNT_NOT_FOUND } from '@core/auth'
import { userMessage } from '@core/errors'

import { space } from '../../theme'
import { AuthShell, Field, PrimaryButton, LinkButton, FormError, FormNotice, emailProps } from './parts'

const styles = StyleSheet.create({
  missingActions: { marginTop: space.md, gap: space.xs },
})

export default function ForgotPasswordScreen({ navigation, route }) {
  const { requestPasswordReset } = useAuth()

  // The sign-up form passes along the address it just refused, so it need not be typed again.
  const passedEmail = route?.params?.email
  const [email, setEmail] = useState(passedEmail || '')
  useEffect(() => { if (passedEmail) setEmail(passedEmail) }, [passedEmail])
  const [sent, setSent] = useState(false)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  // The address that has no account. Kept as the address, not a flag, so editing it clears
  // the message and typing it back brings nothing stale.
  const [missingEmail, setMissingEmail] = useState(null)
  const missing = missingEmail !== null && missingEmail === email.trim().toLowerCase()

  const submit = useCallback(async () => {
    if (busy || missing) return
    setBusy(true)
    setError(null)
    setMissingEmail(null)
    try {
      await requestPasswordReset(email)
      setSent(true)
    } catch (e) {
      // Said on the email field itself, with the way forward below the button.
      if (e?.code === ACCOUNT_NOT_FOUND) setMissingEmail(email.trim().toLowerCase())
      else setError(userMessage(e, 'Unable to send the reset link. Please try again.'))
    } finally {
      setBusy(false)
    }
  }, [busy, missing, email, requestPasswordReset])

  if (sent) {
    return (
      <AuthShell
        title="Check your email"
        subtitle="Follow the link in the email to set a new password, then sign in with it."
        footer={<LinkButton prefix="Ready to sign in?" title="Back to sign in" onPress={() => navigation.navigate('SignIn')} />}
      >
        <FormNotice>
          We sent a password reset link to {email.trim()}. It can take a minute to arrive;
          if you don't see it, check your spam folder.
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
      footer={<LinkButton prefix="Remembered it?" title="Back to sign in" onPress={() => navigation.navigate('SignIn')} />}
    >
      <FormError>{error}</FormError>

      <Field
        label="Email"
        error={missing ? 'No account was found with this email address.' : null}
        value={email}
        onChangeText={setEmail}
        placeholder="name@example.com"
        returnKeyType="go"
        onSubmitEditing={submit}
        {...emailProps}
      />

      <View>
        <PrimaryButton title="Send reset link" onPress={submit} loading={busy} disabled={!email.trim() || missing} />
      </View>

      {missing ? (
        <View style={styles.missingActions}>
          <LinkButton prefix="New here?" title="Create an account" onPress={() => navigation.navigate('SignUp', { email: email.trim() })} />
        </View>
      ) : null}
    </AuthShell>
  )
}
