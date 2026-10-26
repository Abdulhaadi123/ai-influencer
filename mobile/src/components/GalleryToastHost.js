/**
 * "Saved to Gallery" — the card that tells someone where a finished result went.
 *
 * A video or an image finishes and is filed in the influencer's gallery; nothing on screen said so,
 * and people were left wondering whether it had been made, and where. This slides in from the top
 * with the picture itself (a violet tile with a play mark for a video, whose preview does not exist
 * yet), what was saved, whose gallery it is in, and a View button that opens that Gallery. It stays
 * a few seconds with a thin line running down its foot, joins any result that arrives meanwhile
 * ("3 images saved to Gallery"), and leaves by itself. The Gallery tab of the influencer carries a
 * pulsing count of the same results until it is opened (screens/InfluencerDetailScreen.js).
 *
 * The rules — when to show it, when to stay quiet — are core/notices/galleryNotice.js. This only
 * draws them. Mounted once above the navigator (navigation/index.js), signed in only.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useAuth } from '@core/auth/AuthContext'
import { useInfluencers } from '@core/store'
import { onGalleryAdded } from '@core/notices/galleryEvents'
import { waitForPreview } from '@core/data/assets'
import { TOAST_MS, toastTitle } from '@core/notices/galleryNotice'

import { useTheme, space, font } from '../theme'
import { galleryNotices, useGalleryNotices } from '../lib/galleryNotice'
import { openGallery } from '../navigation/ref'
import MediaImage from './MediaImage'
import Icon from './icons'

const HIDDEN_Y = -170

export default function GalleryToastHost() {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { userId } = useAuth()
  const [influencers] = useInfluencers()
  const { toast } = useGalleryNotices()

  // The store's announcements go to the board; a different person signing in starts it empty.
  useEffect(() => { galleryNotices.reset() }, [userId])
  useEffect(() => onGalleryAdded(galleryNotices.add), [])

  // What is on screen. It outlives the board's toast by the length of its exit, so it can leave smoothly.
  const [shown, setShown] = useState(null)
  const shownId = useRef(null)
  const slide = useRef(new Animated.Value(0)).current   // 0 away, 1 in place
  const line = useRef(new Animated.Value(0)).current    // 0 full, 1 spent: the time left
  const nudge = useRef(new Animated.Value(1)).current   // a small swell when another result joins
  const reduced = useRef(false)

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(v => { reduced.current = !!v }).catch(() => {})
  }, [])

  useEffect(() => {
    if (toast) {
      const isNew = shownId.current !== toast.id
      shownId.current = toast.id
      setShown(toast)

      if (isNew) {
        slide.stopAnimation()
        if (reduced.current) slide.setValue(1)
        else Animated.spring(slide, { toValue: 1, friction: 8, tension: 70, useNativeDriver: true }).start()
      } else if (!reduced.current) {
        Animated.sequence([
          Animated.timing(nudge, { toValue: 1.04, duration: 110, useNativeDriver: true }),
          Animated.spring(nudge, { toValue: 1, friction: 5, useNativeDriver: true }),
        ]).start()
      }

      // The clock starts again with each result; when it runs out the toast closes itself.
      line.setValue(0)
      const id = toast.id
      const run = Animated.timing(line, { toValue: 1, duration: TOAST_MS, easing: Easing.linear, useNativeDriver: false })
      run.start(({ finished }) => { if (finished) galleryNotices.dismissToast(id) })
      return () => run.stop()
    }

    // Gone from the board (closed, timed out, or its gallery was opened): slide away, then forget it.
    if (shownId.current !== null) {
      shownId.current = null
      if (reduced.current) { slide.setValue(0); setShown(null) } else {
        Animated.timing(slide, { toValue: 0, duration: 220, easing: Easing.in(Easing.cubic), useNativeDriver: true })
          .start(({ finished }) => { if (finished) setShown(null) })
      }
    }
    return undefined
  }, [toast, slide, line, nudge])

  const view = useCallback(() => {
    if (!shown) return
    galleryNotices.dismissToast(shown.id)
    openGallery(shown.influencerId)
  }, [shown])

  const close = useCallback(() => { if (shown) galleryNotices.dismissToast(shown.id) }, [shown])

  // An image filed moments ago usually has no preview yet. Ask for it (a few quick tries) rather than
  // drawing the full file, megabytes, in a 52-point square: the violet tile stands in meanwhile.
  const [late, setLate] = useState({ id: null, url: null })
  const latestId = shown?.latest.id ?? null
  const askFor = shown && !shown.latest.thumbUrl && shown.latest.type === 'image' ? shown.latest.assetId : null
  useEffect(() => {
    if (!askFor) return undefined
    let off = false
    waitForPreview(askFor, { isCancelled: () => off }).then(url => { if (url && !off) setLate({ id: latestId, url }) })
    return () => { off = true }
  }, [askFor, latestId])

  if (!shown) return null

  const owner = influencers.find(i => String(i.id) === shown.influencerId)
  const picture = shown.latest.thumbUrl || (late.id === shown.latest.id ? late.url : null)
  const title = toastTitle(shown)
  const where = owner?.name ? `${owner.name}'s Gallery` : 'Open your Gallery'

  return (
    <View style={[styles.layer, { top: insets.top + space.sm }]} pointerEvents="box-none">
      <Animated.View
        style={{
          opacity: slide,
          transform: [
            { translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [HIDDEN_Y, 0] }) },
            { scale: nudge },
          ],
        }}
      >
        <Pressable
          onPress={view}
          accessibilityRole="button"
          accessibilityLabel={`${title}. ${where}. Double tap to open.`}
          accessibilityLiveRegion="polite"
          style={[styles.card, { backgroundColor: colors.sheet, borderColor: colors.glassEdge }]}
        >
          <View style={styles.row}>
            <View style={styles.tile}>
              {picture ? (
                <MediaImage uri={picture} style={styles.tileFill} contentFit="cover" />
              ) : (
                <LinearGradient colors={colors.brandGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[styles.tileFill, styles.tileCentre]}>
                  <Icon name={shown.latest.type === 'video' ? 'play' : 'image'} size={22} color="#FFFFFF" />
                </LinearGradient>
              )}
              {picture && shown.latest.type === 'video' ? (
                <View style={styles.playMark}><Icon name="play" size={12} color="#FFFFFF" /></View>
              ) : null}
            </View>

            <View style={styles.text}>
              <Text style={[styles.title, font('bold'), { color: colors.textPrimary }]} numberOfLines={1}>{title}</Text>
              <Text style={[styles.where, { color: colors.textSecondary }]} numberOfLines={1}>{where}</Text>
            </View>

            <View style={[styles.view, { backgroundColor: colors.primary }]}>
              <Text style={[styles.viewText, font('semibold'), { color: colors.onPrimary }]}>View</Text>
            </View>
            <Pressable onPress={close} hitSlop={10} accessibilityRole="button" accessibilityLabel="Dismiss" style={styles.close}>
              <Icon name="close" size={16} color={colors.textTertiary} />
            </Pressable>
          </View>

          {/* The time left, running down. */}
          <View style={[styles.lineTrack, { backgroundColor: colors.surfaceAlt }]}>
            <Animated.View
              style={[styles.lineFill, { backgroundColor: colors.primary, width: line.interpolate({ inputRange: [0, 1], outputRange: ['100%', '0%'] }) }]}
            />
          </View>
        </Pressable>
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  layer: { position: 'absolute', left: space.lg, right: space.lg, zIndex: 50, elevation: 50 },
  card: {
    borderRadius: 22, borderWidth: 1, overflow: 'hidden',
    shadowColor: '#080353', shadowOpacity: 0.22, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 12,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.md, paddingTop: space.md, paddingBottom: space.md },
  tile: { width: 52, height: 52, borderRadius: 14, overflow: 'hidden' },
  tileFill: { width: '100%', height: '100%' },
  tileCentre: { alignItems: 'center', justifyContent: 'center' },
  playMark: { position: 'absolute', right: 4, bottom: 4, width: 20, height: 20, borderRadius: 10, backgroundColor: 'rgba(8,3,83,0.62)', alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1, gap: 2 },
  title: { fontSize: 15 },
  where: { fontSize: 13 },
  view: { height: 34, borderRadius: 17, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  viewText: { fontSize: 13 },
  close: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center', marginRight: -4 },
  lineTrack: { height: 3 },
  lineFill: { height: 3 },
})
