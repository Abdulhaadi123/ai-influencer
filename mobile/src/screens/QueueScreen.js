/**
 * Queue — every generation this account has started, and where it got to.
 *
 * Generation is asynchronous and slow, and KIE's result URLs expire in 24
 * hours, so the taskId is the only durable handle to work already paid for.
 * That handle is a database row now, not device storage — which means a job
 * started on a phone is visible, and collectable, from any other device the
 * user signs in to.
 *
 * ── Push, not poll ───────────────────────────────────────────────────────────
 *
 * The list updates from a Realtime subscription. Something still has to ask KIE
 * whether a task has finished — that is the sync loop — but the UI never polls
 * for the answer, it is told.
 *
 * ── "Done" is not "safe" ─────────────────────────────────────────────────────
 *
 * A finished job stays as Ready until its bytes are in our own storage, and is
 * marked Expired past 24 hours rather than offering a button that would 404.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  View, Text, ScrollView, Pressable, RefreshControl,
  ActivityIndicator, StyleSheet, Alert,
} from 'react-native'
import { useFocusEffect } from '@react-navigation/native'

import { useAuth } from '@core/auth/AuthContext'
import {
  listJobs, isActive, isCollectable, isExpired, isDeleted,
  removeJob, clearSettled, subscribe as subscribeToJobs,
} from '@core/data/jobs'
import { useInfluencers } from '@core/store'
import { persistGenerated } from '@core/platform/persistMedia'
import { resolveUrl } from '@core/data/assets'
import { userMessage } from '@core/errors'

import { syncActiveJobs } from '../lib/queueSync'
import { shareMedia } from '../lib/share'
import { showError } from '../lib/alerts'
import { useBottomInset } from '../hooks/useBottomInset'
import { useTheme, space, radius } from '../theme'
import { Button } from '../components/ui'

/** How often to ask KIE about running jobs while this screen is open. */
const POLL_MS = 8000

