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
 *
 * ── Why a FlatList and not a ScrollView ──────────────────────────────────────
 *
 * Every video tile holds an expo-video player, and a ScrollView mounts all of
 * them at once — a hundred clips meant a hundred decoders alive together, which
 * is what made opening this tab slow and left the grid stuttering. A windowed
 * FlatList mounts only the rows near the viewport and unmounts the rest, so the
 * number of live players stays roughly constant however long the history is.
 *
 * The roster only carries the newest few entries (backend GALLERY_PREVIEW), so
 * this screen also pages the rest in as it is scrolled — for the filter on
 * screen, so Images pages through images alone (core/data/paging.js). The filter
 * chips show the gallery's REAL totals, which come from the server, not the
 * count of what happens to be loaded.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  View, Text, FlatList, Pressable, StyleSheet, Modal,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useVideoPlayer, VideoView } from 'expo-video'

import { shareMedia } from '../lib/share'
import { showError } from '../lib/alerts'
import { Alert } from '../lib/dialog'
import { useInfluencers } from '@core/store'
import { assetUses } from '@core/data/influencers'
import { galleryEntries, galleryTotal, galleryHasMore, findGalleryEntry } from '@core/data/paging'
import { report as reportGeneration } from '@core/data/reports'
import { userMessage } from '@core/errors'

import { useBottomInset } from '../hooks/useBottomInset'
import { isServable } from '../lib/seedMedia'
import MediaImage from '../components/MediaImage'
import { ZoomableImage } from '../components/ImageViewer'
import { useTheme, space, font, layout } from '../theme'
import Screen from '../components/Screen'
import { Button, Chip, EmptyState } from '../components/ui'
import Icon from '../components/icons'
import ReportSheet from '../components/ReportSheet'
import LoadMoreFooter from '../components/LoadMoreFooter'

/** Fewer entries than this on screen and the next page is fetched without waiting for a scroll. */
const AUTO_FILL = 8

