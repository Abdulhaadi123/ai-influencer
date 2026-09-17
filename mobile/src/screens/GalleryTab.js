/**
 * Gallery — everything this influencer has generated.
 *
 * Why this screen exists: Videos and Motion Copy have always APPENDED their
 * results to `influencer.generationHistory`, but nothing in the app read that
 * list back. The old web studio owned the history browser; when the web app was
 * removed the reader went with it and the writer was left behind. That looked
 * exactly like a save bug — a clip appeared once in the "Result" card, then
 * vanished as soon as you navigated away, because that card renders transient
 * screen state, not stored history.
 *
 * Nothing was ever being deleted. It was being saved and never shown.
 *
 * Layout is a two-column thumbnail grid rather than a stack of full-width
 * players: clips are 9:16, so stacked full-width each one filled the whole
 * screen and you could never see what you had. Tapping a tile opens the
 * lightbox, which is where playback, sharing and deleting live.
 */

import { useCallback, useMemo, useState } from 'react'
import {
  View, Text, ScrollView, Image, Pressable, StyleSheet, Alert, Modal,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useVideoPlayer, VideoView } from 'expo-video'

import { shareMedia } from '../lib/share'
import { showError } from '../lib/alerts'
import { useInfluencers } from '@core/store'
import { assetUses } from '@core/data/influencers'

import { useBottomInset } from '../hooks/useBottomInset'
import { isServable, mediaSource } from '../lib/seedMedia'
import { useTheme, space, radius } from '../theme'
import { Button } from '../components/ui'

export default function GalleryTab({ influencer }) {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const bottomInset = useBottomInset()
  const { removeGeneration } = useInfluencers()
  const [filter, setFilter] = useState('all')
  // The entry as it was when opened. The roster re-signs its URLs every few
  // minutes, and handing the player a new URL would restart a clip mid-view.
  const [openEntry, setOpenEntry] = useState(null)

  const history = influencer.generationHistory

  // isServable, not just `e.url`: a record can still carry a web-origin path
  // like "/camila/videos/v1.mp4" from the old demo data, whose file was never
  // shipped with the app. Left in, each would be a black tile with a video
  // player behind it trying to decode nothing.
  const all = useMemo(
    () => [...(history || []).filter(e => e && isServable(e.url))].sort((a, b) => (b.date || 0) - (a.date || 0)),
    [history],
  )

  const counts = useMemo(() => ({
    all: all.length,
    video: all.filter(e => (e.type || 'video') === 'video').length,
    image: all.filter(e => (e.type || 'video') === 'image').length,
  }), [all])

  const items = useMemo(
    () => (filter === 'all' ? all : all.filter(e => (e.type || 'video') === filter)),
    [all, filter],
  )

  // Closes by itself if the entry disappears from the gallery.
  const open = openEntry && all.some(e => e.id === openEntry.id) ? openEntry : null

  const remove = useCallback(entry => {
    // A reference sheet is the same file as its gallery entry, so deleting one
    // deletes the other. That used to happen without a word.
    const uses = assetUses(influencer, entry.assetId)
    Alert.alert(
      'Delete this clip?',
      uses.length
        ? `This file is also ${influencer.name || 'this influencer'}'s ${uses.join(' and ')}. Deleting it removes it there too, permanently.`
        : 'The file is deleted permanently. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setOpenEntry(null)
            try {
              // Removes the row AND the stored file. "Delete" has to mean
              // deleted — leaving the object behind would keep billing for a
              // clip the user believes is gone.
              await removeGeneration(influencer.id, entry.id)
            } catch (e) {
              showError('Could not delete', e, 'The clip was not deleted. Please try again.')
            }
          },
        },
      ],
    )
  }, [influencer, removeGeneration])

  const share = useCallback(entry => {
    const isVideo = (entry.type || 'video') === 'video'
    const base = (influencer.name || 'clip').toLowerCase().replace(/\s+/g, '-')
    // The freshest URL for this entry, not the one pinned when the lightbox opened.
    const current = all.find(e => e.id === entry.id) || entry
    shareMedia(current.url, base + '-' + entry.id + (isVideo ? '.mp4' : '.jpg'))
  }, [influencer.name, all])

  // Nothing generated yet at all — a single, calm empty state rather than an
  // empty grid with a filter bar above it that does nothing.
  if (all.length === 0) {
    return (
      <View style={[styles.emptyScreen, { paddingBottom: bottomInset }]}>
        <View style={[styles.emptyIcon, { backgroundColor: colors.brandSoft }]}>
          <Text style={styles.emptyGlyph}>🎬</Text>
        </View>
        <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>No clips yet</Text>
        <Text style={[styles.emptyBody, { color: colors.textSecondary }]}>
          Promo videos and motion copies you generate for {influencer.name} are kept here —
          they stay after you leave the screen or close the app.
        </Text>
      </View>
    )
  }

  return (
    <>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]}
      >
        <View style={styles.filters}>
          {[
            { label: 'All', value: 'all' },
            { label: 'Videos', value: 'video' },
            { label: 'Images', value: 'image' },
          ].map(f => {
            const active = filter === f.value
            const n = counts[f.value]
            return (
              <Pressable
                key={f.value}
                onPress={() => setFilter(f.value)}
                disabled={n === 0}
                accessibilityRole="button"
                accessibilityState={{ selected: active, disabled: n === 0 }}
                style={[
                  styles.filter,
                  {
                    backgroundColor: active ? colors.brand : colors.surface,
                    borderColor: active ? colors.brand : colors.borderSubtle,
                    opacity: n === 0 ? 0.45 : 1,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.filterText,
                    { color: active ? '#FFFFFF' : colors.textSecondary },
                  ]}
                >
                  {f.label} {n}
                </Text>
              </Pressable>
            )
          })}
        </View>

        {items.length === 0 ? (
          <Text style={[styles.noneForFilter, { color: colors.textTertiary }]}>
            No {filter === 'video' ? 'videos' : 'images'} yet.
          </Text>
        ) : (
          <View style={styles.grid}>
            {items.map(entry => (
              <Tile key={entry.id} entry={entry} onPress={() => setOpenEntry(entry)} />
            ))}
          </View>
        )}
      </ScrollView>

      <Lightbox
        entry={open}
        influencerName={influencer.name}
        onClose={() => setOpenEntry(null)}
        onShare={() => open && share(open)}
        onDelete={() => open && remove(open)}
      />
    </>
  )
}

