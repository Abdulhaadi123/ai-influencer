/**
 * Gallery — everything this influencer has generated.
 *
 * Why this screen exists: Videos and Motion Copy have always APPENDED their
 * results to `influencer.generationHistory`, but nothing in the app ever read
 * that list back. The old web studio owned the history browser; when the web
 * app was removed the reader went with it and the writer was left behind. That
 * looked exactly like a save bug — a clip appeared once in the "Result" card,
 * then vanished as soon as you navigated away, because that card renders
 * transient screen state, not stored history.
 *
 * Nothing was ever being deleted. It was being saved and never shown.
 *
 * This reads live from the store, so a clip appears the instant it is
 * generated and survives leaving the screen, switching influencer, and
 * restarting the app.
 */

import { useCallback, useMemo, useState } from 'react'
import {
  View, Text, ScrollView, Image, Pressable, StyleSheet, Alert,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useVideoPlayer, VideoView } from 'expo-video'

import { downloadImage } from '@core/platform/media'
import { useInfluencers } from '@core/store'

import { useTheme, space, radius } from '../theme'
import { Section, Button } from '../components/ui'

const FILTERS = [
  { label: 'All', value: 'all' },
  { label: 'Videos', value: 'video' },
  { label: 'Images', value: 'image' },
]

export default function GalleryTab({ influencer }) {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const [, setInfluencers] = useInfluencers()
  const [filter, setFilter] = useState('all')

  const history = influencer.generationHistory

  // Newest first. Entries predating the `date` field sort last rather than
  // being dropped — old records are still worth showing.
  const items = useMemo(() => {
    const all = (history || []).filter(e => e && e.url)
    const byType = filter === 'all' ? all : all.filter(e => (e.type || 'video') === filter)
    return [...byType].sort((a, b) => (b.date || 0) - (a.date || 0))
  }, [history, filter])

  const total = (history || []).filter(e => e && e.url).length

  const remove = useCallback(entry => {
    Alert.alert(
      'Delete this?',
      'It will be removed from the gallery. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => setInfluencers(prev => prev.map(i => i.id === influencer.id
            ? { ...i, generationHistory: (i.generationHistory || []).filter(e => e.id !== entry.id) }
            : i)),
        },
      ],
    )
  }, [influencer.id, setInfluencers])

  const share = useCallback(entry => {
    const isVideo = (entry.type || 'video') === 'video'
    const base = (influencer.name || 'clip').toLowerCase().replace(/\s+/g, '-')
    downloadImage(entry.url, base + '-' + entry.id + (isVideo ? '.mp4' : '.jpg'))
  }, [influencer.name])

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingBottom: insets.bottom + space.xxl }}
      keyboardShouldPersistTaps="handled"
    >
      {total > 0 ? (
        <View style={styles.filters}>
          {FILTERS.map(f => (
            <Pressable
              key={f.value}
              onPress={() => setFilter(f.value)}
              accessibilityRole="button"
              accessibilityState={{ selected: filter === f.value }}
              style={[
                styles.filter,
                {
                  backgroundColor: filter === f.value ? colors.brand : colors.surfaceAlt,
                  borderColor: filter === f.value ? colors.brand : colors.borderSubtle,
                },
              ]}
            >
              <Text
                style={[
                  styles.filterText,
                  { color: filter === f.value ? '#FFFFFF' : colors.textSecondary },
                ]}
              >
                {f.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {items.length === 0 ? (
        <Section title={total === 0 ? 'Nothing here yet' : 'Nothing of that kind yet'}>
          <View style={styles.padded}>
            <Text style={[styles.empty, { color: colors.textSecondary }]}>
              {total === 0
                ? 'Generate a promo video or a motion copy and it is kept here — it stays after you leave the screen or close the app.'
                : 'Try a different filter.'}
            </Text>
          </View>
        </Section>
      ) : (
        <Section title={items.length + (items.length === 1 ? ' item' : ' items')}>
          <View style={[styles.padded, { gap: space.lg }]}>
            {items.map(entry => (
              <GalleryItem
                key={entry.id}
                entry={entry}
                onShare={() => share(entry)}
                onDelete={() => remove(entry)}
              />
            ))}
          </View>
        </Section>
      )}
    </ScrollView>
  )
}

function GalleryItem({ entry, onShare, onDelete }) {
  const { colors } = useTheme()
  const isVideo = (entry.type || 'video') === 'video'

  return (
    <View style={[styles.card, { borderColor: colors.borderSubtle, backgroundColor: colors.surface }]}>
      {isVideo
        ? <HistoryVideo uri={entry.url} />
        : <Image source={{ uri: entry.url }} style={styles.media} resizeMode="contain" />}

      <View style={styles.meta}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.label, { color: colors.textPrimary }]} numberOfLines={1}>
            {entry.label || (isVideo ? 'Video' : 'Image')}
          </Text>
          <Text style={[styles.date, { color: colors.textTertiary }]}>{formatDate(entry.date)}</Text>
        </View>
        <Pressable onPress={onDelete} hitSlop={10} accessibilityRole="button" accessibilityLabel="Delete">
          <Text style={[styles.delete, { color: colors.danger }]}>Delete</Text>
        </Pressable>
      </View>

      <Button title="Save or share" variant="secondary" onPress={onShare} />
    </View>
  )
}

/**
 * One player per item, not looping and not autoplaying: a gallery can hold many
 * clips, and playing them all at once would compete for decoders and battery.
 */
function HistoryVideo({ uri }) {
  const player = useVideoPlayer(uri, p => { p.loop = false })
  return <VideoView style={styles.media} player={player} allowsFullscreen nativeControls contentFit="contain" />
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
  padded: { paddingHorizontal: space.lg },
  empty: { fontSize: 14, lineHeight: 20 },

  filters: { flexDirection: 'row', gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.lg },
  filter: { paddingVertical: 7, paddingHorizontal: 14, borderRadius: radius.pill, borderWidth: 1 },
  filterText: { fontSize: 13, fontWeight: '600' },

  card: { borderWidth: 1, borderRadius: radius.md, padding: space.md, gap: space.md },
  media: { width: '100%', aspectRatio: 9 / 16, borderRadius: radius.sm, backgroundColor: '#000' },

  meta: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  label: { fontSize: 14, fontWeight: '600' },
  date: { fontSize: 12, marginTop: 2 },
  delete: { fontSize: 13, fontWeight: '600' },
})
