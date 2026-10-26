/**
 * A picture full screen, to look at closely: pinch to zoom, drag to look around, double-tap to
 * zoom in on a spot and again to go back.
 *
 * The reference sheets are four poses side by side, or a face at close range — detail is the
 * whole point of them — and they were only ever shown at the width of a card, with no way to
 * open them. This is that way, and the gallery's images use the same zoom.
 *
 * Built on PanResponder rather than a gesture library: the app has none installed, and pinch,
 * drag and double-tap on one picture are within what the core responder can do. The transforms
 * are applied as Animated values, so the picture moves without re-rendering.
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import { Animated, Modal, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useTheme, space, font, layout } from '../theme'
import MediaImage from './MediaImage'

const MAX_SCALE = 5
const DOUBLE_TAP_SCALE = 2.5
const DOUBLE_TAP_MS = 280

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const distance = ([a, b]) => Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY)

/**
 * The picture, zoomable inside whatever box it is given.
 *
 * @param {{uri: string, previewUri?: string|null, contentFit?: 'contain'|'cover', accessibilityLabel?: string}} props
 *        previewUri  the file's small preview, shown at once while the full file loads (MediaImage)
 */
export function ZoomableImage({ uri, previewUri = null, contentFit = 'contain', accessibilityLabel }) {
  const scale = useRef(new Animated.Value(1)).current
  const tx = useRef(new Animated.Value(0)).current
  const ty = useRef(new Animated.Value(0)).current

  // The live numbers, outside React: the responder reads and writes them on every move.
  const g = useRef({ scale: 1, x: 0, y: 0, w: 0, h: 0, pinchFrom: null, panFrom: null, lastTap: 0, moved: false }).current

  /** How far the picture may be dragged at this zoom: no further than its own edge. */
  const bounded = useCallback((x, y, s) => {
    const maxX = (g.w * (s - 1)) / 2
    const maxY = (g.h * (s - 1)) / 2
    return [clamp(x, -maxX, maxX), clamp(y, -maxY, maxY)]
  }, [g])

  const animateTo = useCallback((s, x, y) => {
    g.scale = s; g.x = x; g.y = y
    Animated.parallel([
      Animated.spring(scale, { toValue: s, useNativeDriver: true, friction: 7 }),
      Animated.spring(tx, { toValue: x, useNativeDriver: true, friction: 7 }),
      Animated.spring(ty, { toValue: y, useNativeDriver: true, friction: 7 }),
    ]).start()
  }, [g, scale, tx, ty])

  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    // While zoomed in, a drag belongs to the picture, not to anything behind it.
    onPanResponderTerminationRequest: () => g.scale <= 1,

    onPanResponderGrant: e => {
      g.moved = false
      g.pinchFrom = null
      const t = e.nativeEvent.touches
      g.panFrom = t.length === 1 ? { pageX: t[0].pageX, pageY: t[0].pageY, x: g.x, y: g.y } : null
    },

    onPanResponderMove: e => {
      const t = e.nativeEvent.touches
      if (t.length >= 2) {
        // A pinch: the zoom follows the change in distance between the two fingers.
        if (!g.pinchFrom) g.pinchFrom = { d: distance(t), scale: g.scale }
        g.panFrom = null
        g.moved = true
        const s = clamp(g.pinchFrom.scale * (distance(t) / Math.max(1, g.pinchFrom.d)), 1, MAX_SCALE)
        const [x, y] = bounded(g.x, g.y, s)
        g.scale = s; g.x = x; g.y = y
        scale.setValue(s); tx.setValue(x); ty.setValue(y)
        return
      }
      if (t.length === 1) {
        // One finger: drag the zoomed picture. A finger left behind after a pinch starts afresh.
        if (!g.panFrom) { g.panFrom = { pageX: t[0].pageX, pageY: t[0].pageY, x: g.x, y: g.y }; g.pinchFrom = null; return }
        const dx = t[0].pageX - g.panFrom.pageX
        const dy = t[0].pageY - g.panFrom.pageY
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) g.moved = true
        if (g.scale <= 1) return
        const [x, y] = bounded(g.panFrom.x + dx, g.panFrom.y + dy, g.scale)
        g.x = x; g.y = y
        tx.setValue(x); ty.setValue(y)
      }
    },

    onPanResponderRelease: e => {
      g.pinchFrom = null
      g.panFrom = null
      if (g.moved) {
        if (g.scale <= 1.02) animateTo(1, 0, 0)
        return
      }
      // A tap. Two in quick succession zoom in on that spot, or back out.
      const now = Date.now()
      if (now - g.lastTap < DOUBLE_TAP_MS) {
        g.lastTap = 0
        if (g.scale > 1) { animateTo(1, 0, 0); return }
        const { locationX, locationY } = e.nativeEvent
        // Keep the tapped point under the finger: about the centre, a point p moves to p·s,
        // so the picture shifts back by (p − centre)(s − 1).
        const [x, y] = bounded((g.w / 2 - locationX) * (DOUBLE_TAP_SCALE - 1), (g.h / 2 - locationY) * (DOUBLE_TAP_SCALE - 1), DOUBLE_TAP_SCALE)
        animateTo(DOUBLE_TAP_SCALE, x, y)
      } else {
        g.lastTap = now
      }
    },
  }), [g, bounded, animateTo, scale, tx, ty])

  return (
    <View
      style={styles.zoomBox}
      onLayout={e => { g.w = e.nativeEvent.layout.width; g.h = e.nativeEvent.layout.height }}
      {...responder.panHandlers}
    >
      <Animated.View style={[styles.fill, { transform: [{ translateX: tx }, { translateY: ty }, { scale }] }]} pointerEvents="none">
        <MediaImage uri={uri} previewUri={previewUri} style={styles.fill} contentFit={contentFit} accessibilityLabel={accessibilityLabel} loadingIndicator />
      </Animated.View>
    </View>
  )
}

