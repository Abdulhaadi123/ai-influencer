/**
 * The live prompt suggestion card.
 *
 * Sits under a prompt field and offers a stronger rewrite. It is explicitly a
 * suggestion: the user's own text is never modified unless they tap "Use suggestion".
 *
 * In the design it is a dashed, frosted card with a small orb beside "Suggestions", the
 * suggested text in violet, and a white pill to accept it.
 *
 * It is also where the assistant says something about the text itself: that it goes against the
 * content guidelines (`notice.tone` "blocked"), that it may ("warning"), or that nothing could be
 * done with it ("info"). Silence here read as "nothing happened", which was the wrong answer to a
 * description the server had refused.
 */

import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native'

import { useTheme, space, radius, font } from '../theme'
import { Orb } from './brand'
import Icon from './icons'

function Notice({ notice, onDismiss }) {
  const { colors } = useTheme()
  const look = {
    blocked: { fg: colors.danger, bg: colors.dangerSoft, icon: 'warning' },
    warning: { fg: colors.warning, bg: colors.warningSoft, icon: 'warning' },
    info: { fg: colors.textSecondary, bg: colors.accentSoft, icon: 'sparkle' },
  }[notice.tone] || { fg: colors.textSecondary, bg: colors.accentSoft, icon: 'sparkle' }

  return (
    <View
      accessibilityRole="alert"
      style={[styles.notice, { backgroundColor: look.bg, borderColor: look.fg }]}
    >
      <View style={styles.noticeIcon}><Icon name={look.icon} size={20} color={look.fg} /></View>
      <Text style={[styles.noticeText, { color: colors.textPrimary }]}>{notice.message}</Text>
      {onDismiss ? (
        <Pressable onPress={onDismiss} hitSlop={10} accessibilityRole="button" accessibilityLabel="Dismiss">
          <Icon name="close" size={16} color={colors.textTertiary} />
        </Pressable>
      ) : null}
    </View>
  )
}

export default function PromptSuggestion({ suggestion, notice, loading, onUse, onDismiss }) {
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

  if (!suggestion) return notice ? <Notice notice={notice} onDismiss={onDismiss} /> : null

  return (
    <>
    {notice ? <Notice notice={notice} /> : null}
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
    </>
  )
}

const styles = StyleSheet.create({
  notice: {
    flexDirection: 'row', alignItems: 'flex-start', gap: space.md,
    borderWidth: 1, borderRadius: radius.md, padding: space.md + 2, marginTop: space.md,
  },
  noticeIcon: { marginTop: 1 },
  noticeText: { flex: 1, fontSize: 13.5, lineHeight: 19 },

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
