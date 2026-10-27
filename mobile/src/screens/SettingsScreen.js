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
  View, Text, ScrollView, ActivityIndicator, StyleSheet,
  Modal, KeyboardAvoidingView, Platform,
} from 'react-native'

import { useAuth } from '@core/auth/AuthContext'
import { validatePassword, MIN_PASSWORD_LENGTH, GOOGLE_CANCELLED } from '@core/auth'
import { userMessage } from '@core/errors'

import { useBottomInset } from '../hooks/useBottomInset'
import { useCredits } from '../hooks/useCredits'
import { Alert } from '../lib/dialog'
import { openLegal } from '../lib/openLegal'
import { LEGAL_PAGES } from '@core/config/legal'
import { formatCredits } from '@core/billing/packs'
import { useTheme, space, radius, font, layout } from '../theme'
import Screen, { ScreenHeader } from '../components/Screen'
import { Section, Row, Segmented, Button, PillInput } from '../components/ui'
import Icon from '../components/icons'

export default function SettingsScreen({ navigation }) {
  const { colors, preference, setPreference } = useTheme()
  const credits = useCredits()
  const bottomInset = useBottomInset()
  const { user, profile, signOut, deleteAccount, changePassword, requestPasswordReset, hasPassword } = useAuth()

  const [deleteOpen, setDeleteOpen] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [sendingLink, setSendingLink] = useState(false)

  // An account made with Google has no password to change. Setting one is the usual reset-by-email, to the
  // address Google has already vouched for: a link is sent, and following it makes the password.
  const sendSetPasswordLink = useCallback(async () => {
    if (sendingLink || !user?.email) return
    setSendingLink(true)
    try {
      await requestPasswordReset(user.email)
      Alert.alert('Check your email', `We sent a link to ${user.email}. Open it to choose a password.`)
    } catch (e) {
      Alert.alert('Could not send the email', userMessage(e, 'Please try again in a moment.'))
    } finally {
      setSendingLink(false)
    }
  }, [sendingLink, user?.email, requestPasswordReset])

  const confirmSignOut = useCallback(() => {
    Alert.alert('Sign out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => signOut() },
    ])
  }, [signOut])

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <ScreenHeader title="Settings" size={22} />

        <View style={styles.body}>
          <Section title="Account">
            <View style={styles.cardPad}>
              <Row label="Name" value={profile?.display_name || '—'} />
              <Row label="Email" value={user?.email || '—'} />
              {hasPassword ? null : <Row label="Sign-in" value="Google" />}
              <View style={styles.buttons}>
                {hasPassword ? (
                  <Button title="Change Password" size="sm" onPress={() => setPasswordOpen(true)} />
                ) : (
                  <Button title="Set a password" size="sm" onPress={sendSetPasswordLink} loading={sendingLink} />
                )}
                <Button title="Sign out" size="sm" variant="secondary" onPress={confirmSignOut} />
              </View>
            </View>
          </Section>

          {credits.visible ? (
            <Section title="Credits">
              <Row
                label="Balance"
                value={credits.balance === null ? '…' : `${formatCredits(credits.balance)} credits`}
                right={<Icon name="chevron" size={16} color={colors.textSecondary} />}
                onPress={() => navigation.navigate('Credits')}
              />
            </Section>
          ) : null}

          <Section title="Appearance">
            <View style={styles.cardPad}>
              <Segmented
                value={preference}
                onChange={setPreference}
                options={[
                  { label: 'Light', value: 'light' },
                  { label: 'Dark', value: 'dark', fill: '#1C0F44', onFill: '#FFFFFF' },
                ]}
              />
            </View>
          </Section>

          {/* Google Play wants the privacy policy reachable from inside the app; the rest are the
              pages a person looks for here. They open on the website, in the phone's browser. */}
          <Section title="About">
            {['privacy', 'terms', 'support'].map(id => (
              <Row
                key={id}
                label={LEGAL_PAGES.find(p => p.id === id).label}
                right={<Icon name="chevron" size={16} color={colors.textSecondary} />}
                onPress={() => openLegal(id)}
              />
            ))}
          </Section>

          <View style={styles.danger}>
            <Button title="Delete Account" variant="danger" onPress={() => setDeleteOpen(true)} />
            <Text style={[styles.dangerNote, { color: colors.textTertiary }]}>
              Permanently delete your account and all of its data. This action cannot be undone.
            </Text>
          </View>
        </View>
      </ScrollView>

      <ChangePasswordDialog
        visible={passwordOpen}
        email={user?.email}
        onClose={() => setPasswordOpen(false)}
        onChange={changePassword}
      />

      <DeleteAccountDialog
        visible={deleteOpen}
        email={user?.email}
        hasPassword={hasPassword}
        onClose={() => setDeleteOpen(false)}
        onDelete={deleteAccount}
      />
    </Screen>
  )
}

/** The frame both dialogs share: a dimmed page and an opaque rounded sheet. */
function Dialog({ visible, onClose, title, children }) {
  const { colors } = useTheme()
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[styles.dialog, { backgroundColor: colors.sheet, borderColor: colors.glassEdge }]}>
          <Text style={[styles.dialogTitle, font('bold'), { color: colors.textPrimary }]}>{title}</Text>
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

/**
 * Confirmation for deleting the account.
 *
 * Its own dialog rather than Alert.prompt, which exists only on iOS. The
 * password lives in this component's state while it is open and nowhere else:
 * cleared on close, never logged, never stored.
 */