/**
 * The picture over everything, on black, with a Done button.
 *
 * @param {{uri: string|null, previewUri?: string|null, title?: string, onClose: () => void}} props
 *        visible while `uri` is set; `previewUri` is drawn until the full file has loaded
 */
export default function ImageViewer({ uri, previewUri = null, title, onClose }) {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  // The URL as it was when opened: the roster re-signs URLs every few minutes, and a new one
  // would reload the picture mid-zoom. The cache key is the asset, so nothing is downloaded again.
  const [shown, setShown] = useState(uri)
  if (uri && uri !== shown && !shown) setShown(uri)
  if (!uri && shown) setShown(null)

  return (
    <Modal visible={!!uri} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.page}>
        {shown ? <ZoomableImage uri={shown} previewUri={previewUri} accessibilityLabel={title} /> : null}
        <View style={[styles.bar, { paddingTop: insets.top + space.sm }]} pointerEvents="box-none">
          <Text style={[styles.title, font('semibold')]} numberOfLines={1}>{title || ''}</Text>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close" style={styles.done}>
            <Text style={[styles.doneText, font('semibold'), { color: colors.primary }]}>Done</Text>
          </Pressable>
        </View>
        <Text style={[styles.hint, { bottom: insets.bottom + space.lg }]} pointerEvents="none">
          Pinch or double-tap to zoom
        </Text>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#000' },
  zoomBox: { flex: 1, overflow: 'hidden' },
  fill: { width: '100%', height: '100%' },

  bar: {
    position: 'absolute', left: 0, right: 0, top: 0,
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingHorizontal: layout.pageGutter, paddingBottom: space.sm,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  title: { flex: 1, color: '#FFFFFF', fontSize: 16 },
  done: { paddingVertical: space.xs },
  doneText: { fontSize: 15 },
  hint: { position: 'absolute', alignSelf: 'center', color: 'rgba(255,255,255,0.6)', fontSize: 12 },
})