/** One grid thumbnail. Videos render a paused frame with a play badge. */
function Tile({ entry, onPress }) {
  const { colors } = useTheme()
  const isVideo = (entry.type || 'video') === 'video'

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={(entry.label || (isVideo ? 'Video' : 'Image')) + ', ' + formatDate(entry.date)}
      style={({ pressed }) => [styles.tile, { opacity: pressed ? 0.75 : 1 }]}
    >
      <View style={[styles.thumbWrap, { borderColor: colors.borderSubtle }]}>
        {isVideo
          ? <TilePreview uri={entry.url} />
          : <Image source={mediaSource(entry.url)} style={styles.thumb} resizeMode="cover" />}

        {isVideo ? (
          <View style={styles.playBadge}>
            <Text style={styles.playGlyph}>▶</Text>
          </View>
        ) : null}
      </View>

      <Text style={[styles.tileLabel, { color: colors.textPrimary }]} numberOfLines={1}>
        {entry.label || (isVideo ? 'Video' : 'Image')}
      </Text>
      <Text style={[styles.tileDate, { color: colors.textTertiary }]} numberOfLines={1}>
        {formatDate(entry.date)}
      </Text>
    </Pressable>
  )
}

/**
 * Muted, paused, no controls — this is a poster frame, not a player. Playback
 * happens in the lightbox so only one clip is ever decoding at a time.
 */
function TilePreview({ uri }) {
  const player = useVideoPlayer(uri, p => { p.loop = false; p.muted = true })
  return <VideoView style={styles.thumb} player={player} nativeControls={false} contentFit="cover" />
}

