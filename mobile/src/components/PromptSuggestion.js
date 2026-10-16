/**
 * The live prompt suggestion card.
 *
 * Sits under a prompt field and offers a stronger rewrite. It is explicitly a
 * suggestion: the user's own text is never modified unless they tap "Use suggestion".
 *
 * In the design it is a dashed, frosted card with a small orb beside "Suggestions", the
 * suggested text in violet, and a white pill to accept it.
 */

import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native'

import { useTheme, space, radius, font } from '../theme'
import { Orb } from './brand'

export default function PromptSuggestion({ suggestion, loading, onUse, onDismiss }) {
  const { colors } = useTheme()

  if (loading) {
    return (
      <View style={[styles.wrap, styles.loadingWrap, { borderColor: colors.border }]}>
        <ActivityIndicator size="small" color={colors.textTertiary} />
        <Text style={[styles.loadingText, { color: colors.textTertiary }]}>
          Improving your text…
        </Text>
      </View>
    )
  }

  if (!suggestion) return null

  return (
    <View style={[styles.wrap, { borderColor: colors.border, backgroundColor: colors.glass }]}>
      <View style={styles.header}>
        <View style={styles.title}>
          <Orb size={14} id="suggestionOrb" />
          <Text style={[styles.label, font('medium'), { color: colors.textPrimary }]}>Suggestions</Text>
        </View>
        <Pressable onPress={onDismiss} hitSlop={10} accessibilityRole="button">
          <Text style={[styles.dismiss, font('medium'), { color: colors.textTertiary }]}>Dismiss</Text>
        </Pressable>
      </View>

      <Text style={[styles.text, { color: colors.primary }]}>{suggestion}</Text>

      <Pressable
        onPress={onUse}
        accessibilityRole="button"
        accessibilityLabel="Use suggestion"
        style={({ pressed }) => [
          styles.use,
          { backgroundColor: colors.isDark ? 'rgba(255,255,255,0.92)' : '#FFFFFF', opacity: pressed ? 0.85 : 1 },
        ]}
      >
        <Text style={[styles.useText, font('medium'), { color: colors.primary }]}>Use Suggestion</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    borderWidth: 1.2,
    borderStyle: 'dashed',
    borderRadius: radius.lg,
    padding: space.lg,
    marginTop: space.md,
    gap: space.md,
  },
  loadingWrap: { flexDirection: 'row', alignItems: 'center', gap: space.sm, borderRadius: radius.md },
  loadingText: { fontSize: 12.5 },

  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  label: { fontSize: 15 },
  dismiss: { fontSize: 12.5 },

  text: { fontSize: 13.5, lineHeight: 20 },

  use: { minHeight: 46, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.xl },
  useText: { fontSize: 15 },
})
