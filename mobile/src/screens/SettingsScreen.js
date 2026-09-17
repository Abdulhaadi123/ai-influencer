/**
 * Settings — account and appearance.
 *
 * ── What was removed and why ─────────────────────────────────────────────────
 *
 * This screen used to accept an Anthropic API key and write it to device
 * storage in plaintext, under `claude_api_key`. That is a long-lived billable
 * credential sitting unencrypted on disk, readable by anything that can reach
 * the app's data directory, and synced into device backups.
 *
 * There is no client-side fix for that — the honest options are "the server
 * holds the key" or "the feature does not exist". The server holds it. Nothing
 * on this screen collects a secret any more.
 *
 * The generation-engine status and the connection test were developer tools
 * and are gone too: neither meant anything to someone using the app.
 */

import { useCallback, useState } from 'react'
import {
  View, Text, ScrollView, ActivityIndicator, StyleSheet, Alert,
  Modal, TextInput, KeyboardAvoidingView, Platform,
} from 'react-native'

import { useAuth } from '@core/auth/AuthContext'
import { validatePassword, MIN_PASSWORD_LENGTH } from '@core/auth'
import { userMessage } from '@core/errors'

import { useBottomInset } from '../hooks/useBottomInset'
import { useTheme, space, radius } from '../theme'
import { Section, Row, Segmented, Button } from '../components/ui'

export default function SettingsScreen() {
  const { colors, preference, setPreference } = useTheme()
  const bottomInset = useBottomInset()
  const { user, profile, signOut, deleteAccount, changePassword } = useAuth()

  const [deleteOpen, setDeleteOpen] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)

  const confirmSignOut = useCallback(() => {
    Alert.alert('Sign out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => signOut() },
    ])
  }, [signOut])

  return (
    <ScrollView
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]}
      keyboardShouldPersistTaps="handled"
    >
      <Section title="Account">
        <Row label="Name" value={profile?.display_name || '—'} />
        <Row label="Email" value={user?.email || '—'} last />
        <View style={styles.padded}>
          <Button title="Change password" variant="secondary" onPress={() => setPasswordOpen(true)} />
        </View>
        <View style={[styles.padded, { paddingTop: 0 }]}>
          <Button title="Sign out" variant="secondary" onPress={confirmSignOut} />
        </View>
      </Section>

      <Section title="Appearance">
        <View style={styles.padded}>
          <Segmented
            value={preference}
            onChange={setPreference}
            options={[
              { label: 'System', value: 'system' },
              { label: 'Light', value: 'light' },
              { label: 'Dark', value: 'dark' },
            ]}
          />
        </View>
      </Section>

      <Section
        title="Delete account"
        footer="Permanently delete your account and all of its data. This action cannot be undone."
      >
        <View style={styles.padded}>
          <Button title="Delete account" variant="danger" onPress={() => setDeleteOpen(true)} />
        </View>
      </Section>

      <ChangePasswordDialog
        visible={passwordOpen}
        email={user?.email}
        onClose={() => setPasswordOpen(false)}
        onChange={changePassword}
      />

      <DeleteAccountDialog
        visible={deleteOpen}
        email={user?.email}
        onClose={() => setDeleteOpen(false)}
        onDelete={deleteAccount}
      />
    </ScrollView>
  )
}

/**
 * Confirmation for deleting the account.
 *
 * Its own dialog rather than Alert.prompt, which exists only on iOS. The
 * password lives in this component's state while it is open and nowhere else:
 * cleared on close, never logged, never stored.
 */
