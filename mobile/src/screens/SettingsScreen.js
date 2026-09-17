/**
 * Settings — account, appearance, and engine status.
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
 */

import { useCallback, useEffect, useState } from 'react'
import {
  View, Text, ScrollView, ActivityIndicator, StyleSheet, Alert,
  Modal, TextInput, KeyboardAvoidingView, Platform,
} from 'react-native'

import { useAuth } from '@core/auth/AuthContext'
import { validatePassword, MIN_PASSWORD_LENGTH } from '@core/auth'
import { checkEngine } from '@core/api/kieAuth'
import { userMessage } from '@core/errors'
import { runDiagnostics } from '@core/api/diagnostics'

import { useBottomInset } from '../hooks/useBottomInset'
import { useTheme, space, radius } from '../theme'
import { Section, Row, StatusPill, Segmented, Button } from '../components/ui'
import { showError } from '../lib/alerts'

export default function SettingsScreen() {
  const { colors, preference, setPreference } = useTheme()
  const bottomInset = useBottomInset()
  const { user, profile, signOut, signOutEverywhere, deleteAccount, changePassword } = useAuth()

  const [engine, setEngine] = useState('checking')  // checking | ready | offline
  const [diag, setDiag] = useState(null)            // null | 'running' | results
  const [diagStep, setDiagStep] = useState('')
  const [engineError, setEngineError] = useState(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)

  useEffect(() => {
    let alive = true
    // "Engine offline" alone left people guessing; the reason says where to look.
    checkEngine().then(({ ok, reason }) => {
      if (!alive) return
      setEngine(ok ? 'ready' : 'offline')
      setEngineError(ok ? null : reason)
    })
    return () => { alive = false }
  }, [])

  const runChecks = useCallback(async () => {
    setDiag('running')
    setDiagStep('')
    try {
      setDiag(await runDiagnostics((done, total) => setDiagStep(`${done}/${total}`)))
    } catch (e) {
      setDiag({ results: [{ label: 'Diagnostics', status: 'fail', detail: userMessage(e, 'The checks could not run.') }], passed: 0, total: 1 })
    }
  }, [])

  const confirmSignOut = useCallback(() => {
    Alert.alert('Sign out?', 'Your influencers and generations stay in your account.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => signOut() },
    ])
  }, [signOut])

  /**
   * Revoking everywhere is the "I think someone else has my password" button,
   * so it is worth spelling out what it does rather than labelling it
   * "sign out (all)".
   */
  const confirmSignOutEverywhere = useCallback(() => {
    Alert.alert(
      'Sign out on every device?',
      'Every phone, tablet and browser signed in to this account will be signed out. Use this if you think someone else has access.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign out everywhere',
          style: 'destructive',
          onPress: async () => {
            try { await signOutEverywhere() }
            catch (e) { showError('Could not sign out everywhere', e, 'Other devices were not signed out. Please try again.') }
          },
        },
      ],
    )
  }, [signOutEverywhere])

  return (
    <ScrollView
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]}
      keyboardShouldPersistTaps="handled"
    >
      <Section title="Account" footer="Everything you create is private to this account.">
        <Row label="Signed in as" value={profile?.display_name || user?.email || '—'} />
        <Row label="Email" value={user?.email || '—'} last />
        <View style={styles.padded}>
          <Button title="Change password" variant="secondary" onPress={() => setPasswordOpen(true)} />
        </View>
        <View style={[styles.padded, { paddingTop: 0 }]}>
          <Button title="Sign out" variant="secondary" onPress={confirmSignOut} />
        </View>
        <View style={[styles.padded, { paddingTop: 0 }]}>
          <Button title="Sign out everywhere" variant="danger" onPress={confirmSignOutEverywhere} />
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
        title="Generation engine"
        footer="Generation runs through our server, which holds the API key. There is nothing to configure here."
      >
        <Row
          last
          label="Status"
          right={
            engine === 'checking' ? (
              <View style={styles.checking}>
                <ActivityIndicator size="small" color={colors.textTertiary} />
                <Text style={[styles.checkingText, { color: colors.textSecondary }]}>Checking…</Text>
              </View>
            ) : (
              <StatusPill ok={engine === 'ready'}>
                {engine === 'ready' ? 'Engine ready' : 'Engine offline'}
              </StatusPill>
            )
          }
        />
      </Section>

      {engineError ? (
        <Text style={[styles.error, { color: colors.textTertiary }]}>{engineError}</Text>
      ) : null}

      {/* A developer tool: it exercises the shared generation account and is
          meaningless to someone using the app, so release builds leave it out. */}
      {__DEV__ ? (
      <Section
        title="Connection test"
        footer="Checks the key, file upload and all three models. Costs no credits — a real generation is the only thing that does."
      >
        {diag && diag !== 'running'
          ? diag.results.map((r, i) => (
              <Row
                key={r.label}
                last={i === diag.results.length - 1}
                label={r.label}
                right={<StatusPill ok={r.status === 'ok'}>{r.status === 'ok' ? 'OK' : 'Failed'}</StatusPill>}
              />
            ))
          : null}

        {diag && diag !== 'running' ? (
          <View style={styles.padded}>
            <Text style={[styles.diagDetail, { color: colors.textTertiary }]}>
              {diag.results.map(r => `${r.label}: ${r.detail}`).join('\n')}
            </Text>
          </View>
        ) : null}

        <View style={styles.padded}>
          {diag === 'running' ? (
            <View style={styles.checking}>
              <ActivityIndicator size="small" color={colors.brand} />
              <Text style={[styles.checkingText, { color: colors.textSecondary }]}>
                Testing… {diagStep}
              </Text>
            </View>
          ) : (
            <Button
              title={diag ? `Run again (${diag.passed}/${diag.total} passed)` : 'Test connection'}
              variant={diag && diag.passed === diag.total ? 'secondary' : 'primary'}
              onPress={runChecks}
            />
          )}
        </View>
      </Section>
      ) : null}

      <Section
        title="Delete account"
        footer="Permanently deletes your account and every influencer, generation and stored file in it. This cannot be undone."
      >
        <View style={styles.padded}>
          <Button title="Delete my account" variant="danger" onPress={() => setDeleteOpen(true)} />
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
      Alert.alert('Account deleted', 'Your account and everything in it have been deleted.')
    } catch (e) {
      setError(userMessage(e, 'Could not delete the account. Please try again.'))
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
          <Text style={[styles.dialogTitle, { color: colors.textPrimary }]}>Delete your account?</Text>
          <Text style={[styles.dialogBody, { color: colors.textSecondary }]}>
            Every influencer, generation and stored file is deleted permanently, and anything
            still generating is lost. Enter your password to confirm.
          </Text>

          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="Your password"
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
            <View style={styles.checking}>
              <ActivityIndicator size="small" color={colors.danger} />
              <Text style={[styles.checkingText, { color: colors.textSecondary }]}>Deleting…</Text>
            </View>
          ) : (
            <View style={styles.dialogActions}>
              <Button title="Delete permanently" variant="danger" onPress={confirm} disabled={!password} />
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
      Alert.alert('Password changed', 'Use your new password the next time you sign in.')
    } catch (e) {
      setError(userMessage(e, 'Could not change the password. Please try again.'))
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
            {problem || `At least ${MIN_PASSWORD_LENGTH} characters, with a letter and a number.`}
          </Text>
          <TextInput
            value={confirm}
            onChangeText={setConfirm}
            placeholder="New password again"
            textContentType="newPassword"
            autoComplete="new-password"
            returnKeyType="go"
            onSubmitEditing={submit}
            {...secret}
            style={inputStyle(mismatch)}
          />
          {mismatch ? <Text style={[styles.dialogError, { color: colors.danger }]}>These do not match.</Text> : null}
          {error ? <Text style={[styles.dialogError, { color: colors.danger }]}>{error}</Text> : null}

          {busy ? (
            <View style={styles.checking}>
              <ActivityIndicator size="small" color={colors.brand} />
              <Text style={[styles.checkingText, { color: colors.textSecondary }]}>Changing…</Text>
            </View>
          ) : (
            <View style={styles.dialogActions}>
              <Button title="Change password" onPress={submit} disabled={!canSubmit} />
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
  checking: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  checkingText: { fontSize: 14 },
  diagDetail: { fontSize: 12, lineHeight: 18 },
  error: { fontSize: 12, lineHeight: 17, marginTop: -space.lg, marginBottom: space.xl, marginHorizontal: space.xs },

  backdrop: { flex: 1, justifyContent: 'center', padding: space.xl, backgroundColor: 'rgba(0,0,0,0.55)' },
  dialog: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, padding: space.xl, gap: space.md },
  dialogTitle: { fontSize: 18, fontWeight: '700' },
  dialogBody: { fontSize: 14, lineHeight: 20 },
  dialogError: { fontSize: 13, lineHeight: 18 },
  dialogHint: { fontSize: 12, lineHeight: 17, marginTop: -space.xs },
  dialogActions: { gap: space.sm },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: space.md, paddingVertical: space.md, fontSize: 15 },
})
