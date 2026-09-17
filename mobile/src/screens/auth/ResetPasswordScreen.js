/**
 * Set a new password, reached from a reset email.
 *
 * The link opens the app on the `aiinfluencer://reset-password?code=…` deep
 * link registered in app.json. That code is exchanged for a short-lived session
 * with just enough authority to change the password — the PKCE flow, so the
 * email carries a single-use code rather than the tokens themselves. A link
 * sitting in an inbox or a mail-provider log is therefore worth very little.
 *
 * Supabase revokes the user's other sessions when the password changes, which
 * is what someone resetting after a scare expects: whoever else was signed in
 * is now signed out.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View } from 'react-native'

import { useAuth } from '@core/auth/AuthContext'
import { exchangeRecoveryCode } from '@core/auth'
import { validatePassword, MIN_PASSWORD_LENGTH } from '@core/auth'
import { userMessage } from '@core/errors'

import {
  AuthShell, Field, PrimaryButton, LinkButton, FormError, FormNotice, passwordProps,
} from './parts'

export default function ResetPasswordScreen({ navigation, route }) {
  const { updatePassword, signOut } = useAuth()

  const code = route?.params?.code ?? null
  // Supabase redirects with these instead of a code when it refused the link.
  const linkRefused = !!(route?.params?.error_code || route?.params?.error_description)

  const [ready, setReady] = useState(false)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  const confirmRef = useRef(null)

  // Trade the code for a session as soon as the screen opens. Doing it on
  // submit instead would let the user fill the whole form before discovering
  // the link had expired.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!code) {
        setError(linkRefused
          ? 'That reset link has expired or was already used. Request a new one.'
          : 'That reset link is not valid. Request a new one.')
        return
      }
      try {
        await exchangeRecoveryCode(code)
        if (!cancelled) setReady(true)
      } catch (e) {
        if (!cancelled) setError(userMessage(e, 'That reset link is not valid. Request a new one.'))
      }
    })()
    return () => { cancelled = true }
  }, [code, linkRefused])

  const passwordProblem = useMemo(
    () => (password ? validatePassword(password) : null),
    [password],
  )
  const mismatch = confirm.length > 0 && confirm !== password
  const canSubmit = ready && password.length > 0 && !passwordProblem && !mismatch

  const submit = useCallback(async () => {
    if (busy || !canSubmit) return
    setBusy(true)
    setError(null)
    try {
      await updatePassword(password)
      setDone(true)
      // The recovery session is not a normal signed-in session — it exists to
      // change a password. Ending it means the user signs in with the new
      // password, which also proves to them that it took.
      await signOut()
    } catch (e) {
      setError(userMessage(e, 'Could not change the password. Please try again.'))
    } finally {
      setBusy(false)
    }
  }, [busy, canSubmit, password, updatePassword, signOut])

  if (done) {
    return (
      <AuthShell
        title="Password changed"
        subtitle="Sign in with your new password. Any other devices have been signed out."
        footer={<LinkButton title="Go to sign in" onPress={() => navigation.navigate('SignIn')} />}
      >
        <FormNotice>Your password has been updated.</FormNotice>
      </AuthShell>
    )
  }

  return (
    <AuthShell
      title="Choose a new password"
      subtitle="Pick something you have not used here before."
      footer={
        <>
          {!ready ? <LinkButton title="Request a new link" onPress={() => navigation.navigate('ForgotPassword')} /> : null}
          <LinkButton title="Back to sign in" onPress={() => navigation.navigate('SignIn')} />
        </>
      }
    >
      <FormError>{error}</FormError>

      <Field
        label="New password"
        hint={`At least ${MIN_PASSWORD_LENGTH} characters, with a letter and a number.`}
        error={passwordProblem}
        value={password}
        onChangeText={setPassword}
        placeholder="New password"
        editable={ready}
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
        editable={ready}
        returnKeyType="go"
        onSubmitEditing={submit}
        textContentType="newPassword"
        autoComplete="new-password"
        {...passwordProps}
      />

      <View>
        <PrimaryButton title="Save new password" onPress={submit} loading={busy} disabled={!canSubmit} />
      </View>
    </AuthShell>
  )
}
