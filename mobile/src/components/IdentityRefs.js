/**
 * The three identity reference sheets, generated from the main image.
 *
 * These fields have always existed on an influencer and the generation layer
 * has always read them — the video prompt tags the close-ups for facial
 * detail, Videos passes all three as references, Motion Copy offers them as
 * the character. Only the removed web studio could produce them, so on mobile
 * they sat at null forever and video generation quietly ran on one reference
 * instead of four. This is the missing half.
 *
 * Each slot generates independently: a sheet takes a couple of minutes, and
 * blocking the other two behind it would be needless.
 */

import { useCallback, useState } from 'react'
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native'

import { Alert } from '../lib/dialog'

import { IDENTITY_SLOTS, generateIdentityRef, NO_MAIN_IMAGE } from '@core/identityRefs'
import { STILL_RUNNING } from '@core/services/generation'
import { uploadLocal } from '@core/data/assets'
import { persistGenerated } from '@core/platform/persistMedia'
import { userMessage } from '@core/errors'
import { useInfluencers } from '@core/store'

import { useTheme, space, radius, font } from '../theme'
import { Section, Button } from '../components/ui'
import { isServable } from '../lib/seedMedia'
import MediaImage from './MediaImage'
import ImageViewer from './ImageViewer'
import Icon from './icons'
import { pickImageWithPrompt } from '../lib/picker'
import { shareMedia } from '../lib/share'
import { usePendingResult } from '../hooks/usePendingResult'

export default function IdentityRefs({ influencer }) {
  return (
    <Section
      title="Reference images"
      footer="Generated from the main image and used to keep the influencer's appearance consistent in videos and motion copies."
    >
      <View style={styles.list}>
        {IDENTITY_SLOTS.map(slot => (
          <RefSlot key={slot.key} slot={slot} influencer={influencer} />
        ))}
      </View>
    </Section>
  )
}