function DeleteAccountDialog({ visible, email, onClose, onDelete }) {
  const { colors } = useTheme()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const close = useCallback(() => {
    if (busy) return
    setPassword('')
    setError(null)
    onClose()
  }, [busy, onClose])

  const confirm = useCallback(async () => {
    if (busy || !password) return
    setBusy(true)
    setError(null)
    try {
      await onDelete({ email, password })
      setPassword('')
      // Signing out swaps the navigator to the sign-in screen, which unmounts
      // this dialog — the alert is what tells the user it worked.
      Alert.alert('Account deleted', 'Your account has been permanently deleted.')
    } catch (e) {
      setError(userMessage(e, 'Unable to delete your account. Please try again.'))
    } finally {
      setBusy(false)
    }
  }, [busy, password, email, onDelete])

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={[styles.dialog, { backgroundColor: colors.surface, borderColor: colors.borderSubtle }]}>
          <Text style={[styles.dialogTitle, { color: colors.textPrimary }]}>Delete account</Text>
          <Text style={[styles.dialogBody, { color: colors.textSecondary }]}>
            This will permanently delete your account, including all influencers, images and
            videos. Any generations in progress will be lost. Enter your password to continue.
          </Text>

          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="Password"
            placeholderTextColor={colors.textTertiary}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="password"
            autoComplete="current-password"
            editable={!busy}
            returnKeyType="go"
            onSubmitEditing={confirm}
            style={[styles.input, {
              color: colors.textPrimary,
              borderColor: error ? colors.danger : colors.border,
              backgroundColor: colors.bg,
            }]}
          />
          {error ? <Text style={[styles.dialogError, { color: colors.danger }]}>{error}</Text> : null}

          {busy ? (
            <View style={styles.busy}>
              <ActivityIndicator size="small" color={colors.danger} />
              <Text style={[styles.busyText, { color: colors.textSecondary }]}>Deleting…</Text>
            </View>
          ) : (
            <View style={styles.dialogActions}>
              <Button title="Delete account" variant="danger" onPress={confirm} disabled={!password} />
              <Button title="Cancel" variant="secondary" onPress={close} />
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

/**
 * Change the password of the signed-in account.
 *
 * Asks for the current password — changePassword signs in with it before
 * changing anything — so a phone left unlocked and signed in is not enough to
 * lock the owner out. The passwords live in this dialog's state while it is
 * open and nowhere else: cleared on close, never logged, never stored.
 */
function ChangePasswordDialog({ visible, email, onClose, onChange }) {
  const { colors } = useTheme()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const problem = next ? validatePassword(next) : null
  const mismatch = confirm.length > 0 && confirm !== next
  const canSubmit = !!current && !!next && !problem && confirm === next

  const clear = () => { setCurrent(''); setNext(''); setConfirm(''); setError(null) }

  const close = () => {
    if (busy) return
    clear()
    onClose()
  }

  const submit = async () => {
    if (busy || !canSubmit) return
    setBusy(true)
    setError(null)
    try {
      await onChange({ email, currentPassword: current, newPassword: next })
      clear()
      onClose()
      Alert.alert('Password updated', 'Your password has been changed successfully.')
    } catch (e) {
      setError(userMessage(e, 'Unable to change your password. Please try again.'))
    } finally {
      setBusy(false)
    }
  }

  const inputStyle = hasError => [styles.input, {
    color: colors.textPrimary,
    borderColor: hasError ? colors.danger : colors.border,
    backgroundColor: colors.bg,
  }]
  const secret = {
    secureTextEntry: true,
    autoCapitalize: 'none',
    autoCorrect: false,
    editable: !busy,
    placeholderTextColor: colors.textTertiary,
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[styles.dialog, { backgroundColor: colors.surface, borderColor: colors.borderSubtle }]}>
          <Text style={[styles.dialogTitle, { color: colors.textPrimary }]}>Change password</Text>

          <TextInput
            value={current}
            onChangeText={setCurrent}
            placeholder="Current password"
            textContentType="password"
            autoComplete="current-password"
            {...secret}
            style={inputStyle(false)}
          />
          <TextInput
            value={next}
            onChangeText={setNext}
            placeholder="New password"
            textContentType="newPassword"
            autoComplete="new-password"
            {...secret}
            style={inputStyle(!!problem)}
          />
          <Text style={[styles.dialogHint, { color: problem ? colors.danger : colors.textTertiary }]}>
            {problem || `Must be at least ${MIN_PASSWORD_LENGTH} characters and include a letter and a number.`}
          </Text>
          <TextInput
            value={confirm}
            onChangeText={setConfirm}
            placeholder="Confirm new password"
            textContentType="newPassword"
            autoComplete="new-password"
            returnKeyType="go"
            onSubmitEditing={submit}
            {...secret}
            style={inputStyle(mismatch)}
          />
          {mismatch ? <Text style={[styles.dialogError, { color: colors.danger }]}>Passwords do not match.</Text> : null}
          {error ? <Text style={[styles.dialogError, { color: colors.danger }]}>{error}</Text> : null}

          {busy ? (
            <View style={styles.busy}>
              <ActivityIndicator size="small" color={colors.brand} />
              <Text style={[styles.busyText, { color: colors.textSecondary }]}>Updating…</Text>
            </View>
          ) : (
            <View style={styles.dialogActions}>
              <Button title="Update password" onPress={submit} disabled={!canSubmit} />
              <Button title="Cancel" variant="secondary" onPress={close} />
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingTop: space.xl },
  padded: { padding: space.lg },
  busy: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  busyText: { fontSize: 14 },

  backdrop: { flex: 1, justifyContent: 'center', padding: space.xl, backgroundColor: 'rgba(0,0,0,0.55)' },
  dialog: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, padding: space.xl, gap: space.md },
  dialogTitle: { fontSize: 18, fontWeight: '700' },
  dialogBody: { fontSize: 14, lineHeight: 20 },
  dialogError: { fontSize: 13, lineHeight: 18 },
  dialogHint: { fontSize: 12, lineHeight: 17, marginTop: -space.xs },
  dialogActions: { gap: space.sm },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: space.md, paddingVertical: space.md, fontSize: 15 },
})
