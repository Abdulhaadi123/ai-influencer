/**
 * Queue — every generation this device has started, and where it got to.
 *
 * Generation is asynchronous and slow: KIE takes anywhere from twenty seconds
 * to many minutes, and the app used to hold that entirely in the screen that
 * started it. Navigate away, background the app, or simply wait longer than
 * the poll loop was willing to, and the result became unreachable — the task
 * finished, the credits were spent, and nothing in the app could collect it.
 *
 * This screen is the other half. Every launch writes its taskId to the shared
 * queue before polling begins, so anything started is listed here and can be
 * picked back up from a cold start.
 *
 * Two details drive the design:
 *
 *  • KIE deletes result URLs after 24 hours, so "done" is not the same as
 *    "safe". A finished job stays as Ready until its bytes are on the device,
 *    and is marked Expired rather than offering a button that would 404.
 *  • KIE has no list-tasks endpoint — recordInfo takes one taskId at a time.
 *    So refreshing walks the active jobs serially, which also keeps well clear
 *    of the rate limit.
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import {
  View, Text, ScrollView, Pressable, RefreshControl,
  ActivityIndicator, StyleSheet, Alert,
} from 'react-native'
import { useFocusEffect } from '@react-navigation/native'

import {
  listJobs, isActive, isCollectable, isExpired,
  markSaved, removeJob, clearSettled,
} from '@core/jobQueue'
import { persistMedia, mediaFilename } from '@core/platform/persistMedia'
import { downloadImage } from '@core/platform/media'
import { useInfluencers, generateId } from '@core/store'

import { syncActiveJobs } from '../lib/queueSync'
import { useBottomInset } from '../hooks/useBottomInset'
import { useTheme, space, radius } from '../theme'
import { Button } from '../components/ui'

/** How often to re-check while the screen is open and something is running. */
const POLL_MS = 8000