function DeleteAccountDialog({ visible, email, hasPassword = true, onClose, onDelete }) {
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

  // An account made with Google has no password: it confirms by signing in with Google again, and the
  // server checks that it is THIS account's Google (core/auth/index.js deleteAccount).
  const ready = hasPassword ? !!password : true

  const confirm = useCallback(async () => {
    if (busy || !ready) return
    setBusy(true)
    setError(null)
    try {
      await onDelete(hasPassword ? { email, password } : { email, google: true })
      setPassword('')
      // Signing out swaps the navigator to the sign-in screen, which unmounts
      // this dialog — the alert is what tells the user it worked.
      Alert.alert('Account deleted', 'Your account has been permanently deleted.')
    } catch (e) {
      // Closing Google's account picker is changing one's mind, not a failure.
      if (e?.code !== GOOGLE_CANCELLED) setError(userMessage(e, 'Unable to delete your account. Please try again.'))
    } finally {
      setBusy(false)
    }
  }, [busy, ready, hasPassword, password, email, onDelete])

  return (
    <Dialog visible={visible} onClose={close} title="Delete account">
      <Text style={[styles.dialogBody, { color: colors.textSecondary }]}>
        This will permanently delete your account, including all influencers, images and
        videos, and any credits you have left. Any generations in progress will be lost.
        {hasPassword ? ' Enter your password to continue.' : ' Confirm with Google to continue.'}
      </Text>

      {hasPassword ? (
        <PillInput
          value={password}
          onChangeText={setPassword}
          placeholder="Password"
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="password"
          autoComplete="current-password"
          editable={!busy}
          returnKeyType="go"
          onSubmitEditing={confirm}
          error={!!error}
        />
      ) : null}
      {error ? <Text style={[styles.dialogError, { color: colors.danger }]}>{error}</Text> : null}

      {busy ? (
        <View style={styles.busy}>
          <ActivityIndicator size="small" color={colors.danger} />
          <Text style={[styles.busyText, { color: colors.textSecondary }]}>Deleting…</Text>
        </View>
      ) : (
        <View style={styles.dialogActions}>
          <Button title={hasPassword ? 'Delete account' : 'Confirm with Google and delete'} variant="danger" onPress={confirm} disabled={!ready} />
          <Button title="Cancel" variant="neutral" onPress={close} />
        </View>
      )}
    </Dialog>
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

  const secret = { secureTextEntry: true, autoCapitalize: 'none', autoCorrect: false, editable: !busy }

  return (
    <Dialog visible={visible} onClose={close} title="Change password">
      <PillInput
        value={current}
        onChangeText={setCurrent}
        placeholder="Current password"
        textContentType="password"
        autoComplete="current-password"
        {...secret}
      />
      <PillInput
        value={next}
        onChangeText={setNext}
        placeholder="New password"
        textContentType="newPassword"
        autoComplete="new-password"
        error={!!problem}
        {...secret}
      />
      <Text style={[styles.dialogHint, { color: problem ? colors.danger : colors.textTertiary }]}>
        {problem || `Must be at least ${MIN_PASSWORD_LENGTH} characters and include a letter and a number.`}
      </Text>
      <PillInput
        value={confirm}
        onChangeText={setConfirm}
        placeholder="Confirm new password"
        textContentType="newPassword"
        autoComplete="new-password"
        returnKeyType="go"
        onSubmitEditing={submit}
        error={mismatch}
        {...secret}
      />
      {mismatch ? <Text style={[styles.dialogError, { color: colors.danger }]}>Passwords do not match.</Text> : null}
      {error ? <Text style={[styles.dialogError, { color: colors.danger }]}>{error}</Text> : null}

      {busy ? (
        <View style={styles.busy}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={[styles.busyText, { color: colors.textSecondary }]}>Updating…</Text>
        </View>
      ) : (
        <View style={styles.dialogActions}>
          <Button title="Update password" onPress={submit} disabled={!canSubmit} />
          <Button title="Cancel" variant="neutral" onPress={close} />
        </View>
      )}
    </Dialog>
  )
}

const styles = StyleSheet.create({
  content: { flexGrow: 1 },
  body: { paddingHorizontal: layout.pageGutter, paddingTop: space.sm },
  cardPad: { padding: space.lg, gap: space.xs },
  buttons: { gap: space.sm, marginTop: space.md },

  danger: { gap: space.md, marginTop: space.lg },
  dangerNote: { fontSize: 12, lineHeight: 17, textAlign: 'center', paddingHorizontal: space.lg },

  busy: { flexDirection: 'row', alignItems: 'center', gap: space.sm, justifyContent: 'center', paddingVertical: space.sm },
  busyText: { fontSize: 14 },

  backdrop: { flex: 1, justifyContent: 'center', padding: space.xl, backgroundColor: 'rgba(8,3,83,0.55)' },
  dialog: { borderRadius: 28, borderWidth: 1, padding: space.xl, gap: space.md },
  dialogTitle: { fontSize: 20, letterSpacing: -0.3 },
  dialogBody: { fontSize: 14, lineHeight: 20 },
  dialogError: { fontSize: 13, lineHeight: 18 },
  dialogHint: { fontSize: 12, lineHeight: 17, marginTop: -space.xs, marginLeft: space.sm },
  dialogActions: { gap: space.sm, marginTop: space.xs },
})
