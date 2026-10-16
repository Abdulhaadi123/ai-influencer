/**
 * "Report this result" — a small sheet that asks what is wrong, once.
 *
 * Android's Alert holds at most three buttons, and there are four reasons plus
 * Cancel, so this is a sheet of its own rather than an Alert with a dropdown's
 * worth of buttons.
 *
 * It calls `onSubmit(reasonId)` and waits for it: the rows are disabled while a
 * report is on its way, so a double tap cannot send two. The caller shows the
 * outcome (success or error) — this only closes itself once the report is sent.
 */

import { useState } from 'react'
import { View, Text, Pressable, Modal, StyleSheet, ActivityIndicator } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { REPORT_REASONS } from '@core/data/reports'
import { useTheme, space, radius, font, layout } from '../theme'

/**
 * @param {object} props
 * @param {boolean} props.visible
 * @param {() => void} props.onClose
 * @param {(reasonId: string) => Promise<void>} props.onSubmit  rejects to keep the sheet open
 */
export default function ReportSheet({ visible, onClose, onSubmit }) {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const [sending, setSending] = useState(false)

  const choose = async reasonId => {
    if (sending) return
    setSending(true)
    try {
      await onSubmit(reasonId)
      onClose()
    } catch {
      // The caller has already told the person what went wrong; the sheet stays
      // open so they can try again or cancel.
    } finally {
      setSending(false)
    }
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={sending ? undefined : onClose} statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={sending ? undefined : onClose} accessibilityLabel="Close">
        {/* A press on the sheet itself must not fall through to the backdrop. */}
        <Pressable
          onPress={() => {}}
          style={[styles.sheet, { backgroundColor: colors.sheet, paddingBottom: insets.bottom + space.lg }]}
        >
          <Text style={[styles.title, font('bold'), { color: colors.textPrimary }]}>Report this result</Text>
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
            What is wrong with it? We review every report.
          </Text>

          <View style={styles.rows}>
            {REPORT_REASONS.map(reason => (
              <Pressable
                key={reason.id}
                onPress={() => choose(reason.id)}
                disabled={sending}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.row,
                  { backgroundColor: colors.field, borderColor: colors.glassEdge, opacity: sending ? 0.5 : pressed ? 0.7 : 1 },
                ]}
              >
                <Text style={[styles.rowText, font('regular'), { color: colors.textPrimary }]}>{reason.label}</Text>
              </Pressable>
            ))}
          </View>

          {sending ? <ActivityIndicator style={styles.spinner} color={colors.primary} /> : null}

          <Pressable onPress={onClose} disabled={sending} accessibilityRole="button" style={styles.cancel}>
            <Text style={[styles.cancelText, font('medium'), { color: colors.textSecondary }]}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(8,3,83,0.45)', justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl,
    paddingHorizontal: layout.pageGutter, paddingTop: space.xl,
  },
  title: { fontSize: 18 },
  subtitle: { fontSize: 13.5, lineHeight: 19, marginTop: 4, marginBottom: space.lg },
  rows: { gap: space.sm },
  row: {
    minHeight: 48, borderRadius: radius.pill, borderWidth: 1,
    paddingHorizontal: space.xl - 2, justifyContent: 'center',
  },
  rowText: { fontSize: 15 },
  spinner: { marginTop: space.md },
  cancel: { alignItems: 'center', paddingVertical: space.md, marginTop: space.sm },
  cancelText: { fontSize: 15 },
})
