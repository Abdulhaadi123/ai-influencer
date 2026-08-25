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
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { checkKieConnection } from '@core/api/kieAuth'
import * as storage from '@core/platform/storage'

import { useTheme, space } from '../theme'
import { Section, Row, StatusPill, Segmented, Button } from '../components/ui'

// Same key the web app uses, so the value means the same thing on both.
const CLAUDE_KEY = 'claude_api_key'

export default function SettingsScreen() {
  const { colors, preference, setPreference } = useTheme()
  const insets = useSafeAreaInsets()

  const [engine, setEngine] = useState('checking') // checking | ready | offline
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
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xxl }]}
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
        footer="The app uses a KIE.AI key configured on the server. You don't need to sign in or connect an account."
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
  error: { fontSize: 12, lineHeight: 17, marginTop: -space.lg, marginBottom: space.xl, marginHorizontal: space.xs },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: space.md, paddingVertical: space.md, fontSize: 15 },
  buttonRow: { flexDirection: 'row', gap: space.md },
  flex: { flex: 1 },
})
