/**
 * "Change outfit": a sheet that dresses the influencer's main image in one of their saved outfits.
 *
 *   choose   the main image and the chosen outfit side by side, the outfits to pick from (or add one
 *            from the phone), an optional line of direction, what it costs, Generate
 *   working  the same progress the reference sheets show; a picture that outlives the foreground poll
 *            is watched until it lands (usePendingResult), so it is not paid for twice
 *   result   the new picture, saved to the Gallery as "Outfit change · <name>", with Use as main
 *            image, Share and Try another
 *
 * The picture is shown at once from the generator's link while the server copies it into storage, the
 * way Regenerate and the reference sheets do (quickPreview, persistGenerated). It is filed in the
 * Gallery either way — here, or by the server's worker if the app stopped watching — and never becomes
 * the main image unless the person says so: every video and sheet is made from the main image, and
 * the reference sheets would still show the old outfit.
 *
 * The sheet stays mounted by the Profile tab, so closing it does not stop a picture being made: reopen
 * it and the result is there.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  View, Text, Pressable, Modal, ScrollView, ActivityIndicator, KeyboardAvoidingView, Platform, StyleSheet,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { changeOutfit } from '@core/outfitChange'
import { NO_MAIN_IMAGE, NO_OUTFIT_IMAGE, outfitLabel } from '@core/wardrobe'
import { INPUT_LIMITS } from '@core/config/inputLimits'
import { IMAGE_MODEL_ID } from '@core/config/generation'
import { STILL_RUNNING } from '@core/services/generation'
import { quickPreview, waitForPreview, resolveUrl, thumbUrlFor } from '@core/data/assets'
import { persistGenerated } from '@core/platform/persistMedia'
import { useInfluencers } from '@core/store'

import { useTheme, space, radius, font, layout } from '../theme'
import { Button, PillInput } from './ui'
import CostNote from './CostNote'
import ShareStatusHost from './ShareStatusHost'
import MediaImage from './MediaImage'
import ImageViewer from './ImageViewer'
import Icon from './icons'
import { Alert } from '../lib/dialog'
import { shareMedia } from '../lib/share'
import { showError } from '../lib/alerts'
import { useWardrobe, errorText } from '../hooks/useWardrobe'
import { usePendingResult } from '../hooks/usePendingResult'

/**
 * @param {object} props
 * @param {boolean} props.visible
 * @param {object} props.influencer
 * @param {string|null} [props.initialOutfitId]  the outfit chosen when the sheet opens
 * @param {() => void} props.onClose
 * @param {(assetId: string) => Promise<void>} props.onUseAsMain  make the result the main image
 */
