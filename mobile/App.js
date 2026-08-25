import { useEffect, useState } from 'react'
import { SafeAreaView, ScrollView, View, Text, StyleSheet, ActivityIndicator, useColorScheme } from 'react-native'
import { StatusBar } from 'expo-status-bar'

// Everything below comes from the SHARED core — the exact same modules the web
// app runs. Nothing here is duplicated logic.
import { IMAGE_MODEL_ID, VIDEO_MODEL_KLING, MOTION_MODEL_KIE } from '@core/config/generation'
import { checkKieConnection } from '@core/api/kieAuth'
import { StoreProvider, useInfluencers } from '@core/store'

/**
 * Step 2 smoke screen.
 *
 * Its job is to prove the migration's foundation works on a device:
 *   1. the `@core` alias resolves to ../src/core through Metro,
 *   2. the platform boundary picks the NATIVE implementations
 *      (apiUrl.native.js builds absolute URLs, storage.native.js uses MMKV,
 *      app.native.js handles reloads),
 *   3. the shared store — the SAME React context the web app runs — mounts and
 *      reads persisted influencers through MMKV,
 *   4. a real request reaches the deployed backend and the KIE key answers.
 *
 * The actual app screens are ported in the following steps.
 */
export default function App() {
  return (
    <StoreProvider>
      <HomeScreen />
    </StoreProvider>
  )
}

function HomeScreen() {
  const isDark = useColorScheme() === 'dark'
  const t = isDark ? dark : light

  const [status, setStatus] = useState('checking')
  const [error, setError] = useState(null)

  // The shared store, straight out of core — no mobile-specific copy.
  // Same [value, setValue] tuple the web pages consume.
  const [influencers] = useInfluencers()

  useEffect(() => {
    let alive = true
    checkKieConnection()
      .then(ok => { if (alive) setStatus(ok ? 'ready' : 'offline') })
      .catch(e => { if (alive) { setStatus('offline'); setError(e?.message ?? String(e)) } })
    return () => { alive = false }
  }, [])

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: t.bg }]}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={[styles.title, { color: t.text }]}>AI Influencer</Text>
        <Text style={[styles.subtitle, { color: t.dim }]}>
          React Native · shared core
        </Text>

        <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border }]}>
          <Text style={[styles.cardLabel, { color: t.dim }]}>KIE.AI ENGINE</Text>
          <View style={styles.row}>
            {status === 'checking' ? (
              <>
                <ActivityIndicator size="small" color={t.dim} />
                <Text style={[styles.status, { color: t.dim }]}>Checking…</Text>
              </>
            ) : (
              <>
                <View style={[styles.dot, { backgroundColor: status === 'ready' ? '#34C759' : '#FF3B30' }]} />
                <Text style={[styles.status, { color: status === 'ready' ? '#34C759' : '#FF3B30' }]}>
                  {status === 'ready' ? 'Engine ready' : 'Engine offline'}
                </Text>
              </>
            )}
          </View>
          {error ? <Text style={[styles.error, { color: t.dim }]}>{error}</Text> : null}
        </View>

        <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border }]}>
          <Text style={[styles.cardLabel, { color: t.dim }]}>MODELS (FROM SHARED CONFIG)</Text>
          <ModelRow theme={t} name="Image" value={IMAGE_MODEL_ID} />
          <ModelRow theme={t} name="Video" value={VIDEO_MODEL_KLING} />
          <ModelRow theme={t} name="Motion" value={MOTION_MODEL_KIE} />
        </View>

        <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border }]}>
          <Text style={[styles.cardLabel, { color: t.dim }]}>
            SHARED STORE · {influencers.length} INFLUENCER{influencers.length === 1 ? '' : 'S'}
          </Text>
          {influencers.length === 0 ? (
            <Text style={[styles.modelName, { color: t.dim }]}>
              No influencers stored yet.
            </Text>
          ) : (
            influencers.map(inf => (
              <ModelRow
                key={inf.id}
                theme={t}
                name={inf.name || 'Unnamed'}
                value={inf.niche || inf.gender || '—'}
              />
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

function ModelRow({ theme, name, value }) {
  return (
    <View style={styles.modelRow}>
      <Text style={[styles.modelName, { color: theme.dim }]}>{name}</Text>
      <Text style={[styles.modelValue, { color: theme.text }]} numberOfLines={1}>{value}</Text>
    </View>
  )
}

const light = { bg: '#FFFFFF', surface: '#F7F7F8', border: '#E5E5EA', text: '#1D1D1F', dim: '#6E6E73' }
const dark  = { bg: '#000000', surface: '#1C1C1E', border: '#2C2C2E', text: '#F5F5F7', dim: '#98989D' }

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scroll: { padding: 24, gap: 16 },
  title: { fontSize: 30, fontWeight: '700', letterSpacing: -0.5 },
  subtitle: { fontSize: 14, marginTop: -10, marginBottom: 8 },
  card: { borderRadius: 16, borderWidth: 1, padding: 18, gap: 12 },
  cardLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  status: { fontSize: 14, fontWeight: '600' },
  error: { fontSize: 12, lineHeight: 17 },
  modelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  modelName: { fontSize: 13 },
  modelValue: { fontSize: 13, fontWeight: '600', flexShrink: 1 },
})