export default function GalleryTab({ influencer }) {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const bottomInset = useBottomInset()
  const { removeGeneration, loadMoreGenerations } = useInfluencers()
  const [filter, setFilter] = useState('all')
  const [loadingMore, setLoadingMore] = useState(false)
  // Why the last page failed, and for which filter. Until Try again nothing more is
  // asked by itself: onEndReached fires again the moment a short list settles, and a
  // failing request would be retried in a tight loop.
  const [loadError, setLoadError] = useState(null)
  // The entry as it was when opened. The roster re-signs its URLs every few
  // minutes, and handing the player a new URL would restart a clip mid-view.
  const [openEntry, setOpenEntry] = useState(null)

  // isServable, not just `e.url`: a record can still carry a web-origin path
  // like "/camila/videos/v1.mp4" from the old demo data, whose file was never
  // shipped with the app. Left in, each would be a black tile with a video
  // player behind it trying to decode nothing.
  const all = useMemo(() => galleryEntries(influencer, 'all').filter(e => e && isServable(e.url)), [influencer])

  // A filter shows its kind from everything held — including pages fetched for that
  // filter alone (core/data/paging.js), so Images never waits on pages of videos.
  const items = useMemo(
    () => (filter === 'all' ? all : galleryEntries(influencer, filter).filter(e => e && isServable(e.url))),
    [influencer, all, filter],
  )

  /**
   * The gallery's real size, from the server — not the number of entries that
   * happen to be loaded. Falls back to what is loaded for a record that predates
   * the counts (or an influencer created in this session).
   */
  const counts = useMemo(() => ({
    all: galleryTotal(influencer, 'all'),
    video: galleryTotal(influencer, 'video'),
    image: galleryTotal(influencer, 'image'),
  }), [influencer])

  const moreToLoad = galleryHasMore(influencer, filter)
  const errorHere = loadError?.filter === filter ? loadError.message : null
  useEffect(() => { setLoadError(null) }, [influencer.id])

  /** Fetch the next page for the filter on screen. One at a time, whatever asks. */
  const loading = useRef(false)
  const loadMore = useCallback(async () => {
    if (loading.current) return
    loading.current = true
    setLoadingMore(true)
    setLoadError(null)
    const asked = filter
    try {
      await loadMoreGenerations(influencer.id, asked)
    } catch (e) {
      console.warn('[gallery] could not load more:', e?.message ?? e)
      setLoadError({ filter: asked, message: userMessage(e, 'More could not be loaded. Please try again.') })
    } finally {
      loading.current = false
      setLoadingMore(false)
    }
  }, [influencer.id, filter, loadMoreGenerations])

  // A list too short to scroll never reaches its end, so onEndReached never asks for
  // more — Images with none loaded yet, or a gallery whose loaded entries were deleted.
  // Fill it up to a screenful here. A page that adds nothing changes none of these, so
  // this cannot loop.
  useEffect(() => {
    if (items.length < AUTO_FILL && moreToLoad && !errorHere) loadMore()
  }, [items.length, moreToLoad, errorHere, loadMore])

  // Closes by itself if the entry disappears from the gallery.
  const open = openEntry && findGalleryEntry(influencer, openEntry.id) ? openEntry : null

  const remove = useCallback(entry => {
    // A reference sheet is the same file as its gallery entry, so deleting one
    // deletes the other. That used to happen without a word.
    const uses = assetUses(influencer, entry.assetId)
    Alert.alert(
      'Delete this item?',
      uses.length
        ? `This file is also used as ${influencer.name || 'this influencer'}'s ${uses.join(' and ')}. Deleting it will remove it there as well. This action cannot be undone.`
        : 'This item will be permanently deleted. This action cannot be undone.',
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
              showError('Unable to delete', e, 'The item could not be deleted. Please try again.')
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
    const current = findGalleryEntry(influencer, entry.id) || entry
    shareMedia(current.url, base + '-' + entry.id + (isVideo ? '.mp4' : '.jpg'))
  }, [influencer])

  /**
   * Flag a result as inappropriate. Rejects on failure — after saying so — so the
   * report sheet stays open for another try instead of closing as if it worked.
   */
  const report = useCallback(async (entry, reason) => {
    try {
      await reportGeneration({ generationId: entry.id, reason })
    } catch (e) {
      showError('Could not send your report', e, 'Please try again.')
      throw e
    }
    Alert.alert('Thank you', 'Your report was sent. We will review it.')
  }, [])

  // Nothing generated yet at all — a single, calm empty state rather than an
  // empty grid with a filter bar above it that does nothing. Not while the server
  // still has entries: deleting the few loaded ones does not empty the gallery.
  if (all.length === 0 && !galleryHasMore(influencer, 'all')) {
    return (
      <View style={[styles.emptyScreen, { paddingBottom: bottomInset }]}>
        <EmptyState
          icon="video"
          title="No content yet"
          body={`Videos and images you generate for ${influencer.name} will appear here.`}
        />
      </View>
    )
  }

  const filterBar = (
    <View style={styles.filters}>
      {[
        { label: 'All', value: 'all' },
        { label: 'Videos', value: 'video' },
        { label: 'Images', value: 'image' },
      ].map(f => {
        const n = counts[f.value]
        return (
          <Chip
            key={f.value}
            label={f.value === 'all' ? f.label : `${f.label} ${String(n).padStart(2, '0')}`}
            active={filter === f.value}
            disabled={n === 0}
            onPress={() => setFilter(f.value)}
          />
        )
      })}
    </View>
  )

  return (
    <>
      <FlatList
        style={{ flex: 1 }}
        contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]}
        showsVerticalScrollIndicator={false}
        data={items}
        keyExtractor={entry => String(entry.id)}
        numColumns={2}
        columnWrapperStyle={styles.column}
        renderItem={({ item }) => (
          <Tile entry={item} onPress={() => setOpenEntry(item)} />
        )}
        ListHeaderComponent={filterBar}
        ListEmptyComponent={
          // While there is more, the footer says what is happening (loading, failed, Load more).
          moreToLoad ? null : (
            <Text style={[styles.noneForFilter, { color: colors.textTertiary }]}>
              {`No ${filter === 'video' ? 'videos' : filter === 'image' ? 'images' : 'content'} yet.`}
            </Text>
          )
        }
        ListFooterComponent={
          <LoadMoreFooter
            loading={loadingMore}
            error={errorHere}
            hasMore={moreToLoad}
            onLoadMore={loadMore}
            loaded={items.length}
            total={counts[filter]}
          />
        }
        onEndReached={moreToLoad && !errorHere ? loadMore : null}
        onEndReachedThreshold={0.5}
        // Only the rows near the viewport hold a video player; the rest are
        // unmounted, which is the whole point of moving off a ScrollView.
        initialNumToRender={6}
        maxToRenderPerBatch={6}
        windowSize={5}
        removeClippedSubviews
      />

      <Lightbox
        entry={open}
        influencerName={influencer.name}
        onClose={() => setOpenEntry(null)}
        onShare={() => open && share(open)}
        onReport={reason => (open ? report(open, reason) : Promise.resolve())}
        onDelete={() => open && remove(open)}
      />
    </>
  )
}