/** Full-screen viewer: playback plus the destructive/among-apps actions. */
function Lightbox({ entry, influencerName, onClose, onShare, onDelete }) {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()

  return (
    <Modal
      visible={!!entry}
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={[styles.sheet, { backgroundColor: colors.bg, paddingTop: insets.top }]}>
        <View style={[styles.sheetBar, { borderBottomColor: colors.borderSubtle }]}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.sheetTitle, { color: colors.textPrimary }]} numberOfLines={1}>
              {entry?.label || 'Clip'}
            </Text>
            <Text style={[styles.sheetSub, { color: colors.textTertiary }]} numberOfLines={1}>
              {influencerName} · {formatDate(entry?.date)}
            </Text>
          </View>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
            <Text style={[styles.close, { color: colors.brandDeep }]}>Done</Text>
          </Pressable>
        </View>

        <View style={styles.stage}>
          {entry ? (
            (entry.type || 'video') === 'video'
              ? <LightboxVideo uri={entry.url} />
              : <Image source={mediaSource(entry.url)} style={styles.stageMedia} resizeMode="contain" />
          ) : null}
        </View>

        <View style={[styles.sheetActions, { paddingBottom: insets.bottom + space.lg }]}>
          <Button title="Save or share" variant="secondary" onPress={onShare} />
          <Pressable onPress={onDelete} accessibilityRole="button" style={styles.deleteRow}>
            <Text style={[styles.deleteText, { color: colors.danger }]}>Delete</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  )
}

function LightboxVideo({ uri }) {
  const player = useVideoPlayer(uri, p => { p.loop = true; p.play() })
  return <VideoView style={styles.stageMedia} player={player} allowsFullscreen nativeControls contentFit="contain" />
}

function formatDate(ts) {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleDateString(undefined, {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return ''
  }
}

const styles = StyleSheet.create({
  content: { padding: space.lg },

  filters: { flexDirection: 'row', gap: space.sm, marginBottom: space.lg },
  filter: {
    paddingVertical: 8, paddingHorizontal: 14,
    borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth,
  },
  filterText: { fontSize: 13, fontWeight: '600' },

  noneForFilter: { fontSize: 14, paddingVertical: space.xxl, textAlign: 'center' },

  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  tile: { width: '48%', marginBottom: space.lg },
  thumbWrap: {
    width: '100%', aspectRatio: 9 / 16, borderRadius: radius.md,
    overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, backgroundColor: '#000',
  },
  thumb: { width: '100%', height: '100%' },
  playBadge: {
    position: 'absolute', left: 8, bottom: 8,
    width: 28, height: 28, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  playGlyph: { color: '#FFFFFF', fontSize: 11, marginLeft: 2 },
  tileLabel: { fontSize: 13, fontWeight: '600', marginTop: space.sm },
  tileDate: { fontSize: 11.5, marginTop: 1 },

  // Empty state
  emptyScreen: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.xxl },
  emptyIcon: {
    width: 72, height: 72, borderRadius: 36,
    alignItems: 'center', justifyContent: 'center', marginBottom: space.lg,
  },
  emptyGlyph: { fontSize: 30 },
  emptyTitle: { fontSize: 18, fontWeight: '700', marginBottom: space.sm },
  emptyBody: { fontSize: 14, lineHeight: 21, textAlign: 'center' },

  // Lightbox
  sheet: { flex: 1 },
  sheetBar: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingHorizontal: space.lg, paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sheetTitle: { fontSize: 16, fontWeight: '700' },
  sheetSub: { fontSize: 12, marginTop: 2 },
  close: { fontSize: 15, fontWeight: '600' },

  stage: { flex: 1, backgroundColor: '#000' },
  stageMedia: { width: '100%', height: '100%' },

  sheetActions: { paddingHorizontal: space.lg, paddingTop: space.lg, gap: space.sm },
  deleteRow: { alignItems: 'center', paddingVertical: space.md },
  deleteText: { fontSize: 15, fontWeight: '600' },
})
