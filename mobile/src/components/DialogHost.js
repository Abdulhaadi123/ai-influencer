/**
 * The app's message box — what every Alert.alert and showDialog (lib/dialog.js) draws.
 *
 * Mounted once, above the navigator (navigation/index.js). The same dimmed page and rounded sheet
 * as the purchase notice and Settings' dialogs, so no message in the app is the grey system box.
 * It says what KIND of message it is before anyone reads it — a coloured icon for information,
 * success, a warning, something that cannot be undone — then the title, a line, an optional table
 * of figures (the credits a generation needs, what you have, what is missing), and the buttons,
 * stacked, the main one first and the way out last.
 *
 * It arrives with a short pop and fade; a person who asked their phone for less motion gets it
 * at once. The back button and a tap outside close it, unless the caller said it must be answered.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { AccessibilityInfo, Animated, Dimensions, Easing, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'

import { useTheme, space, font } from '../theme'
import { subscribeDialogs, currentDialog, closeDialog } from '../lib/dialog'
import Icon from './icons'
import { Button } from './ui'

/** Icon and colours for each tone, from the theme so Light and Dark both work. */
function look(tone, colors) {
  switch (tone) {
    case 'success': return { icon: 'check', fg: colors.success, bg: `${colors.success}24` }
    case 'warning': return { icon: 'warning', fg: colors.warning, bg: colors.warningSoft }
    case 'danger': return { icon: 'warning', fg: colors.danger, bg: colors.dangerSoft }
    default: return { icon: 'sparkle', fg: colors.primary, bg: colors.accentSoft }
  }
}

export default function DialogHost() {
  const { colors } = useTheme()
  const dialog = useSyncExternalStore(subscribeDialogs, currentDialog)

  // The pop-in, restarted for each dialog (the next one in line replaces the one closed).
  const pop = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (!dialog) return undefined
    let cancelled = false
    let run = null
    pop.setValue(0)
    AccessibilityInfo.isReduceMotionEnabled().then(reduced => {
      if (cancelled) return
      if (reduced) { pop.setValue(1); return }
      run = Animated.timing(pop, { toValue: 1, duration: 260, easing: Easing.out(Easing.back(1.2)), useNativeDriver: true })
      run.start()
    }).catch(() => pop.setValue(1))
    return () => { cancelled = true; run?.stop() }
  }, [dialog, pop])

  /** Close first, then do what the button does — so the box is gone when a screen opens behind it. */
  const choose = useCallback(action => {
    closeDialog()
    action.onPress?.()
  }, [])

  const dismiss = useCallback(() => {
    if (!dialog?.dismissable) return
    closeDialog()
    dialog.onDismiss?.()
  }, [dialog])

  const tone = look(dialog?.tone, colors)
  const iconName = dialog?.icon || tone.icon
  const maxBody = Math.round(Dimensions.get('window').height * 0.34)

  return (
    <Modal visible={!!dialog} transparent animationType="fade" onRequestClose={dismiss} statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={dismiss} accessibilityLabel="Close" accessible={false}>
        {dialog ? (
          <Animated.View
            style={{ opacity: pop, transform: [{ scale: pop.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) }] }}
          >
            {/* A tap on the card itself must not reach the backdrop behind it. */}
            <Pressable
              style={[styles.card, { backgroundColor: colors.sheet, borderColor: colors.glassEdge }]}
              onPress={() => {}}
              accessibilityViewIsModal
              accessibilityLiveRegion="polite"
            >
              <View style={[styles.iconDisc, { backgroundColor: tone.bg }]}>
                <Icon name={iconName} size={32} color={tone.fg} />
              </View>

              <Text style={[styles.title, font('bold'), { color: colors.textPrimary }]} accessibilityRole="header">
                {dialog.title}
              </Text>

              {dialog.message ? (
                <ScrollView style={{ maxHeight: maxBody, alignSelf: 'stretch' }} bounces={false} showsVerticalScrollIndicator={false}>
                  <Text style={[styles.message, { color: colors.textSecondary }]}>{dialog.message}</Text>
                </ScrollView>
              ) : null}

              {dialog.facts?.length ? (
                <View style={[styles.facts, { backgroundColor: colors.surfaceAlt, borderColor: colors.borderSubtle }]}>
                  {dialog.facts.map((f, i) => (
                    <View
                      key={f.label}
                      style={[styles.factRow, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSubtle }]}
                    >
                      <Text style={[styles.factLabel, f.emphasis ? font('semibold') : null, { color: f.emphasis ? colors.textPrimary : colors.textSecondary }]}>
                        {f.label}
                      </Text>
                      <Text style={[styles.factValue, font('bold'), { color: f.emphasis ? colors.danger : colors.textPrimary }]}>
                        {f.value}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}

              <View style={styles.actions}>
                {dialog.actions.map(a => (a.kind === 'cancel' ? (
                  <Pressable
                    key={a.label}
                    onPress={() => choose(a)}
                    accessibilityRole="button"
                    hitSlop={6}
                    style={({ pressed }) => [styles.cancel, { opacity: pressed ? 0.6 : 1 }]}
                  >
                    <Text style={[styles.cancelText, font('medium'), { color: colors.textSecondary }]}>{a.label}</Text>
                  </Pressable>
                ) : (
                  <Button
                    key={a.label}
                    title={a.label}
                    variant={a.kind === 'danger' ? 'danger' : a.kind === 'secondary' ? 'soft' : 'primary'}
                    onPress={() => choose(a)}
                  />
                )))}
              </View>
            </Pressable>
          </Animated.View>
        ) : null}
      </Pressable>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'center', padding: space.xl, backgroundColor: 'rgba(8,3,83,0.55)' },
  card: { borderRadius: 28, borderWidth: 1, paddingHorizontal: space.xl, paddingTop: space.xl, paddingBottom: space.lg, alignItems: 'center', gap: space.md },
  iconDisc: { width: 68, height: 68, borderRadius: 34, alignItems: 'center', justifyContent: 'center', marginBottom: space.xs },
  title: { fontSize: 21, letterSpacing: -0.3, textAlign: 'center' },
  message: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
  facts: { alignSelf: 'stretch', borderRadius: 18, borderWidth: 1, paddingHorizontal: space.lg, marginTop: space.xs },
  factRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md, paddingVertical: 11 },
  factLabel: { fontSize: 14 },
  factValue: { fontSize: 15 },
  actions: { alignSelf: 'stretch', gap: space.sm, marginTop: space.sm },
  cancel: { alignItems: 'center', justifyContent: 'center', minHeight: 44 },
  cancelText: { fontSize: 15 },
})