/**
 * One grid thumbnail. Videos render a paused frame with a play badge.
 *
 * Memoised on the entry so the three-minute URL refresh — which rewrites the
 * roster — does not tear down and rebuild every visible player.
 */
const Tile = memo(function Tile({ entry, onPress }) {
  const { colors } = useTheme()
  const isVideo = (entry.type || 'video') === 'video'

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={(entry.label || (isVideo ? 'Video' : 'Image')) + ', ' + formatDate(entry.date)}
      style={({ pressed }) => [styles.tile, { opacity: pressed ? 0.75 : 1 }]}
    >
      <View style={styles.thumbWrap}>
        {/* The server's small preview when there is one: tens of kilobytes, and for a video a still
            picture instead of a player. A file without one yet is drawn from itself, as before. */}
        {entry.thumbUrl
          ? <MediaImage uri={entry.thumbUrl} style={styles.thumb} contentFit="cover" />
          : isVideo
            ? <TilePreview uri={entry.url} />
            : <MediaImage uri={entry.url} style={styles.thumb} contentFit="cover" />}

        {/* On a dark disc: a still preview looks like a photo, and a bare white mark vanished on a
            light picture, so a video could not be told from an image. */}
        {isVideo ? (
          <View style={styles.playBadge} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Icon name="play" size={18} color="#FFFFFF" />
          </View>
        ) : null}
      </View>

      <Text style={[styles.tileLabel, font('regular'), { color: colors.textPrimary }]} numberOfLines={1}>
        {entry.label || (isVideo ? 'Video' : 'Image')}
      </Text>
      <Text style={[styles.tileDate, { color: colors.textSecondary }]} numberOfLines={1}>
        {formatDate(entry.date)}
      </Text>
    </Pressable>
  )
}, (a, b) => a.entry.id === b.entry.id && a.entry.url === b.entry.url && a.entry.thumbUrl === b.entry.thumbUrl)

/**
 * Muted, paused, no controls — this is a poster frame, not a player. Playback
 * happens in the lightbox so only one clip is ever decoding at a time.
 */
function TilePreview({ uri }) {
  // The URL the tile mounted with. The roster re-signs every URL every few minutes, and a new
  // URL made the player load the clip again — every visible video, over and over. The first
  // frame, once shown, does not need a fresh link; a tile scrolled away and back gets the new one.
  const [pinned] = useState(uri)
  const player = useVideoPlayer(pinned, p => { p.loop = false; p.muted = true })
  return <VideoView style={styles.thumb} player={player} nativeControls={false} contentFit="cover" />
}

