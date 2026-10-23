/**
 * The card that says a purchase worked — "Credits added", with the tick that draws itself.
 *
 * Mounted once, above the navigator (navigation/index.js), and shown through announcePurchase
 * (lib/purchaseAlert.js), so the Credits screen and both offer screens show the same thing and
 * none of them carries its own copy of it. The same dimmed page and rounded sheet as the app's
 * other dialogs (Settings), not the system alert it replaces.
 *
 * One notice at a time: a second purchase cannot start while the first is being announced
 * (usePackStore is busy until it returns), so there is no queue to keep.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal, View, Text, StyleSheet } from 'react-native'

import { useTheme, space, font } from '../theme'
import { registerPurchaseNoticeHost } from '../lib/purchaseAlert'
import SuccessTick from './SuccessTick'
import Icon from './icons'
import { Button } from './ui'

export default function PurchaseNoticeHost() {
  const { colors } = useTheme()
  const [notice, setNotice] = useState(null)
  // What to run when it is closed, kept outside state so a second close cannot run it twice.
  const onDoneRef = useRef(null)

  useEffect(() => registerPurchaseNoticeHost(next => {
    onDoneRef.current = next.onDone || null
    setNotice(next)
  }), [])

  const close = useCallback(() => {
    const done = onDoneRef.current
    onDoneRef.current = null
    setNotice(null)
    done?.()
  }, [])

  return (
    <Modal visible={!!notice} transparent animationType="fade" onRequestClose={close} statusBarTranslucent>
      <View style={styles.backdrop}>
        <View
          style={[styles.card, { backgroundColor: colors.sheet, borderColor: colors.glassEdge }]}
          accessibilityViewIsModal
          accessibilityLiveRegion="polite"
        >
          {notice?.arrived ? (
            <SuccessTick size={112} />
          ) : (
            <View style={[styles.pending, { backgroundColor: colors.accentSoft }]}>
              <Icon name="clock" size={40} color={colors.primary} />
            </View>
          )}
          <Text style={[styles.title, font('bold'), { color: colors.textPrimary }]} accessibilityRole="header">
            {notice?.title}
          </Text>
          <Text style={[styles.body, { color: colors.textSecondary }]}>{notice?.body}</Text>
          <View style={styles.action}>
            <Button title="Done" onPress={close} />
          </View>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'center', padding: space.xl, backgroundColor: 'rgba(8,3,83,0.55)' },
  card: { borderRadius: 28, borderWidth: 1, paddingHorizontal: space.xl, paddingTop: space.xl, paddingBottom: space.xl, alignItems: 'center', gap: space.md },
  pending: { width: 88, height: 88, borderRadius: 44, alignItems: 'center', justifyContent: 'center', marginVertical: space.md },
  title: { fontSize: 22, letterSpacing: -0.3, textAlign: 'center' },
  body: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
  action: { alignSelf: 'stretch', marginTop: space.sm },
})