function RefSlot({ slot, influencer }) {
  const { colors } = useTheme()
  const { updateInfluencer, addGeneration } = useInfluencers()
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState(null)
  /** A sheet that outlived the foreground poll, watched until it lands. */
  const [pendingTaskId, setPendingTaskId] = useState(null)
  /** Open full screen, to zoom into the detail a sheet exists for. */
  const [viewing, setViewing] = useState(false)
  /** A sheet just generated, shown from the generator's link: `assetId` null while it is being stored. */
  const [fresh, setFresh] = useState(null)
  const [storing, setStoring] = useState(false)

  const value = influencer[slot.field]
  // The fresh sheet while it is stored, and after, for as long as it is still this slot's file.
  const source = fresh && (storing || fresh.assetId === null || fresh.assetId === influencer[slot.assetField])
    ? fresh.url
    : isServable(value) ? value : null

  /**
   * Point the slot at an asset, and record it in the gallery.
   *
   * Two writes, in this order. The slot assignment is the one that matters —
   * it is what video generation reads — so the gallery entry is best-effort
   * behind it. A failed gallery write should not leave the sheet unset.
   */
  const save = useCallback(async assetId => {
    await updateInfluencer(influencer.id, { [slot.assetField]: assetId })
    if (!assetId) return
    try {
      await addGeneration({
        influencerId: influencer.id, assetId, kind: 'image', label: slot.label,
      })
    } catch (e) {
      console.warn('[identityRefs] gallery entry not recorded:', e?.message ?? e)
    }
  }, [influencer.id, slot.assetField, slot.label, updateInfluencer, addGeneration])

  const generate = useCallback(async () => {
    setBusy(true); setError(null); setProgress(0)
    let taskId = null
    try {
      const url = await generateIdentityRef(influencer, slot.key, {
        onProgress: setProgress,
        onJobIds: ids => { taskId = ids?.[0] ?? null },
        queueMeta: { influencerId: influencer.id, influencerName: influencer.name, label: slot.label },
      })
      // On screen at once, from the generator's link, while the server copies it into storage
      // (that copy used to come first). Only shown, never saved; kept so it is not fetched twice.
      setFresh({ url, assetId: null })
      setBusy(false)
      setStoring(true)
      try {
        // KIE deletes result URLs within a day, so the server copies the file
        // into this user's storage — same as every other generated file.
        const { assetId } = await persistGenerated({
          sourceUrl: url, kind: 'image', influencerId: influencer.id,
        })
        setFresh({ url, assetId })
        await save(assetId)
      } catch (e) {
        // Not stored (refused by the content check, or the copy failed): the previous sheet comes back.
        setFresh(null)
        throw e
      } finally {
        setStoring(false)
      }
    } catch (e) {
      if (e?.message === STILL_RUNNING && taskId) {
        // Not failed. Watched below so it is set in THIS slot when it lands.
        // Collecting it from the Queue only filed it in the gallery, and people
        // generated — and paid for — the sheet a second time.
        setPendingTaskId(taskId)
      } else {
        setError(
          e?.message === NO_MAIN_IMAGE
            ? 'Add a main image first. It is used as the face reference.'
            : e?.message === STILL_RUNNING
            ? 'Still generating. The image will be saved to the gallery when it is ready.'
            : userMessage(e, `Unable to generate the ${slot.label.toLowerCase()}. Please try again.`))
      }
    } finally {
      setBusy(false); setProgress(0)
    }
  }, [influencer, slot.key, save])

  usePendingResult(pendingTaskId, {
    kind: 'image',
    influencerId: influencer.id,
    onReady: ({ assetId }) => {
      setPendingTaskId(null)
      save(assetId).catch(e =>
        setError(userMessage(e, `The ${slot.label.toLowerCase()} was generated but could not be applied. Please try again.`)))
    },
    onFailed: message => {
      setPendingTaskId(null)
      setError(message)
    },
  })

  const replace = useCallback(async () => {
    const uri = await pickImageWithPrompt()
    if (!uri) return
    setBusy(true); setError(null)
    try {
      const { assetId } = await uploadLocal({
        uri, kind: 'image', contentType: 'image/jpeg', influencerId: influencer.id,
      })
      await save(assetId)
    } catch (e) {
      setError(userMessage(e, 'The image could not be uploaded. Please try again.'))
    } finally {
      setBusy(false)
    }
  }, [save, influencer.id])

  const remove = useCallback(() => {
    Alert.alert(`Remove ${slot.label.toLowerCase()}?`, 'The image will remain in the gallery.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => {
        // Clears the slot only. The file stays in the gallery, which is what
        // the dialog promises — removing it here would delete a generation the
        // user may still want.
        updateInfluencer(influencer.id, { [slot.assetField]: null })
          .catch(e => setError(userMessage(e, 'Unable to remove it. Please try again.')))
      } },
    ])
  }, [influencer.id, slot.assetField, slot.label, updateInfluencer])

  return (
    <View style={styles.slot}>
      <View style={styles.head}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.label, font('medium'), { color: colors.textPrimary }]}>{slot.label}</Text>
          <Text style={[styles.blurb, { color: colors.textSecondary }]}>{slot.blurb}</Text>
        </View>
        {source ? (
          <View style={[styles.badge, { backgroundColor: colors.accentSoft }]}>
            <Text style={[styles.badgeText, font('semibold'), { color: colors.primary }]}>Added</Text>
          </View>
        ) : null}
      </View>

      {source ? (
        <Pressable
          onPress={() => setViewing(true)}
          accessibilityRole="imagebutton"
          accessibilityLabel={`${slot.label}, open full screen`}
          style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
        >
          <MediaImage
            uri={source}
            style={[styles.preview, { aspectRatio: previewRatio(slot.aspectRatio), backgroundColor: colors.surfaceAlt }]}
            contentFit="contain"
          />
          <View style={styles.expand} pointerEvents="none">
            <Icon name="expand" size={16} color="#FFFFFF" />
          </View>
        </Pressable>
      ) : null}
      <ImageViewer uri={viewing ? source : null} title={`${influencer.name || ''} · ${slot.label}`} onClose={() => setViewing(false)} />

      {busy || pendingTaskId ? (
        <View style={[styles.progressBox, { borderColor: colors.border }]}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={[styles.progressText, { color: colors.textSecondary }]}>
            {pendingTaskId
              ? 'Still generating. The image will appear here when it is ready.'
              : progress > 0 ? `Generating… ${Math.round(progress)}%` : 'Generating…'}
          </Text>
        </View>
      ) : storing ? (
        <View style={styles.savingRow}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={[styles.progressText, { color: colors.textSecondary }]}>Saving the new image…</Text>
        </View>
      ) : (
        <View style={styles.actions}>
          <View style={styles.flex}>
            <Button
              title={source ? 'Regenerate' : 'Generate'}
              size="sm"
              variant="primary"
              onPress={generate}
            />
          </View>
          <View style={styles.flex}>
            <Button title={source ? 'Replace' : 'Upload'} size="sm" variant="soft" onPress={replace} />
          </View>
        </View>
      )}

      {source && !busy && !storing && !pendingTaskId ? (
        <View style={styles.subActions}>
          <Pressable onPress={() => shareMedia(source, `${(influencer.name || 'ref').toLowerCase()}-${slot.key}.jpg`)} hitSlop={8}>
            <Text style={[styles.subAction, font('semibold'), { color: colors.primary }]}>Share</Text>
          </Pressable>
          <Pressable onPress={remove} hitSlop={8}>
            <Text style={[styles.subAction, font('semibold'), { color: colors.danger }]}>Remove</Text>
          </Pressable>
        </View>
      ) : null}

      {error ? <Text style={[styles.error, { color: colors.danger }]}>{error}</Text> : null}
    </View>
  )
}

/** "16:9" -> 16/9, so each sheet previews at the shape it was generated in. */
function previewRatio(ar) {
  const [w, h] = String(ar).split(':').map(Number)
  return w && h ? w / h : 1
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: space.lg + 2, paddingVertical: space.sm },
  slot: { paddingVertical: space.md + 2, gap: space.md },

  head: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  label: { fontSize: 15 },
  blurb: { fontSize: 12.5, lineHeight: 17, marginTop: 2 },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill },
  badgeText: { fontSize: 11 },

  preview: { width: '100%', borderRadius: radius.md },
  expand: {
    position: 'absolute', right: space.sm, bottom: space.sm,
    width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },

  progressBox: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    paddingVertical: space.md, paddingHorizontal: space.md,
    borderRadius: radius.md, borderWidth: 1.2, borderStyle: 'dashed',
  },
  progressText: { fontSize: 13, flex: 1 },
  savingRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm },

  actions: { flexDirection: 'row', gap: space.md },
  flex: { flex: 1 },

  subActions: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: space.xs },
  subAction: { fontSize: 13 },

  error: { fontSize: 13, lineHeight: 18 },
})
