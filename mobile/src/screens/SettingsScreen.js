/**
 * Settings — the native counterpart of src/pages/Settings.jsx.
 *
 * Same three concerns as the web page (appearance, engine status, Claude key),
 * rebuilt with native idioms: grouped list sections, a segmented control, and
 * a secure text field. Appearance gains a "System" option, which is standard
 * on mobile and has no real equivalent on the web page.
 */

import { useEffect, useState, useCallback } from 'react'
import { View, Text, TextInput, ScrollView, ActivityIndicator, StyleSheet, Alert } from 'react-native'

import { useBottomInset } from '../hooks/useBottomInset'

import { checkKieConnection } from '@core/api/kieAuth'
import { runDiagnostics } from '@core/api/diagnostics'
import * as storage from '@core/platform/storage'

import { useTheme, space } from '../theme'
import { Section, Row, StatusPill, Segmented, Button } from '../components/ui'

// Same key the web app uses, so the value means the same thing on both.
const CLAUDE_KEY = 'claude_api_key'

export default function SettingsScreen() {
  const { colors, preference, setPreference } = useTheme()
  const bottomInset = useBottomInset()

  const [engine, setEngine] = useState('checking') // checking | ready | offline
  const [diag, setDiag] = useState(null)          // null | 'running' | results
  const [diagStep, setDiagStep] = useState('')
  const [engineError, setEngineError] = useState(null)

  const [claudeKey, setClaudeKey] = useState(() => storage.getItem(CLAUDE_KEY) || '')
  const [claudeInput, setClaudeInput] = useState('')
  const [editingClaude, setEditingClaude] = useState(false)

  useEffect(() => {
    let alive = true
    checkKieConnection()
      .then(ok => { if (alive) setEngine(ok ? 'ready' : 'offline') })
      .catch(e => { if (alive) { setEngine('offline'); setEngineError(e?.message ?? String(e)) } })
    return () => { alive = false }
  }, [])

  const runChecks = useCallback(async () => {
    setDiag('running')
    setDiagStep('')
    try {
      const out = await runDiagnostics((done, total) => setDiagStep(`${done}/${total}`))
      setDiag(out)
    } catch (e) {
      setDiag({ results: [{ label: 'Diagnostics', status: 'fail', detail: e?.message ?? 'failed' }], passed: 0, total: 1 })
    }
  }, [])

  const saveClaudeKey = useCallback(() => {
    const k = claudeInput.trim()
    if (!k) return
    try {
      storage.setItem(CLAUDE_KEY, k)
      setClaudeKey(k)
      setClaudeInput('')
      setEditingClaude(false)
    } catch (e) {
      Alert.alert('Could not save', e?.message ?? 'Storage is unavailable.')
    }
  }, [claudeInput])

  const removeClaudeKey = useCallback(() => {
    Alert.alert('Remove API key?', 'Claude features will stop working until you add it again.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          try { storage.removeItem(CLAUDE_KEY) } catch {}
          setClaudeKey('')
          setClaudeInput('')
          setEditingClaude(false)
        },
      },
    ])
  }, [])

  return (
    <ScrollView
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]}
      keyboardShouldPersistTaps="handled"
    >
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
        title="KIE.AI Engine"
        footer="The app calls KIE.AI directly using the key in mobile/.env. No sign-in, and no backend of our own."
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

      <Section
        title="Connection test"
        footer="Checks the key, file upload and all three models. Costs no credits — a real generation is the only thing that does."
      >
        {diag && diag !== 'running' ? (
          diag.results.map((r, i) => (
            <Row
              key={r.label}
              last={i === diag.results.length - 1}
              label={r.label}
              right={<StatusPill ok={r.status === 'ok'}>{r.status === 'ok' ? 'OK' : 'Failed'}</StatusPill>}
            />
          ))
        ) : null}

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
              title={diag ? `Run again (${diag.passed}/${diag.total} passed)` : 'Test KIE connection'}
              variant={diag && diag.passed === diag.total ? 'secondary' : 'primary'}
              onPress={runChecks}
            />
          )}
        </View>
      </Section>

      <Section
        title="Claude AI"
        footer="Optional. Lets Claude analyse a product image before the character sheet is generated."
      >
        {claudeKey && !editingClaude ? (
          <>
            <Row label="API key" value={`••••${claudeKey.slice(-4)}`} last={false} />
            <View style={styles.padded}>
              <Button title="Remove key" variant="danger" onPress={removeClaudeKey} />
            </View>
          </>
        ) : editingClaude ? (
          <View style={[styles.padded, { gap: space.md }]}>
            <TextInput
              autoFocus
              value={claudeInput}
              onChangeText={setClaudeInput}
              placeholder="sk-ant-..."
              placeholderTextColor={colors.textTertiary}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={saveClaudeKey}
              returnKeyType="done"
              style={[styles.input, {
                color: colors.textPrimary,
                borderColor: colors.border,
                backgroundColor: colors.bgSecondary,
              }]}
            />
            <View style={styles.buttonRow}>
              <View style={styles.flex}>
                <Button title="Cancel" variant="secondary"
                  onPress={() => { setEditingClaude(false); setClaudeInput('') }} />
              </View>
              <View style={styles.flex}>
                <Button title="Save" onPress={saveClaudeKey} disabled={!claudeInput.trim()} />
              </View>
            </View>
          </View>
        ) : (
          <View style={styles.padded}>
            <Button title="Add API key" onPress={() => setEditingClaude(true)} />
          </View>
        )}
      </Section>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingTop: space.xl },
  padded: { padding: space.lg },
  checking: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  checkingText: { fontSize: 14 },
  diagDetail: { fontSize: 12, lineHeight: 18 },
  error: { fontSize: 12, lineHeight: 17, marginTop: -space.lg, marginBottom: space.xl, marginHorizontal: space.xs },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: space.md, paddingVertical: space.md, fontSize: 15 },
  buttonRow: { flexDirection: 'row', gap: space.md },
  flex: { flex: 1 },
})
