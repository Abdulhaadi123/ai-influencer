/**
 * The pill that says a share is being prepared.
 *
 * Tapping Share on a picture or clip that is not already on the phone downloads it first (the share sheet needs
 * a file), which can take a while on a phone connection. This sits above the tab bar for as long as that lasts:
 * a spinner, "Preparing to share… 42%", and a cross that stops it. A share that is ready at once (a picture
 * already on the screen) never shows it: it appears only after a third of a second.
 *
 * Mounted once, above the navigator (navigation/index.js). The state is lib/shareStatus.js; the words and the
 * arithmetic are core/media/shareProgress.js.
 *
 * A full-screen Modal (the gallery's viewer) is a window of its own, drawn above everything the navigator
 * holds, so the pill mounted there is hidden behind it — and Share is a button IN that viewer. The viewer
 * mounts its own copy with `placement="top"`, under its header: there is no tab bar in it, and the bottom is
 * where its Share, Report and Delete buttons are.
 */

import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { progressLabel, PILL_DELAY_MS } from '@core/media/shareProgress'

import { useTheme, space, font } from '../theme'
import { useShareStatus } from '../lib/shareStatus'
import Icon from './icons'

/** @param {{placement?: 'bottom'|'top'}} props  'bottom' sits above the tab bar; 'top' sits under a viewer's header. */
export default function ShareStatusHost({ placement = 'bottom' }) {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const status = useShareStatus()

  // Drawn only once the share has taken a moment, so one that is instant does not flash it.
  const [late, setLate] = useState(false)
  useEffect(() => {
    if (!status.active) { setLate(false); return undefined }
    const timer = setTimeout(() => setLate(true), PILL_DELAY_MS)
    return () => clearTimeout(timer)
  }, [status.active])

  if (!status.active || !late) return null
  const label = progressLabel(status.progress)

  return (
    <View
      style={[styles.layer, placement === 'top' ? { top: insets.top + 76 } : { bottom: insets.bottom + 108 }]}
      pointerEvents="box-none"
    >
      <View
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        style={[styles.pill, { backgroundColor: colors.sheet, borderColor: colors.glassEdge }]}
      >
        <ActivityIndicator size="small" color={colors.primary} />
        <Text style={[styles.text, font('medium'), { color: colors.textPrimary }]} numberOfLines={1}>{label}</Text>
        {status.cancel ? (
          <Pressable onPress={status.cancel} hitSlop={12} accessibilityRole="button" accessibilityLabel="Cancel sharing" style={styles.cancel}>
            <Icon name="close" size={16} color={colors.textTertiary} />
          </Pressable>
        ) : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  // Above the floating tab bar, which stands about 100 points up from the bottom edge.
  layer: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 40, elevation: 40 },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingVertical: 12, paddingLeft: 16, paddingRight: 12, borderRadius: 26, borderWidth: 1,
    shadowColor: '#080353', shadowOpacity: 0.22, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 10,
  },
  text: { fontSize: 14 },
  cancel: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
})