export default function OutfitSheet({ visible, influencer, initialOutfitId = null, onClose, onUseAsMain }) {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { addGeneration } = useInfluencers()
  const wardrobe = useWardrobe(influencer)
  const { outfits } = wardrobe

  const [outfitId, setOutfitId] = useState(initialOutfitId)
  const [note, setNote] = useState('')
  const [phase, setPhase] = useState('choose')          // 'choose' | 'working' | 'result'
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState(null)
  /** A picture that outlived the foreground poll, watched until it lands. */
  const [pendingTaskId, setPendingTaskId] = useState(null)
  /** `{url, thumbUrl, assetId, name}`; `assetId` is null while the server is copying it into storage. */
  const [result, setResult] = useState(null)
  const [storing, setStoring] = useState(false)
  const [viewing, setViewing] = useState(false)
  const [usingAsMain, setUsingAsMain] = useState(false)

  const working = useRef(false)
  const scroller = useRef(null)
  // The note sits low in a tall sheet: when it is tapped, bring the end of the sheet (the note, the cost,
  // Generate) into view, once the keyboard has come up.
  const onNoteFocus = useCallback(() => {
    setTimeout(() => scroller.current?.scrollToEnd({ animated: true }), 300)
  }, [])
  const pendingName = useRef('')

  // An opening for a particular outfit starts on it — also when a finished picture was left showing
  // (one that landed while the sheet was closed): the person came to try this outfit, not to see that.
  useEffect(() => {
    if (!visible || !initialOutfitId) return
    setOutfitId(initialOutfitId)
    if (phase === 'result' && !storing) {
      setResult(null)
      setPhase('choose')
    }
  }, [visible, initialOutfitId])

  const chosen = outfits.find(o => o.id === outfitId) ?? outfits[0] ?? null
  const hasMain = !!influencer.mainImage

  const giveThumb = useCallback(match => thumbUrl => {
    if (thumbUrl) setResult(r => (r && match(r) && !r.thumbUrl ? { ...r, thumbUrl } : r))
  }, [])

  const generate = useCallback(async () => {
    if (!chosen || !hasMain || working.current) return
    working.current = true
    const name = chosen.name
    pendingName.current = name
    setError(null); setProgress(0); setResult(null); setPhase('working')
    let taskId = null
    try {
      const url = await changeOutfit(influencer, chosen, {
        note,
        onProgress: setProgress,
        onJobIds: ids => { taskId = ids?.[0] ?? null },
        queueMeta: { influencerId: influencer.id, influencerName: influencer.name },
      })
      // On screen at once, from the generator's link, while the server copies it into storage. Only
      // shown, never saved; kept so it is not fetched twice.
      setResult({ url, thumbUrl: null, assetId: null, name })
      setPhase('result')
      setStoring(true)
      quickPreview({ sourceUrl: url, taskId }).then(giveThumb(r => r.url === url))
      try {
        // KIE deletes result URLs within a day, so the server copies the file into this user's storage.
        const { assetId } = await persistGenerated({ sourceUrl: url, kind: 'image', influencerId: influencer.id })
        setResult(r => (r && r.url === url ? { ...r, assetId } : r))
        waitForPreview(assetId).then(giveThumb(r => r.assetId === assetId))
        // Best effort, behind the picture being safe: the server's worker files it too, and an entry
        // that exists is returned, not added twice.
        try {
          await addGeneration({ influencerId: influencer.id, assetId, kind: 'image', label: outfitLabel(name) })
        } catch (e) {
          console.warn('[outfit] gallery entry not recorded:', e?.message ?? e)
        }
      } catch (e) {
        // Not stored (refused by the content check, or the copy failed): back to choosing.
        setResult(null)
        setPhase('choose')
        throw e
      } finally {
        setStoring(false)
      }
    } catch (e) {
      if (e?.message === STILL_RUNNING && taskId) {
        setPendingTaskId(taskId)          // still 'working': watched below, so it is shown when it lands
      } else {
        setPhase('choose')
        if (e?.message === STILL_RUNNING) {
          setError('Still generating. The image will be saved to the gallery when it is ready.')
        } else if (e?.message === NO_MAIN_IMAGE) {
          setError('Add a main image first. The outfit is put on it.')
        } else if (e?.message === NO_OUTFIT_IMAGE) {
          setError('This outfit has no photo. Replace it, or choose another.')
        } else {
          setError(errorText(e, 'Unable to change the outfit. Please try again.'))
        }
      }
    } finally {
      working.current = false
      setProgress(0)
    }
  }, [chosen, hasMain, influencer, note, giveThumb, addGeneration])

  usePendingResult(pendingTaskId, {
    kind: 'image',
    influencerId: influencer.id,
    onReady: async ({ assetId, url }) => {
      setPendingTaskId(null)
      const shown = url ?? await resolveUrl(assetId).catch(() => null)
      setResult({ url: shown, thumbUrl: thumbUrlFor(assetId), assetId, name: pendingName.current })
      setPhase('result')
    },
    onFailed: message => {
      setPendingTaskId(null)
      setPhase('choose')
      setError(message)
    },
  })

  const addPhoto = useCallback(async () => {
    const slot = await wardrobe.add()
    if (slot) setOutfitId(slot.id)
  }, [wardrobe])

  /** Back to choosing, with what was chosen kept — for another try. */
  const tryAnother = useCallback(() => {
    setResult(null)
    setError(null)
    setPhase('choose')
  }, [])

  const close = useCallback(() => {
    // A finished picture is done with; one still being made carries on behind the closed sheet.
    if (phase === 'result' && !storing) tryAnother()
    onClose()
  }, [phase, storing, tryAnother, onClose])

  const useAsMain = useCallback(() => {
    if (!result?.assetId || usingAsMain) return
    Alert.alert(
      'Use as main image?',
      'This replaces the current main image. Videos and reference sheets already made are not changed.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Replace',
          onPress: async () => {
            setUsingAsMain(true)
            try {
              await onUseAsMain(result.assetId)
              tryAnother()
              onClose()
            } catch (e) {
              showError('Unable to update', e, 'The new image could not be set as the main image. Please try again.')
            } finally {
              setUsingAsMain(false)
            }
          },
        },
      ],
    )
  }, [result, usingAsMain, onUseAsMain, tryAnother, onClose])

  const who = influencer.name || 'this influencer'

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close} statusBarTranslucent>
      {/* iOS lifts the sheet over the keyboard. Android resizes the window itself, like the app's other
          dialogs; `behavior="height"` on top of that left the sheet short of the bottom edge after the
          keyboard was gone. */}
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.backdrop} onPress={close} accessibilityLabel="Close" />
        <View style={[styles.sheet, { backgroundColor: colors.sheet, paddingBottom: insets.bottom + space.lg }]}>
          <ScrollView
            ref={scroller}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.content}
          >
            <View style={styles.titleRow}>
              <Text style={[styles.title, font('bold'), { color: colors.textPrimary }]}>Change outfit</Text>
              <Pressable onPress={close} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
                <Icon name="close" size={22} color={colors.textTertiary} />
              </Pressable>
            </View>

            {phase === 'choose' ? (
              <ChooseView
                who={who}
                influencer={influencer}
                wardrobe={wardrobe}
                chosen={chosen}
                hasMain={hasMain}
                note={note}
                onNote={setNote}
                onNoteFocus={onNoteFocus}
                onChoose={setOutfitId}
                onAdd={addPhoto}
                error={error ?? wardrobe.error}
                onGenerate={generate}
                onCancel={close}
              />
            ) : phase === 'working' ? (
              <WorkingView progress={progress} pending={!!pendingTaskId} onHide={close} />
            ) : (
              <ResultView
                result={result}
                storing={storing}
                usingAsMain={usingAsMain}
                onOpen={() => setViewing(true)}
                onUseAsMain={useAsMain}
                onShare={() => result?.url && shareMedia(result.url, `${(influencer.name || 'influencer').toLowerCase()}-outfit.jpg`)}
                onAnother={tryAnother}
                onDone={close}
              />
            )}
          </ScrollView>
        </View>
        {/* Share downloads the picture first; the pill that says so, mounted in the navigator, is behind this Modal. */}
        <ShareStatusHost placement="top" />
      </KeyboardAvoidingView>

      <ImageViewer
        uri={viewing ? result?.url ?? null : null}
        previewUri={result?.thumbUrl ?? null}
        title={`${influencer.name || ''} · ${result?.name || 'Outfit change'}`}
        onClose={() => setViewing(false)}
      />
    </Modal>
  )
}

