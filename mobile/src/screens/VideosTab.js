/**
 * Videos — the native counterpart of the web Content Studio.
 *
 * Script + product images + camera settings -> a promo video where the
 * influencer presents the product, with voice. The prompt is built by the
 * SHARED buildVideoPrompt and sent through the SHARED generateVideo, so both
 * platforms issue identical requests.
 *
 * Settings persist per influencer through core/data/settings (the
 * studio_settings table), in the same shape the web studio uses.
 *
 * Scope note: this covers the generate flow. The web studio additionally has a
 * history browser with a lightbox and per-slot regeneration; results here are
 * appended to the influencer's generationHistory, which the web history reads.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  View, Text, ScrollView, Pressable,
  ActivityIndicator, StyleSheet,
} from 'react-native'

import { useBottomInset } from '../hooks/useBottomInset'
import { useVideoPlayer, VideoView } from 'expo-video'

import { generateVideo, STILL_RUNNING } from '@core/services/generation'
import { uploadLocal, resolveUrl, remove as removeAsset } from '@core/data/assets'
import { buildVideoPrompt, VOICE_PRESETS } from '@core/prompts/videoPrompt'
import { loadStudioSettings, saveStudioSettings, DEFAULT_STUDIO_SETTINGS } from '@core/data/settings'
import { ENV_PRESETS, ENV_KEYS, VIBES, CAMERAS, TIMES_OF_DAY, DURATIONS } from '@core/studioOptions'
import {
  VIDEO_MODELS, DEFAULT_VIDEO_MODEL, getVideoModel, durationFor, offeredDurations,
} from '@core/config/videoModels'
import { selectVideoReferences, describeDroppedReferences } from '@core/videoRefs'
import { hasActiveJobs } from '@core/data/jobs'
import { modelsOnSale } from '@core/billing/packs'
import { userMessage } from '@core/errors'
import { isOutOfCredits } from '@core/billing/outOfCredits'
import { persistGenerated } from '@core/platform/persistMedia'
import { useInfluencers } from '@core/store'
import { INPUT_LIMITS } from '@core/config/inputLimits'

import { useTheme, space, radius, font, layout } from '../theme'
import CostNote from '../components/CostNote'
import {
  Section, Button, Segmented, Collapsible, Field, Chip, PillInput, Block, Notice, ProgressBar,
} from '../components/ui'
import { pickImageWithPrompt } from '../lib/picker'
import PromptSuggestion from '../components/PromptSuggestion'
import { usePromptSuggestion } from '../hooks/usePromptSuggestion'
import { useCredits } from '../hooks/useCredits'
import ModelPicker from '../components/ModelPicker'
import MediaImage from '../components/MediaImage'
import { shareMedia } from '../lib/share'
import { showError } from '../lib/alerts'

const MAX_PRODUCTS = 3

/** Studio settings are saved once edits pause for this long. */
const SETTINGS_SAVE_DELAY_MS = 800

