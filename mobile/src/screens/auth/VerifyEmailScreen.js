/**
 * Check your email — what a person sees once an account has been made and the verification
 * email is on its way.
 *
 * It used to be one line above the sign-up form, which was still on screen, still filled in,
 * and still said "Continue": nothing had visibly happened. Now the page changes — a tick draws
 * itself, the address the link went to is named, and the one button goes to sign-in, where the
 * person ends up once they have opened the link (the link opens a page on our server, not the app).
 *
 * Whether a confirmation email is needed at all is the server's setting, so this screen is only
 * reached when it said it was (SignUpScreen).
 */

import { useCallback, useState } from 'react'
import { Text, View, StyleSheet } from 'react-native'

import { useAuth } from '@core/auth/AuthContext'
import { userMessage } from '@core/errors'

import { useTheme, space, font } from '../../theme'
import SuccessTick from '../../components/SuccessTick'
import { AuthShell, PrimaryButton, LinkButton, FormError, FormNotice } from './parts'

export default function VerifyEmailScreen({ navigation, route }) {
  const { colors } = useTheme()
  const { resendConfirmation } = useAuth()
  const email = route?.params?.email || ''

  const [resending, setResending] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  const resend = useCallback(async () => {
    if (resending || !email) return
    setResending(true)
    setError(null)
    setNotice(null)
    try {
      await resendConfirmation(email)
      setNotice(`A new verification link is on its way to ${email}. If you don't see it, check your spam folder.`)
    } catch (e) {
      setError(userMessage(e, 'Unable to send the email. Please try again.'))
    } finally {
      setResending(false)
    }
  }, [resending, email, resendConfirmation])

  return (
    <AuthShell
      hero={<SuccessTick />}
      title="Email sent"
      subtitle={
        email ? (
          <>
            We've sent a verification link to{'\n'}
            <Text style={[font('semibold'), { color: colors.textPrimary }]}>{email}</Text>
            {'\n'}Open it to verify your account, then sign in.
          </>
        ) : 'We\'ve sent you a verification link. Open it to verify your account, then sign in.'
      }
      footer={<LinkButton prefix="Wrong address?" title="Back to sign up" onPress={() => navigation.replace('SignUp')} />}
    >
      <FormError>{error}</FormError>
      <FormNotice>{notice}</FormNotice>

      <View>
        <PrimaryButton title="Go to sign in" onPress={() => navigation.replace('SignIn')} />
      </View>

      <View style={styles.again}>
        <Text style={[styles.hint, { color: colors.textTertiary }]}>
          Can't find it? Look in your spam folder.
        </Text>
        {email ? <LinkButton title={resending ? 'Sending…' : 'Resend verification email'} onPress={resend} /> : null}
      </View>
    </AuthShell>
  )
}

const styles = StyleSheet.create({
  again: { alignItems: 'center', marginTop: space.lg, gap: space.xs },
  hint: { fontSize: 12.5, textAlign: 'center' },
})