export default function QueueScreen() {
  const { colors } = useTheme()
  const bottomInset = useBottomInset()
  const { userId } = useAuth()
  const { addGeneration } = useInfluencers()

  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [savingId, setSavingId] = useState(null)
  // Shown instead of "Nothing in the queue", which is what a failed load used
  // to look like — telling someone with running jobs that they had none.
  const [loadError, setLoadError] = useState(null)

  const reload = useCallback(async () => {
    try {
      setJobs(await listJobs())
      setLoadError(null)
    } catch (e) {
      setLoadError(userMessage(e, 'The queue could not be loaded. Please try again.'))
    } finally {
      setLoading(false)
    }
  }, [])

  // Realtime keeps the list current; the interval only nudges KIE.
  useEffect(() => {
    if (!userId) return
    reload()
    const unsubscribe = subscribeToJobs(userId, reload)
    return unsubscribe
  }, [userId, reload])

  // Only while this tab is on screen. Bottom tabs stay mounted after their
  // first visit, so a plain effect kept asking KIE every 8 seconds for the rest
  // of the session, from whichever tab the user was actually looking at.
  useFocusEffect(useCallback(() => {
    syncActiveJobs()
    const id = setInterval(() => { syncActiveJobs() }, POLL_MS)
    return () => clearInterval(id)
  }, []))

  const onPullRefresh = useCallback(async () => {
    setRefreshing(true)
    await syncActiveJobs()
    await reload()
    setRefreshing(false)
  }, [reload])

  /**
   * Bring a finished result into permanent storage.
   *
   * This is the moment a job stops depending on KIE. Until it completes, the
   * only copy is behind a URL with hours left on it.
   */
  const collect = useCallback(async job => {
    setSavingId(job.id)
    try {
      const { assetId } = await persistGenerated({
        sourceUrl: job.resultUrl,
        kind: job.kind === 'image' ? 'image' : 'video',
        influencerId: job.influencerId,
      })

      if (job.influencerId) {
        await addGeneration({
          influencerId: job.influencerId,
          assetId,
          kind: job.kind === 'image' ? 'image' : 'video',
          label: job.label,
        })
      }

      await reload()
      Alert.alert(
        'Saved',
        job.influencerId
          ? 'Added to the gallery.'
          : 'Saved to your library. Use Share to export it.',
      )
    } catch (e) {
      showError('Unable to save', e, 'The result could not be saved. Please try again.')
    } finally {
      setSavingId(null)
    }
  }, [addGeneration, reload])

  const share = useCallback(async job => {
    try {
      const url = await resolveUrl(job.assetId)
      if (!url) { Alert.alert('Not available', 'This file could not be found.'); return }
      const base = (job.label || 'result').toLowerCase().replace(/\s+/g, '-')
      await shareMedia(url, `${base}.${job.kind === 'image' ? 'jpg' : 'mp4'}`)
    } catch (e) {
      showError('Unable to share', e, 'This file could not be shared. Please try again.')
    }
  }, [])

  const discard = useCallback(job => {
    // A finished result nobody has saved exists only behind the generator's
    // link, and this row is the only way back to it. Removing it throws away a
    // result that was paid for, so the warning says exactly that.
    const unsaved = isCollectable(job)
    Alert.alert(
      unsaved ? 'Discard this result?' : 'Remove from queue?',
      unsaved
        ? 'This result has not been saved yet. Removing it will discard it permanently.'
        : 'This removes the item from the queue. Anything already saved stays in the gallery.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: unsaved ? 'Discard' : 'Remove',
          style: 'destructive',
          onPress: async () => {
            try { await removeJob(job.id); await reload() }
            catch (e) { showError('Unable to remove', e, 'The item could not be removed. Please try again.') }
          },
        },
      ],
    )
  }, [reload])

  const clearDone = useCallback(async () => {
    try { await clearSettled(); await reload() }
    catch (e) { showError('Unable to clear', e, 'The queue could not be cleared. Please try again.') }
  }, [reload])

  const activeCount = useMemo(() => jobs.filter(isActive).length, [jobs])
  const readyCount = useMemo(() => jobs.filter(isCollectable).length, [jobs])
  // What "Clear finished" would remove. Results waiting to be saved are not
  // cleared (see clearSettled), so they do not count.
  const settledCount = useMemo(() => jobs.filter(j => !isActive(j) && !isCollectable(j)).length, [jobs])

  if (loading) {
    return (
      <View style={[styles.centre, { backgroundColor: colors.bg }]}>
        <ActivityIndicator size="large" color={colors.brand} />
      </View>
    )
  }

  if (!jobs.length && loadError) {
    return (
      <View style={[styles.empty, { backgroundColor: colors.bg, paddingBottom: bottomInset }]}>
        <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>Unable to load the queue</Text>
        <Text style={[styles.emptyBody, { color: colors.textSecondary }]}>{loadError}</Text>
        <View style={{ marginTop: space.lg }}>
          <Button title="Try again" onPress={() => { setLoading(true); reload() }} />
        </View>
      </View>
    )
  }

  if (!jobs.length) {
    return (
      <View style={[styles.empty, { backgroundColor: colors.bg, paddingBottom: bottomInset }]}>
        <View style={[styles.emptyIcon, { backgroundColor: colors.brandSoft }]}>
          <Text style={styles.emptyGlyph}>🕓</Text>
        </View>
        <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>No generations yet</Text>
        <Text style={[styles.emptyBody, { color: colors.textSecondary }]}>
          Images and videos you generate appear here with their progress.
          Generation continues even if you close the app.
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
            ? `${activeCount} in progress${readyCount ? ` · ${readyCount} ready to save` : ''}`
            : readyCount > 0
            ? `${readyCount} ready to save`
            : 'No generations in progress'}
        </Text>
        {activeCount > 0 ? <ActivityIndicator size="small" color={colors.brand} /> : null}
      </View>

      {loadError ? (
        <Text style={[styles.hint, { color: colors.danger }]}>
          {loadError} Pull down to refresh.
        </Text>
      ) : null}

      {activeCount > 0 ? (
        <Text style={[styles.hint, { color: colors.textTertiary }]}>
          Generation continues in the background. Completed results are
          available for 24 hours, so save them before they expire.
        </Text>
      ) : null}

      {jobs.map(job => (
        <JobRow
          key={job.id}
          job={job}
          saving={savingId === job.id}
          onCollect={() => collect(job)}
          onShare={() => share(job)}
          onDiscard={() => discard(job)}
        />
      ))}

      {settledCount > 0 ? (
        <View style={{ marginTop: space.md }}>
          <Button title="Clear completed" variant="secondary" onPress={clearDone} />
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
          <Text style={[styles.savingText, { color: colors.textSecondary }]}>Saving…</Text>
        </View>
      ) : (
        <View style={styles.actions}>
          {isCollectable(job) ? (
            <View style={styles.flex}>
              <Button title="Save to gallery" onPress={onCollect} />
            </View>
          ) : null}
          {job.assetId ? (
            <View style={styles.flex}>
              <Button title="Share" variant="secondary" onPress={onShare} />
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
 * KIE's five states, collapsed into what the user actually needs to know: is it
 * still coming, is it waiting for me, or is it over.
 */
function describe(job, colors) {
  if (job.state === 'fail') {
    return {
      label: 'Failed', tint: colors.danger, soft: 'transparent',
      blurb: job.failMsg || 'This generation failed.',
    }
  }
  if (isDeleted(job)) {
    return {
      label: 'Deleted', tint: colors.textTertiary, soft: colors.surfaceAlt,
      blurb: 'This result was saved and has since been deleted.',
    }
  }
  if (isExpired(job)) {
    return {
      label: 'Expired', tint: colors.danger, soft: 'transparent',
      blurb: 'This result expired 24 hours after it was completed and is no longer available. It would need to be generated again.',
    }
  }
  if (job.assetId) {
    return {
      label: 'Saved', tint: colors.success, soft: colors.surfaceAlt,
      // Images made while creating an influencer become its main image, not a
      // gallery entry — claiming "added to the gallery" sent people looking.
      blurb: job.influencerId
        ? 'Saved to your library and added to the gallery.'
        : 'Saved to your library.',
    }
  }
  if (job.state === 'success') {
    return {
      label: 'Ready', tint: colors.success, soft: colors.surfaceAlt,
      blurb: 'Completed. Save it within 24 hours to keep it.',
    }
  }
  if (job.state === 'generating') {
    return { label: 'Generating', tint: colors.brand, soft: colors.brandSoft, blurb: 'Generating now.' }
  }
  return { label: 'Queued', tint: colors.brand, soft: colors.brandSoft, blurb: 'Waiting to start.' }
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
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },

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