export default function VideosTab({ influencer }) {
  const { colors } = useTheme()
  const bottomInset = useBottomInset()
  const { addGeneration } = useInfluencers()

  // Defaults first, stored values when they arrive. A network read cannot
  // happen in a useState initialiser, and blocking the whole studio behind a
  // remembered dropdown would be the wrong trade.
  const [settings, setSettings] = useState(DEFAULT_STUDIO_SETTINGS)
  // Which influencer `settings` were loaded for. A boolean "loaded" stayed true
  // for one render after switching influencer, long enough to save the previous
  // influencer's settings under the new one's id.
  const [settingsFor, setSettingsFor] = useState(null)
  /** [{ assetId, url }] — uploaded, so KIE can fetch them. */
  const [products, setProducts] = useState([])
  const [uploadingProduct, setUploadingProduct] = useState(false)

  const [generating, setGenerating] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState(null)
  const [results, setResults] = useState([])
  /** The result is playing and its copy into the gallery is still running. */
  const [storing, setStoring] = useState(false)
  // Set when polling ran longer than we watch for; the job lives on in the queue.
  const [handedOff, setHandedOff] = useState(false)

  const cancelRef = useRef(false)
  useEffect(() => () => { cancelRef.current = true }, [])

  /** Set once the prompt assistants exist; see below. */
  const ignoreRestored = useRef(null)

  useEffect(() => {
    let cancelled = false
    loadStudioSettings(influencer.id).then(loaded => {
      if (cancelled) return
      setSettings(loaded)
      setSettingsFor(influencer.id)
      // Restored text is not something the user just wrote. Without this,
      // opening the tab on an influencer with a saved script or scene fired a
      // suggestion request for each of them.
      ignoreRestored.current?.(loaded)
    })
    return () => { cancelled = true }
  }, [influencer.id])

  // Persist once edits pause — and only once this influencer's stored values
  // have arrived, or the defaults would be written over them.
  //
  // Not on every change: the script box is part of the settings, so that was a
  // database write per keystroke.
  const pendingSave = useRef(null)
  useEffect(() => {
    if (settingsFor !== influencer.id) return
    pendingSave.current = { id: influencer.id, settings }
    const timer = setTimeout(() => {
      pendingSave.current = null
      saveStudioSettings(influencer.id, settings)
    }, SETTINGS_SAVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [influencer.id, settings, settingsFor])

  // Leaving the screen mid-edit still saves the last change.
  useEffect(() => () => {
    const pending = pendingSave.current
    if (pending) saveStudioSettings(pending.id, pending.settings)
  }, [])

  const set = useCallback((key, value) => setSettings(s => ({ ...s, [key]: value })), [])

  const addProduct = useCallback(async () => {
    if (products.length >= MAX_PRODUCTS || uploadingProduct) return
    const uri = await pickImageWithPrompt()
    if (!uri) return

    setUploadingProduct(true)
    try {
      const { assetId } = await uploadLocal({
        uri, kind: 'image', contentType: 'image/jpeg', influencerId: influencer.id,
      })
      const url = await resolveUrl(assetId)
      // `url` is what KIE is sent; the square shows the photo already on the phone (`local`) rather
      // than downloading the same megabytes back from storage.
      setProducts(p => [...p, { assetId, url, local: uri }])
    } catch (e) {
      showError('Upload failed', e, 'The product image could not be uploaded. Please try again.')
    } finally {
      setUploadingProduct(false)
    }
  }, [products.length, uploadingProduct, influencer.id])

  /**
   * Remove a product, and its uploaded photo with it: product photos belong to
   * this studio session only, so a removed one was left in storage counting
   * against the quota. The photo is kept while any of this influencer's jobs
   * is running — the generator downloads references when a job starts, which
   * can be well after it was queued — and goes with the influencer instead.
   */
  const removeProduct = useCallback(product => {
    if (generating) return
    setProducts(p => p.filter(x => x.assetId !== product.assetId))
    hasActiveJobs(influencer.id)
      .then(active => (active ? null : removeAsset(product.assetId)))
      .catch(e => console.warn('[videos] could not delete a removed product photo:', e?.message ?? e))
  }, [generating, influencer.id])

  const canGenerate = !generating && (
    (settings.dialogue || '').trim().length > 0 ||
    (settings.scene || '').trim().length > 0 ||
    products.length > 0 || !!influencer.mainImage
  )

  // What will ACTUALLY be sent, given the chosen model's image limit. Computed
  // here so the warning below and the request itself come from one calculation
  // and cannot drift apart.
  //
  // Only models the server will accept are offered: with charging on, an unpriced model is
  // refused ("This model is not available right now"), and a model remembered from before it
  // was taken off the list falls back to the first one that is offered.
  const { prices, enforced } = useCredits()
  const videoModels = useMemo(() => modelsOnSale(VIDEO_MODELS, prices, enforced), [prices, enforced])
  const wanted = settings.videoModel || DEFAULT_VIDEO_MODEL
  const modelId = videoModels.some(m => m.id === wanted) ? wanted : videoModels[0].id
  const chosenModel = getVideoModel(modelId)
  const selection = useMemo(
    () => selectVideoReferences(influencer, products.map(p => p.url), chosenModel.maxImages),
    [influencer, products, chosenModel.maxImages],
  )
  const dropWarning = describeDroppedReferences(selection, chosenModel.label)

  // The lengths this model can actually produce, and the one it will produce for
  // what is selected now. Both the request and the prompt are built from this,
  // so a clip can no longer be generated at one length and described at another.
  const durationOptions = useMemo(() => offeredDurations(chosenModel.id, DURATIONS), [chosenModel.id])
  const duration = durationFor(chosenModel.id, settings.duration)

  /**
   * Copy finished clips into the gallery while they play. Never throws: the clip was made (and
   * paid for) whatever happens here, so a failure is said as what it is, not as a failed generation.
   */
  const storeResults = useCallback(async urls => {
    setStoring(true)
    try {
      for (const url of urls) {
        let assetId
        try {
          // KIE deletes results within a day or so, so the server copies each into this user's
          // storage. The same request marks the queue row collected, so it does not sit in the
          // Queue tab asking to be saved a second time.
          ({ assetId } = await persistGenerated({ sourceUrl: url, kind: 'video', influencerId: influencer.id }))
        } catch (e) {
          if (e?.code === 'CONTENT_BLOCKED') {
            // Removed by the content check after it finished: it does not stay on screen either.
            setResults(r => r.filter(u => u !== url))
            setError(userMessage(e, 'This video was removed because it goes against our content guidelines.'))
          } else {
            setError(userMessage(e, 'The video could not be saved to the gallery. You can save it from the Queue tab.'))
          }
          continue
        }
        try {
          await addGeneration({ influencerId: influencer.id, assetId, kind: 'video', label: 'Video' })
        } catch (e) {
          setError(userMessage(e, 'The video was saved but could not be added to the gallery. Please try again.'))
        }
      }
    } finally {
      setStoring(false)
    }
  }, [influencer.id, addGeneration])

  const generate = useCallback(async () => {
    if (!canGenerate) return
    cancelRef.current = false
    setGenerating(true); setProgress(0); setError(null); setResults([]); setHandedOff(false)

    try {
      // Ranked, not just listed: the model takes one or two images and there
      // are usually more than that available, so the product photo has to
      // outrank the identity sheets or it is the thing that gets dropped.
      const referenceImages = selection.images

      // Describe ONLY the products the model will actually receive. Telling it
      // to present a product whose image was trimmed away is what made the
      // original bug invisible — the model just invented an object and the
      // clip looked plausible.
      const sentProducts = products.slice(0, selection.productsIncluded).map(p => p.url)

      const prompt = buildVideoPrompt(influencer, {
        ...settings,
        // The length the model will really produce, not the one picked: the shot
        // plan and every action beat are timed against this.
        duration,
        productRef1: sentProducts[0] || null,
        productRef2: sentProducts[1] || null,
        productRef3: sentProducts[2] || null,
        environment: ENV_PRESETS[settings.envKey] || settings.envCustom || '',
        // Tags follow what is actually sent, in the order it is sent.
        sentRoles: selection.roles,
      })

      const { urls } = await generateVideo({
        prompt,
        aspectRatio: settings.aspect,
        duration,
        model: modelId,
        count: 1,
        referenceImages,
        referenceRoles: selection.roles,
        // A script means speech. Tying audio to the voice chips alone (tucked in a
        // collapsed section) produced silent clips for scripts that were paid for.
        hasVoice: !!((settings.dialogue || '').trim() || settings.voicePreset || (settings.voiceCustom || '').trim()),
        onProgress: setProgress,
        onPartialResults: partial => { if (!cancelRef.current) setResults([...partial]) },
        isCancelled: () => cancelRef.current,
        queueMeta: { influencerId: influencer.id, influencerName: influencer.name, label: 'Video' },
      })

      if (cancelRef.current) return
      if (!urls?.length) { setError('No video was returned. Please try again.'); return }

      // Playing at once, from the generator's own link. The copy into the gallery (the server
      // downloads the clip, checks it and stores it) used to come first, and for a video that
      // was a long second wait in front of a finished result. The link stays on screen only —
      // it is never saved — and keeping it means the clip is not downloaded a second time.
      setResults(urls)
      setGenerating(false)
      await storeResults(urls)
    } catch (e) {
      // A slow job is not a failed one. The task is still alive on KIE and the
      // queue is holding its taskId, so say that instead of showing an error.
      if (e?.message === STILL_RUNNING) setHandedOff(true)
      else if (e?.message !== 'CANCELLED' && !isOutOfCredits(e)) setError(userMessage(e, 'Unable to generate the video. Please try again.'))
    } finally {
      if (!cancelRef.current) { setGenerating(false); setProgress(0) }
    }
  }, [canGenerate, influencer, settings, duration, products, selection, storeResults, modelId])

  const voicePresets = influencer.gender === 'Male' ? VOICE_PRESETS.male : VOICE_PRESETS.female

  // Live rewrites, offered as suggestions only — never written back on their own.
  const assist = usePromptSuggestion(settings.dialogue, 'script')
  const sceneAssist = usePromptSuggestion(settings.scene, 'scene')

  // Filled here because the settings load above runs earlier in source order
  // than these assistants exist. Effects run in commit order, so this is set
  // long before the load's promise resolves.
  useEffect(() => {
    ignoreRestored.current = loaded => {
      assist.ignore(loaded?.dialogue)
      sceneAssist.ignore(loaded?.scene)
    }
  }, [assist.ignore, sceneAssist.ignore])

  return (
    <ScrollView
      contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <Block title="Script" footer={`What ${influencer.name} says in the video. Leave blank for a video without speech.`}>
        <PillInput
          value={settings.dialogue || ''}
          onChangeText={v => set('dialogue', v)}
          placeholder={'e.g. I have been using this for a month and honestly…'}
          multiline
          maxLength={INPUT_LIMITS.script}
        />
        <PromptSuggestion
          suggestion={assist.suggestion}
          notice={assist.notice}
          loading={assist.loading}
          onUse={() => { const next = assist.suggestion; set('dialogue', next); assist.ignore(next) }}
          onDismiss={assist.dismiss}
        />
      </Block>

      <Block
        title="Scene"
        footer={`Where the video happens and what ${influencer.name} does — separate from the script, which is what gets said. Times work: "at 5s, turns to camera".`}
      >
        <PillInput
          value={settings.scene || ''}
          onChangeText={v => set('scene', v)}
          placeholder={'e.g. Walking down a wet city street at night, neon signs behind. Holds the bottle up at 3s.'}
          multiline
          maxLength={INPUT_LIMITS.scene}
        />
        <PromptSuggestion
          suggestion={sceneAssist.suggestion}
          notice={sceneAssist.notice}
          loading={sceneAssist.loading}
          onUse={() => { const next = sceneAssist.suggestion; set('scene', next); sceneAssist.ignore(next) }}
          onDismiss={sceneAssist.dismiss}
        />
      </Block>

      <Section title={`Products · ${products.length}/${MAX_PRODUCTS}`} footer={`Optional. Products for ${influencer.name} to present in the video.`}>
        <View style={styles.padded}>
          {products.length ? (
            <View style={styles.productRow}>
              {products.map((product, i) => (
                <View key={product.assetId}>
                  <MediaImage uri={product.local || product.url} style={styles.product} contentFit="cover" />
                  <Pressable
                    onPress={() => removeProduct(product)}
                    disabled={generating}
                    style={[styles.remove, { backgroundColor: colors.danger, opacity: generating ? 0.4 : 1 }]}
                  >
                    <Text style={styles.removeText}>×</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          ) : null}
          {products.length < MAX_PRODUCTS ? (
            <View style={{ marginTop: products.length ? space.md : 0 }}>
              <Button
                title={uploadingProduct ? 'Uploading…' : 'Add product image'}
                onPress={addProduct}
                disabled={uploadingProduct}
              />
            </View>
          ) : null}
          {products.length ? (
            <View style={{ marginTop: space.md }}>
              <Segmented
                value={settings.productWorn ? 'worn' : 'held'}
                onChange={v => set('productWorn', v === 'worn')}
                options={[{ label: 'Held', value: 'held' }, { label: 'Worn', value: 'worn' }]}
              />
            </View>
          ) : null}

          {/* What will not fit. Shown before generating, because finding out
              afterwards means having already paid for the wrong clip. */}
          {dropWarning ? (
            <Notice tone={selection.productsDropped > 0 ? 'error' : 'warn'} style={styles.noticeInCard}>
              {dropWarning}
            </Notice>
          ) : null}
        </View>
      </Section>

      <Section title="Model" footer={videoModels.length > 1 ? 'Kling 3.0 is recommended. Select another model to compare results.' : undefined}>
        <View style={styles.padded}>
          <ModelPicker
            models={videoModels}
            value={modelId}
            defaultId={DEFAULT_VIDEO_MODEL}
            onChange={v => set('videoModel', v)}
          />
        </View>
      </Section>

      <Collapsible
        title="Style and delivery"
        subtitle={`${settings.camera} · ${duration}s · ${settings.vibe || 'Default mood'}${settings.envKey ? ' · ' + settings.envKey : ''}`}
      >
        <Field label="Camera">
          <View style={styles.chipWrap}>
            {CAMERAS.map(c => (
              <Chip key={c} label={c} active={settings.camera === c} onPress={() => set('camera', c)} />
            ))}
          </View>
        </Field>

        <Field
          label="Length"
          hint={durationOptions.length < DURATIONS.length
            ? `${chosenModel.label} only produces ${durationOptions.map(d => `${d}s`).join(', ')}.`
            : undefined}
        >
          <Segmented
            value={duration}
            onChange={v => set('duration', v)}
            options={durationOptions.map(d => ({ label: `${d}s`, value: d }))}
          />
        </Field>

        <Field label="Shots" hint="A single shot is one continuous take.">
          <Segmented
            value={settings.shotMode}
            onChange={v => set('shotMode', v)}
            options={[{ label: 'Single shot', value: 'oner' }, { label: 'Multi-shot', value: 'multi' }]}
          />
        </Field>

        <Field label="Location" hint="Sets the setting and color grading of the video.">
          <View style={styles.chipWrap}>
            <Chip label="Any" active={!settings.envKey} onPress={() => set('envKey', '')} />
            {ENV_KEYS.map(k => (
              <Chip key={k} label={k} active={settings.envKey === k} onPress={() => set('envKey', k)} />
            ))}
          </View>
        </Field>

        <Field label="Time of day">
          <View style={styles.chipWrap}>
            {TIMES_OF_DAY.map(t => (
              <Chip
                key={t}
                label={t.charAt(0).toUpperCase() + t.slice(1)}
                active={settings.videoTimeOfDay === t}
                onPress={() => set('videoTimeOfDay', t)}
              />
            ))}
          </View>
        </Field>

        <Field label="Mood" hint="Sets the tone of the delivery.">
          <View style={styles.chipWrap}>
            <Chip label="Default" active={!settings.vibe} onPress={() => set('vibe', '')} />
            {VIBES.map(v => (
              <Chip key={v} label={v} active={settings.vibe === v} onPress={() => set('vibe', v)} />
            ))}
          </View>
        </Field>

        <Field
          label="Voice"
          hint={chosenModel.supportsSound
            ? 'Sets how the script sounds. Videos with a script or a selected voice include audio.'
            : `${chosenModel.label} does not support audio. Videos will be silent.`}
        >
          <View style={styles.chipWrap}>
            <Chip label="None" active={!settings.voicePreset} onPress={() => set('voicePreset', '')} />
            {(voicePresets || []).map(v => (
              <Chip
                key={v.id}
                label={v.label}
                active={settings.voicePreset === v.id}
                onPress={() => set('voicePreset', v.id)}
              />
            ))}
          </View>
        </Field>
      </Collapsible>

      {error ? <Notice tone="error">{error}</Notice> : null}

      {handedOff ? (
        <Notice>
          Generation is taking longer than usual. You can save the video from
          the Queue tab when it is ready.
        </Notice>
      ) : null}

      {generating ? (
        <Section title="Generating">
          <View style={[styles.padded, { gap: space.md }]}>
            <View style={styles.progressRow}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={[styles.progressText, font('medium'), { color: colors.textSecondary }]}>
                {progress > 0 ? `${Math.round(progress)}%` : 'Starting…'}
              </Text>
            </View>
            <ProgressBar value={progress} />
            <Button title="Cancel" size="sm" variant="secondary"
              onPress={() => { cancelRef.current = true; setGenerating(false); setProgress(0) }} />
          </View>
        </Section>
      ) : (
        <>
          <CostNote model={chosenModel.id} seconds={duration} />
          <Button title="Generate video" onPress={generate} disabled={!canGenerate} />
        </>
      )}

      {results.length && !generating ? (
        <Section title="Result">
          <View style={[styles.padded, { gap: space.md }]}>
            {storing ? (
              <View style={styles.progressRow}>
                <ActivityIndicator size="small" color={colors.primary} />
                <Text style={[styles.progressText, { color: colors.textSecondary }]}>Saving to the gallery…</Text>
              </View>
            ) : null}
            {results.map(url => (
              <View key={url} style={{ gap: space.sm }}>
                <ResultVideo uri={url} />
                <Button
                  title="Share"
                  variant="secondary"
                  onPress={() => shareMedia(url, `${(influencer.name || 'video').toLowerCase()}.mp4`)}
                />
              </View>
            ))}
          </View>
        </Section>
      ) : null}
    </ScrollView>
  )
}

function ResultVideo({ uri }) {
  const player = useVideoPlayer(uri, p => { p.loop = true })
  return <VideoView style={styles.video} player={player} allowsFullscreen nativeControls contentFit="contain" />
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: layout.pageGutter, paddingTop: space.sm },
  padded: { padding: space.md + 2 },

  productRow: { flexDirection: 'row', gap: space.md, flexWrap: 'wrap' },
  product: { width: 76, height: 76, borderRadius: radius.md },
  remove: {
    position: 'absolute', top: -6, right: -6,
    width: 22, height: 22, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
  },
  removeText: { color: '#FFFFFF', fontSize: 15, lineHeight: 17, fontWeight: '700' },

  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },

  noticeInCard: { marginTop: space.md, marginBottom: 0 },

  progressRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  progressText: { fontSize: 13 },

  video: { width: '100%', height: 420, borderRadius: radius.md, backgroundColor: '#000' },
})
