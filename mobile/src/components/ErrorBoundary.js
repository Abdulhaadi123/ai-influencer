/**
 * The last line of defence for a crash while rendering.
 *
 * Without a boundary React unmounts the whole tree on an uncaught render error:
 * a blank screen in a release build, with no way back but force-quitting.
 * This keeps the damage to a recoverable screen. Work is not lost by it —
 * everything is saved to the account as it happens — so the message says so.
 */

import { Component } from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'

import { useTheme, space, radius } from '../theme'

export default class ErrorBoundary extends Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[app] a screen crashed while rendering:', error, info?.componentStack)
  }

  retry = () => this.setState({ error: null })

  render() {
    if (!this.state.error) return this.props.children
    return <CrashScreen error={this.state.error} onRetry={this.retry} />
  }
}

function CrashScreen({ error, onRetry }) {
  const { colors } = useTheme()
  return (
    <View style={[styles.wrap, { backgroundColor: colors.bg }]}>
      <Text style={[styles.title, { color: colors.textPrimary }]}>This screen ran into a problem</Text>
      <Text style={[styles.body, { color: colors.textSecondary }]}>
        Your influencers and generations are safe — they are saved to your account as
        you go. Try again, and if it keeps happening, close and reopen the app.
      </Text>
      {__DEV__ ? (
        <Text style={[styles.detail, { color: colors.danger }]} numberOfLines={6}>
          {String(error?.message || error)}
        </Text>
      ) : null}
      <Pressable
        onPress={onRetry}
        accessibilityRole="button"
        style={({ pressed }) => [styles.button, { backgroundColor: colors.brand, opacity: pressed ? 0.85 : 1 }]}
      >
        <Text style={styles.buttonText}>Try again</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl, gap: space.md },
  title: { fontSize: 19, fontWeight: '700', textAlign: 'center' },
  body: { fontSize: 14, lineHeight: 21, textAlign: 'center' },
  detail: { fontSize: 12, lineHeight: 17, textAlign: 'center' },
  button: { marginTop: space.md, paddingVertical: space.md, paddingHorizontal: space.xl, borderRadius: radius.md },
  buttonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
})
