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
import { View, Text, Image, Pressable, ActivityIndicator, StyleSheet, Alert } from 'react-native'

import { IDENTITY_SLOTS, generateIdentityRef, NO_MAIN_IMAGE } from '@core/identityRefs'
import { STILL_RUNNING } from '@core/services/generation'
import { uploadLocal } from '@core/data/assets'
import { persistGenerated } from '@core/platform/persistMedia'
import { userMessage } from '@core/errors'
import { useInfluencers } from '@core/store'

import { useTheme, space, radius } from '../theme'
import { Section, Button } from '../components/ui'
import { mediaSource } from '../lib/seedMedia'
import { pickImageWithPrompt } from '../lib/picker'
import { shareMedia } from '../lib/share'
import { usePendingResult } from '../hooks/usePendingResult'

export default function IdentityRefs({ influencer }) {
  return (
    <Section
      title="Reference sheets"
      footer="Generated from the main image and used as identity references in every video and motion copy. More references means the influencer stays recognisably themselves."
    >
      <View style={styles.list}>
        {IDENTITY_SLOTS.map((slot, i) => (
          <RefSlot
            key={slot.key}
            slot={slot}
            influencer={influencer}
            last={i === IDENTITY_SLOTS.length - 1}
          />
        ))}
      </View>
    </Section>
  )
}

function RefSlot({ slot, influencer, last }) {
  const { colors } = useTheme()
  const { updateInfluencer, addGeneration } = useInfluencers()
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState(null)
  /** A sheet that outlived the foreground poll, watched until it lands. */
  const [pendingTaskId, setPendingTaskId] = useState(null)

  const value = influencer[slot.field]
  const source = mediaSource(value)

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
      // KIE deletes result URLs within a day, so the server copies the file
      // into this user's storage — same as every other generated file.
      const { assetId } = await persistGenerated({
        sourceUrl: url, kind: 'image', influencerId: influencer.id,
      })
      await save(assetId)
    } catch (e) {
      if (e?.message === STILL_RUNNING && taskId) {
        // Not failed. Watched below so it is set in THIS slot when it lands.
        // Collecting it from the Queue only filed it in the gallery, and people
        // generated — and paid for — the sheet a second time.
        setPendingTaskId(taskId)
      } else {
        setError(
          e?.message === NO_MAIN_IMAGE
            ? 'Add a main image first — it is the face reference.'
            : e?.message === STILL_RUNNING
            ? 'Still generating — not failed. It will be saved to the gallery when it finishes.'
            : userMessage(e, `The ${slot.label.toLowerCase()} could not be generated. Please try again.`))
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
        setError(userMessage(e, `The ${slot.label.toLowerCase()} finished but could not be set here. Please try again.`)))
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
      setError(userMessage(e, 'Could not upload that image. Please try again.'))
    } finally {
      setBusy(false)
    }
  }, [save, influencer.id])

  const remove = useCallback(() => {
    Alert.alert(`Remove ${slot.label}?`, 'The generated image stays in the gallery.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => {
        // Clears the slot only. The file stays in the gallery, which is what
        // the dialog promises — removing it here would delete a generation the
        // user may still want.
        updateInfluencer(influencer.id, { [slot.assetField]: null })
          .catch(e => setError(userMessage(e, 'Could not remove it. Please try again.')))
      } },
    ])
  }, [influencer.id, slot.assetField, slot.label, updateInfluencer])

  return (
    <View style={[styles.slot, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSubtle }]}>
      <View style={styles.head}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.label, { color: colors.textPrimary }]}>{slot.label}</Text>
          <Text style={[styles.blurb, { color: colors.textTertiary }]}>{slot.blurb}</Text>
        </View>
        {source ? (
          <View style={[styles.badge, { backgroundColor: colors.brandSoft }]}>
            <Text style={[styles.badgeText, { color: colors.brandDeep }]}>SET</Text>
          </View>
        ) : null}
      </View>

      {source ? (
        <Image
          source={source}
          style={[styles.preview, { aspectRatio: previewRatio(slot.aspectRatio), borderColor: colors.borderSubtle }]}
          resizeMode="contain"
        />
      ) : null}

      {busy || pendingTaskId ? (
        <View style={[styles.progressBox, { borderColor: colors.borderSubtle }]}>
          <ActivityIndicator size="small" color={colors.brand} />
          <Text style={[styles.progressText, { color: colors.textSecondary }]}>
            {pendingTaskId
              ? 'Still generating — slower than usual, not failed. It will appear here when it finishes.'
              : progress > 0 ? `Generating… ${Math.round(progress)}%` : 'Generating…'}
          </Text>
        </View>
      ) : (
        <View style={styles.actions}>
          <View style={styles.flex}>
            <Button
              title={source ? 'Regenerate' : 'Generate'}
              variant={source ? 'secondary' : 'primary'}
              onPress={generate}
            />
          </View>
          <View style={styles.flex}>
            <Button title={source ? 'Replace' : 'Upload'} variant="secondary" onPress={replace} />
          </View>
        </View>
      )}

      {source && !busy && !pendingTaskId ? (
        <View style={styles.subActions}>
          <Pressable onPress={() => shareMedia(value, `${(influencer.name || 'ref').toLowerCase()}-${slot.key}.jpg`)} hitSlop={8}>
            <Text style={[styles.subAction, { color: colors.brandDeep }]}>Save or share</Text>
          </Pressable>
          <Pressable onPress={remove} hitSlop={8}>
            <Text style={[styles.subAction, { color: colors.danger }]}>Remove</Text>
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
  list: { paddingHorizontal: space.lg },
  slot: { paddingVertical: space.lg, gap: space.md },

  head: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  label: { fontSize: 15, fontWeight: '600' },
  blurb: { fontSize: 12.5, lineHeight: 17, marginTop: 2 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.sm },
  badgeText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },

  preview: { width: '100%', borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, backgroundColor: '#000' },

  progressBox: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    paddingVertical: space.md, paddingHorizontal: space.md,
    borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderStyle: 'dashed',
  },
  progressText: { fontSize: 13 },

  actions: { flexDirection: 'row', gap: space.md },
  flex: { flex: 1 },

  subActions: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: space.xs },
  subAction: { fontSize: 13, fontWeight: '600' },

  error: { fontSize: 13, lineHeight: 18 },
})
