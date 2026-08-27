/**
 * The live prompt suggestion card.
 *
 * Sits under a prompt field and offers a stronger rewrite. It is explicitly a
 * suggestion: the user's own text is never modified unless they tap "Use this".
 */

import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native'

import { useTheme, space, radius } from '../theme'

export default function PromptSuggestion({ suggestion, loading, onUse, onDismiss }) {
  const { colors } = useTheme()

  if (loading) {
    return (
      <View style={[styles.wrap, styles.loadingWrap, { borderColor: colors.borderSubtle }]}>
        <ActivityIndicator size="small" color={colors.textTertiary} />
        <Text style={[styles.loadingText, { color: colors.textTertiary }]}>
          Improving your prompt…
        </Text>
      </View>
    )
  }

  if (!suggestion) return null

  return (
    <View style={[styles.wrap, { borderColor: colors.brand, backgroundColor: colors.brandSoft }]}>
      <View style={styles.header}>
        <Text style={[styles.label, { color: colors.brandDeep }]}>✦ SUGGESTED</Text>
        <Pressable onPress={onDismiss} hitSlop={10} accessibilityRole="button">
          <Text style={[styles.dismiss, { color: colors.textTertiary }]}>Hide</Text>
        </Pressable>
      </View>

      <Text style={[styles.text, { color: colors.textPrimary }]}>{suggestion}</Text>

      <View style={styles.actions}>
        <Pressable
          onPress={onUse}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.use,
            { backgroundColor: colors.brand, opacity: pressed ? 0.85 : 1 },
          ]}
        >
          <Text style={styles.useText}>Use this</Text>
        </Pressable>
        <Text style={[styles.keep, { color: colors.textSecondary }]}>
          or keep your own
        </Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    borderWidth: 1.5,
    borderRadius: radius.md,
    padding: space.md,
    marginTop: space.md,
    gap: space.sm,
  },
  loadingWrap: { flexDirection: 'row', alignItems: 'center', gap: space.sm, borderStyle: 'dashed' },
  loadingText: { fontSize: 12.5 },

  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6 },
  dismiss: { fontSize: 12.5, fontWeight: '600' },

  text: { fontSize: 14, lineHeight: 20 },

  actions: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.xs },
  use: { paddingVertical: 7, paddingHorizontal: 14, borderRadius: radius.sm },
  useText: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
  keep: { fontSize: 12.5 },
})