export default function QueueScreen() {
  const { colors } = useTheme()
  const bottomInset = useBottomInset()
  const [influencers, setInfluencers] = useInfluencers()

  const [jobs, setJobs] = useState(() => listJobs())
  const [refreshing, setRefreshing] = useState(false)
  const [savingId, setSavingId] = useState(null)

  const busyRef = useRef(false)
  const focusedRef = useRef(false)

  const reload = useCallback(() => setJobs(listJobs()), [])

  /**
   * Ask KIE about everything still running, then re-read the store.
   *
   * Goes through the shared sync rather than calling refreshJobs directly, so
   * this timer and the app-wide background poller cannot both be walking the
   * same taskIds at once.
   */
  const refresh = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    try {
      await syncActiveJobs()
      if (focusedRef.current) reload()
    } finally {
      busyRef.current = false
    }
  }, [reload])

  // Poll only while the screen is actually being looked at — a background
  // timer hitting KIE forever would burn battery and court a 429.
  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true
      reload()
      refresh()
      const id = setInterval(() => {
        if (listJobs().some(isActive)) refresh()
      }, POLL_MS)
      return () => { focusedRef.current = false; clearInterval(id) }
    }, [reload, refresh]),
  )

  const onPullRefresh = useCallback(async () => {
    setRefreshing(true)
    await refresh()
    setRefreshing(false)
  }, [refresh])

  /**
   * Bring a finished result onto the device.
   *
   * This is where a job stops depending on KIE. Until persistMedia returns,
   * the only copy is a URL with hours left on it.
   */
  const collect = useCallback(async job => {
    setSavingId(job.id)
    try {
      const ext = job.kind === 'image' ? 'jpg' : 'mp4'
      const entryId = generateId()
      const localUri = await persistMedia(job.resultUrl, mediaFilename(job.kind, entryId, ext))

      if (localUri === job.resultUrl) {
        // persistMedia falls back to the remote URL when the download fails —
        // saying "saved" then would be a lie the user finds out about later.
        Alert.alert('Could not download', 'The file could not be saved to this device. Check your connection and try again — KIE keeps results for 24 hours.')
        return
      }

      const owner = influencers?.find(i => String(i.id) === String(job.influencerId))
      if (owner) {
        setInfluencers(prev => prev.map(i => i.id === owner.id ? {
          ...i,
          generationHistory: [
            { id: entryId, type: job.kind === 'image' ? 'image' : 'video', label: job.label || 'Generation', url: localUri, date: Date.now() },
            ...(i.generationHistory || []),
          ],
        } : i))
      }

      markSaved(job.taskId, localUri)
      reload()

      Alert.alert(
        'Saved',
        owner
          ? `Added to ${owner.name}'s gallery.`
          : 'Saved to this device. Use "Save or share" to export it.',
      )
    } catch (e) {
      Alert.alert('Could not save', e?.message ?? 'Please try again.')
    } finally {
      setSavingId(null)
    }
  }, [influencers, setInfluencers, reload])

  const discard = useCallback(job => {
    Alert.alert('Remove from queue?', 'This only clears the row here. Anything already saved stays in the gallery.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => { removeJob(job.id); reload() } },
    ])
  }, [reload])

  const clearDone = useCallback(() => {
    clearSettled()
    reload()
  }, [reload])

  const activeCount = useMemo(() => jobs.filter(isActive).length, [jobs])
  const readyCount = useMemo(() => jobs.filter(isCollectable).length, [jobs])
  const settledCount = useMemo(() => jobs.filter(j => !isActive(j)).length, [jobs])

  if (!jobs.length) {
    return (
      <View style={[styles.empty, { backgroundColor: colors.bg, paddingBottom: bottomInset }]}>
        <View style={[styles.emptyIcon, { backgroundColor: colors.brandSoft }]}>
          <Text style={styles.emptyGlyph}>🕓</Text>
        </View>
        <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>Nothing in the queue</Text>
        <Text style={[styles.emptyBody, { color: colors.textSecondary }]}>
          Every image, video and motion copy you start shows up here with its
          progress. You can leave the screen, or close the app entirely — the
          job keeps running and the result waits for you.
        </Text>
      </View>
    )
  }

  return (
    <ScrollView
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onPullRefresh} tintColor={colors.brand} />
      }
    >
      <View style={styles.summary}>
        <Text style={[styles.summaryText, { color: colors.textSecondary }]}>
          {activeCount > 0
            ? `${activeCount} running${readyCount ? ` · ${readyCount} ready to save` : ''}`
            : readyCount > 0
            ? `${readyCount} ready to save`
            : 'Nothing running'}
        </Text>
        {activeCount > 0 ? <ActivityIndicator size="small" color={colors.brand} /> : null}
      </View>

      {activeCount > 0 ? (
        <Text style={[styles.hint, { color: colors.textTertiary }]}>
          Leaving this screen is fine — jobs keep running on KIE. Results are
          held for 24 hours, so save them before then.
        </Text>
      ) : null}

      {jobs.map(job => (
        <JobRow
          key={job.id}
          job={job}
          saving={savingId === job.id}
          onCollect={() => collect(job)}
          onShare={() => downloadImage(job.savedUrl || job.resultUrl, `${(job.label || 'result').toLowerCase().replace(/\s+/g, '-')}.${job.kind === 'image' ? 'jpg' : 'mp4'}`)}
          onDiscard={() => discard(job)}
        />
      ))}

      {settledCount > 0 ? (
        <View style={{ marginTop: space.md }}>
          <Button title="Clear finished" variant="secondary" onPress={clearDone} />
        </View>
      ) : null}
    </ScrollView>
  )
}