/** Full-screen viewer: playback plus the destructive/among-apps actions. */
function Lightbox({ entry, influencerName, onClose, onShare, onReport, onDelete }) {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const [reporting, setReporting] = useState(false)

  return (
    <Modal
      visible={!!entry}
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Screen style={[styles.sheet, { paddingTop: insets.top }]}>
        <View style={styles.sheetBar}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.sheetTitle, font('bold'), { color: colors.textPrimary }]} numberOfLines={1}>
              {entry?.label || 'Item'}
            </Text>
            <Text style={[styles.sheetSub, { color: colors.textSecondary }]} numberOfLines={1}>
              {influencerName} · {formatDate(entry?.date)}
            </Text>
          </View>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
            <Text style={[styles.close, font('semibold'), { color: colors.primary }]}>Done</Text>
          </Pressable>
        </View>

        <View style={styles.stage}>
          {entry ? (
            (entry.type || 'video') === 'video'
              ? <LightboxVideo uri={entry.url} />
              // The square's own preview, already on the phone, stands in while the full file loads.
              : <ZoomableImage uri={entry.url} previewUri={entry.thumbUrl} accessibilityLabel={entry.label || 'Image'} />
          ) : null}
        </View>

        <View style={[styles.sheetActions, { paddingBottom: insets.bottom + space.lg }]}>
          <Button title="Share" onPress={onShare} />
          <Pressable onPress={() => setReporting(true)} accessibilityRole="button" style={styles.reportRow}>
            <Text style={[styles.reportText, font('medium'), { color: colors.textSecondary }]}>Report</Text>
          </Pressable>
          <Pressable onPress={onDelete} accessibilityRole="button" style={styles.deleteRow}>
            <Text style={[styles.deleteText, font('medium'), { color: colors.danger }]}>Delete</Text>
          </Pressable>
        </View>

        {/* Inside this Modal, so it opens above the viewer on both platforms. */}
        <ReportSheet visible={reporting} onClose={() => setReporting(false)} onSubmit={onReport} />
      </Screen>
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
  content: { paddingHorizontal: layout.pageGutter, paddingTop: space.xs },

  filters: { flexDirection: 'row', gap: space.sm, marginBottom: space.lg + 2, marginLeft: space.xs },

  noneForFilter: { fontSize: 14, paddingVertical: space.xxl, textAlign: 'center' },

  column: { justifyContent: 'space-between' },
  tile: { width: '48%', marginBottom: space.lg },
  thumbWrap: {
    width: '100%', aspectRatio: 3 / 4, borderRadius: 22,
    overflow: 'hidden', backgroundColor: 'rgba(8,3,83,0.25)',
  },
  thumb: { width: '100%', height: '100%' },
  playBadge: {
    position: 'absolute', left: 10, top: 10, width: 34, height: 34, borderRadius: 17,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(8,3,40,0.55)',
  },
  tileLabel: { fontSize: 16, marginTop: space.sm, marginLeft: space.xs + 2 },
  tileDate: { fontSize: 11, marginTop: 1, marginLeft: space.xs + 2 },

  // Empty state
  emptyScreen: { flex: 1 },

  // Lightbox
  sheet: { flex: 1 },
  sheetBar: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingHorizontal: layout.pageGutter, paddingVertical: space.md,
  },
  sheetTitle: { fontSize: 18 },
  sheetSub: { fontSize: 12, marginTop: 2 },
  close: { fontSize: 15 },

  stage: { flex: 1, backgroundColor: '#000' },
  stageMedia: { width: '100%', height: '100%' },

  sheetActions: { paddingHorizontal: layout.pageGutter, paddingTop: space.lg, gap: space.sm },
  reportRow: { alignItems: 'center', paddingVertical: space.sm },
  reportText: { fontSize: 14.5 },
  deleteRow: { alignItems: 'center', paddingVertical: space.md },
  deleteText: { fontSize: 15 },
})