function ChooseView({ who, influencer, wardrobe, chosen, hasMain, note, onNote, onNoteFocus, onChoose, onAdd, error, onGenerate, onCancel }) {
  const { colors } = useTheme()
  const { outfits, canAdd, busy } = wardrobe
  const ready = !!chosen && hasMain && !busy

  return (
    <View style={styles.view}>
      <Text style={[styles.sub, { color: colors.textSecondary }]}>
        {`Dress ${who} in a saved outfit. The face and pose stay as they are.`}
      </Text>

      <View style={styles.pair}>
        <View style={styles.pairItem}>
          <MediaImage
            uri={influencer.mainImage}
            previewUri={influencer.mainThumb ?? null}
            style={[styles.pairImage, { backgroundColor: colors.surfaceAlt }]}
            contentFit="cover"
          />
          <Text style={[styles.pairLabel, { color: colors.textSecondary }]}>Main image</Text>
        </View>
        <Icon name="chevron" size={22} color={colors.textTertiary} />
        <View style={styles.pairItem}>
          <MediaImage
            uri={chosen?.image ?? null}
            previewUri={chosen ? thumbUrlFor(chosen.asset_id) : null}
            style={[styles.pairImage, { backgroundColor: colors.surfaceAlt }]}
            contentFit="cover"
          />
          <Text style={[styles.pairLabel, { color: colors.textSecondary }]} numberOfLines={1}>
            {chosen?.name ?? 'Outfit'}
          </Text>
        </View>
      </View>

      {!hasMain ? (
        <Text style={[styles.warn, { color: colors.danger }]}>Add a main image first. The outfit is put on it.</Text>
      ) : null}

      <Text style={[styles.label, font('medium'), { color: colors.textPrimary }]}>Outfit</Text>
      {outfits.length === 0 ? (
        <Text style={[styles.sub, { color: colors.textSecondary }]}>Add a photo of an outfit to begin.</Text>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pickRow} keyboardShouldPersistTaps="handled">
        {outfits.map(outfit => {
          const on = chosen?.id === outfit.id
          return (
            <Pressable
              key={outfit.id}
              onPress={() => onChoose(outfit.id)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${outfit.name}${on ? ', chosen' : ''}`}
              style={styles.pick}
            >
              <MediaImage
                uri={outfit.image}
                previewUri={thumbUrlFor(outfit.asset_id)}
                style={[styles.pickImage, { backgroundColor: colors.surfaceAlt, borderColor: on ? colors.primary : 'transparent' }]}
                contentFit="cover"
              />
              <Text style={[styles.pickName, font(on ? 'semibold' : 'regular'), { color: on ? colors.primary : colors.textSecondary }]} numberOfLines={1}>
                {outfit.name}
              </Text>
            </Pressable>
          )
        })}
        {canAdd ? (
          <Pressable
            onPress={onAdd}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Add a photo of an outfit"
            style={styles.pick}
          >
            <View style={[styles.pickImage, styles.pickAdd, { borderColor: colors.border }]}>
              {busy ? <ActivityIndicator color={colors.primary} /> : <Icon name="plus" size={22} color={colors.primary} />}
            </View>
            <Text style={[styles.pickName, font('semibold'), { color: colors.primary }]}>{busy ? 'Adding…' : 'Add photo'}</Text>
          </Pressable>
        ) : null}
      </ScrollView>

      <Text style={[styles.label, font('medium'), { color: colors.textPrimary }]}>Note (optional)</Text>
      <PillInput
        value={note}
        onChangeText={onNote}
        placeholder="e.g. sleeves rolled up"
        maxLength={INPUT_LIMITS.outfitNote}
        returnKeyType="done"
        onFocus={onNoteFocus}
        accessibilityLabel="Note about the outfit"
      />

      <CostNote model={IMAGE_MODEL_ID} />

      {error ? <Text style={[styles.error, { color: colors.danger }]}>{error}</Text> : null}

      <View style={styles.actions}>
        <Button title="Generate" onPress={onGenerate} disabled={!ready} />
        <Button title="Cancel" variant="neutral" onPress={onCancel} />
      </View>
    </View>
  )
}

function WorkingView({ progress, pending, onHide }) {
  const { colors } = useTheme()
  return (
    <View style={styles.view}>
      <View style={[styles.progressBox, { borderColor: colors.border }]}>
        <ActivityIndicator size="small" color={colors.primary} />
        <Text style={[styles.progressText, { color: colors.textSecondary }]}>
          {pending
            ? 'Still generating. The image will appear here when it is ready.'
            : progress > 0 ? `Generating… ${Math.round(progress)}%` : 'Generating…'}
        </Text>
      </View>
      <Text style={[styles.sub, { color: colors.textTertiary }]}>
        You can close this. The picture is saved to the Gallery when it is ready.
      </Text>
      <Button title="Close" variant="neutral" onPress={onHide} />
    </View>
  )
}

function ResultView({ result, storing, usingAsMain, onOpen, onUseAsMain, onShare, onAnother, onDone }) {
  const { colors } = useTheme()
  const saved = !!result?.assetId && !storing
  return (
    <View style={styles.view}>
      <Pressable onPress={onOpen} accessibilityRole="imagebutton" accessibilityLabel="New picture, open full screen">
        <MediaImage
          uri={result?.url ?? null}
          previewUri={result?.thumbUrl ?? null}
          style={[styles.result, { backgroundColor: colors.surfaceAlt }]}
          contentFit="contain"
          loadingIndicator
        />
      </Pressable>

      {storing || !result?.assetId ? (
        <View style={styles.savingRow}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={[styles.progressText, { color: colors.textSecondary }]}>Saving the new image…</Text>
        </View>
      ) : (
        <Text style={[styles.sub, { color: colors.textSecondary }]}>
          {`Saved to the Gallery as “${outfitLabel(result.name)}”.`}
        </Text>
      )}

      <View style={styles.actions}>
        <Button title="Use as main image" onPress={onUseAsMain} disabled={!saved} loading={usingAsMain} />
        <Button title="Share" variant="secondary" onPress={onShare} disabled={!result?.url} />
        <Button title="Try another" variant="soft" onPress={onAnother} />
        <Button title="Done" variant="neutral" onPress={onDone} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(8,3,83,0.45)' },
  backdrop: { ...StyleSheet.absoluteFillObject },
  sheet: {
    maxHeight: '94%',
    borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl,
    paddingTop: space.xl,
  },
  content: { paddingHorizontal: layout.pageGutter, gap: space.md },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 20, letterSpacing: -0.3 },

  view: { gap: space.md },
  sub: { fontSize: 13.5, lineHeight: 19 },
  label: { fontSize: 15, marginTop: space.xs },
  warn: { fontSize: 13.5, lineHeight: 19 },
  error: { fontSize: 13.5, lineHeight: 19 },

  pair: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.md },
  pairItem: { width: '29%', gap: space.xs },
  pairImage: { width: '100%', aspectRatio: 3 / 4, borderRadius: radius.md },
  pairLabel: { fontSize: 12.5, textAlign: 'center' },

  pickRow: { gap: space.md, paddingVertical: space.xs },
  pick: { width: 76, gap: 4 },
  pickImage: { width: 76, height: 100, borderRadius: radius.sm, borderWidth: 2 },
  pickAdd: { alignItems: 'center', justifyContent: 'center', borderWidth: 1.2, borderStyle: 'dashed' },
  pickName: { fontSize: 12, textAlign: 'center' },

  progressBox: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    paddingVertical: space.md, paddingHorizontal: space.md,
    borderRadius: radius.md, borderWidth: 1.2, borderStyle: 'dashed',
  },
  progressText: { fontSize: 13, flex: 1 },
  savingRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },

  result: { width: '70%', alignSelf: 'center', aspectRatio: 3 / 4, borderRadius: radius.md },
  actions: { gap: space.sm, marginTop: space.xs },
})