/** One row. The status word is the point — everything else supports it. */
function JobRow({ job, saving, onCollect, onShare, onDiscard }) {
  const { colors } = useTheme()
  const status = describe(job, colors)

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.borderSubtle }]}>
      <View style={styles.cardHead}>
        <View style={styles.flex}>
          <Text style={[styles.cardTitle, { color: colors.textPrimary }]} numberOfLines={1}>
            {job.label || 'Generation'}
            {job.influencerName ? (
              <Text style={{ color: colors.textTertiary, fontWeight: '400' }}>  ·  {job.influencerName}</Text>
            ) : null}
          </Text>
          <Text style={[styles.cardMeta, { color: colors.textTertiary }]} numberOfLines={1}>
            {relativeTime(job.createdAt)}{job.model ? ` · ${job.model}` : ''}
          </Text>
        </View>

        <View style={[styles.pill, { backgroundColor: status.soft }]}>
          {isActive(job) ? <ActivityIndicator size="small" color={status.tint} /> : null}
          <Text style={[styles.pillText, { color: status.tint }]}>{status.label}</Text>
        </View>
      </View>

      <Text style={[styles.cardBody, { color: colors.textSecondary }]}>{status.blurb}</Text>

      {saving ? (
        <View style={styles.savingRow}>
          <ActivityIndicator size="small" color={colors.brand} />
          <Text style={[styles.savingText, { color: colors.textSecondary }]}>Downloading…</Text>
        </View>
      ) : (
        <View style={styles.actions}>
          {isCollectable(job) ? (
            <View style={styles.flex}>
              <Button title="Save to gallery" onPress={onCollect} />
            </View>
          ) : null}
          {job.savedUrl ? (
            <View style={styles.flex}>
              <Button title="Save or share" variant="secondary" onPress={onShare} />
            </View>
          ) : null}
          {!isActive(job) ? (
            <Pressable onPress={onDiscard} hitSlop={8} style={styles.discard}>
              <Text style={[styles.discardText, { color: colors.textTertiary }]}>Remove</Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  )
}

/**
 * Turn a stored job into a status word and an honest sentence.
 *
 * KIE's five states collapse into what the user actually needs to know: is it
 * still coming, is it waiting for me, or is it over.
 */
function describe(job, colors) {
  if (job.state === 'fail') {
    return {
      label: 'Failed', tint: colors.danger, soft: 'transparent',
      blurb: job.failMsg || 'KIE reported this generation as failed.',
    }
  }
  if (isExpired(job)) {
    return {
      label: 'Expired', tint: colors.danger, soft: 'transparent',
      blurb: 'This finished more than 24 hours ago and KIE has deleted the file. It cannot be recovered — the generation would need to be run again.',
    }
  }
  if (job.savedUrl) {
    return {
      label: 'Saved', tint: colors.success, soft: colors.surfaceAlt,
      blurb: 'Downloaded to this device and added to the gallery.',
    }
  }
  if (job.state === 'success') {
    return {
      label: 'Ready', tint: colors.success, soft: colors.surfaceAlt,
      blurb: 'Finished. Save it to this device — KIE keeps the file for 24 hours after completion.',
    }
  }
  if (job.state === 'generating') {
    return {
      label: 'Generating', tint: colors.brand, soft: colors.brandSoft,
      blurb: 'KIE is rendering this now.',
    }
  }
  // waiting / queuing
  return {
    label: 'Queued', tint: colors.brand, soft: colors.brandSoft,
    blurb: 'Accepted by KIE and waiting for a slot.',
  }
}

function relativeTime(ts) {
  if (!ts) return ''
  const mins = Math.floor((Date.now() - ts) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} hr ago`
  return `${Math.floor(hrs / 24)} d ago`
}

const styles = StyleSheet.create({
  content: { padding: space.lg },
  flex: { flex: 1 },

  summary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.sm },
  summaryText: { fontSize: 14, fontWeight: '600' },
  hint: { fontSize: 12, lineHeight: 17, marginBottom: space.lg },

  card: {
    borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth,
    padding: space.lg, marginBottom: space.md, gap: space.sm,
  },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  cardTitle: { fontSize: 15, fontWeight: '700' },
  cardMeta: { fontSize: 12, marginTop: 2 },
  cardBody: { fontSize: 13, lineHeight: 18 },

  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill },
  pillText: { fontSize: 12, fontWeight: '700' },

  actions: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.xs },
  discard: { paddingVertical: space.sm, paddingHorizontal: space.sm },
  discardText: { fontSize: 13, fontWeight: '600' },

  savingRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm },
  savingText: { fontSize: 13 },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.xxl },
  emptyIcon: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', marginBottom: space.lg },
  emptyGlyph: { fontSize: 30 },
  emptyTitle: { fontSize: 18, fontWeight: '700', marginBottom: space.sm },
  emptyBody: { fontSize: 14, lineHeight: 21, textAlign: 'center' },
})
