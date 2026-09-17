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
  View, Text, TextInput, ScrollView, Image, Pressable,
  ActivityIndicator, StyleSheet, Alert,
} from 'react-native'

import { useBottomInset } from '../hooks/useBottomInset'
import { useVideoPlayer, VideoView } from 'expo-video'

import { generateVideo, STILL_RUNNING } from '@core/services/generation'
import { uploadLocal, resolveUrl, remove as removeAsset } from '@core/data/assets'
import { buildVideoPrompt, VOICE_PRESETS } from '@core/prompts/videoPrompt'
import { loadStudioSettings, saveStudioSettings, DEFAULT_STUDIO_SETTINGS } from '@core/data/settings'
import { ENV_PRESETS, ENV_KEYS, VIBES, CAMERAS, TIMES_OF_DAY, DURATIONS } from '@core/studioOptions'
import { VIDEO_MODELS, DEFAULT_VIDEO_MODEL, getVideoModel } from '@core/config/videoModels'
import { selectVideoReferences, describeDroppedReferences } from '@core/videoRefs'
import { hasActiveJobs } from '@core/data/jobs'
import { userMessage } from '@core/errors'
import { persistGenerated } from '@core/platform/persistMedia'
import { useInfluencers } from '@core/store'

import { useTheme, space, radius } from '../theme'
import { Section, Button, Segmented, Collapsible, Field } from '../components/ui'
import { pickImageWithPrompt } from '../lib/picker'
import PromptSuggestion from '../components/PromptSuggestion'
import { usePromptSuggestion } from '../hooks/usePromptSuggestion'
import ModelPicker from '../components/ModelPicker'
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
  // Set when polling ran longer than we watch for; the job lives on in the queue.
  const [handedOff, setHandedOff] = useState(false)

  const cancelRef = useRef(false)
  useEffect(() => () => { cancelRef.current = true }, [])

  useEffect(() => {
    let cancelled = false
    loadStudioSettings(influencer.id).then(loaded => {
      if (cancelled) return
      setSettings(loaded)
      setSettingsFor(influencer.id)
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
      setProducts(p => [...p, { assetId, url }])
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
    (settings.dialogue || '').trim().length > 0 || products.length > 0 || !!influencer.mainImage
  )

  // What will ACTUALLY be sent, given the chosen model's image limit. Computed
  // here so the warning below and the request itself come from one calculation
  // and cannot drift apart.
  const chosenModel = getVideoModel(settings.videoModel || DEFAULT_VIDEO_MODEL)
  const selection = useMemo(
    () => selectVideoReferences(influencer, products.map(p => p.url), chosenModel.maxImages),
    [influencer, products, chosenModel.maxImages],
  )
  const dropWarning = describeDroppedReferences(selection, chosenModel.label)

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
        duration: settings.duration,
        model: settings.videoModel || DEFAULT_VIDEO_MODEL,
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

      // KIE deletes results within a day or so, so the server copies each into
      // this user's storage. The same request marks the queue row collected, so
      // it does not sit in the Queue tab asking to be saved a second time.
      const stored = []
      for (const url of urls) {
        const { assetId, url: storedUrl } = await persistGenerated({
          sourceUrl: url, kind: 'video', influencerId: influencer.id,
        })
        stored.push({ assetId, url: storedUrl })
      }

      if (cancelRef.current) return
      setResults(stored.map(s => s.url))

      for (const { assetId } of stored) {
        await addGeneration({
          influencerId: influencer.id, assetId, kind: 'video', label: 'Video',
        })
      }
    } catch (e) {
      // A slow job is not a failed one. The task is still alive on KIE and the
      // queue is holding its taskId, so say that instead of showing an error.
      if (e?.message === STILL_RUNNING) setHandedOff(true)
      else if (e?.message !== 'CANCELLED') setError(userMessage(e, 'Unable to generate the video. Please try again.'))
    } finally {
      if (!cancelRef.current) { setGenerating(false); setProgress(0) }
    }
  }, [canGenerate, influencer, settings, products, selection, addGeneration])

  const voicePresets = influencer.gender === 'Male' ? VOICE_PRESETS.male : VOICE_PRESETS.female

  // Live rewrite of the script, offered as a suggestion only.
  const assist = usePromptSuggestion(settings.dialogue, 'script')

  return (
    <ScrollView
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]}
      keyboardShouldPersistTaps="handled"
    >
      <Section title="Script" footer={`What ${influencer.name} says in the video. Leave blank for a video without speech.`}>
        <View style={styles.padded}>
          <TextInput
            value={settings.dialogue || ''}
            onChangeText={v => set('dialogue', v)}
            placeholder={'e.g. I have been using this for a month and honestly…'}
            placeholderTextColor={colors.textTertiary}
            multiline
            style={[styles.input, { color: colors.textPrimary, borderColor: colors.border, backgroundColor: colors.bg }]}
          />
          <PromptSuggestion
            suggestion={assist.suggestion}
            loading={assist.loading}
            onUse={() => set('dialogue', assist.suggestion)}
            onDismiss={assist.dismiss}
          />
        </View>
      </Section>

      <Section title={`Products · ${products.length}/${MAX_PRODUCTS}`} footer={`Optional. Products for ${influencer.name} to present in the video.`}>
        <View style={styles.padded}>
          {products.length ? (
            <View style={styles.productRow}>
              {products.map((product, i) => (
                <View key={product.assetId}>
                  <Image source={{ uri: product.url }} style={styles.product} resizeMode="cover" />
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
                variant="secondary"
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
            <View style={[styles.noticeBox, {
              borderColor: selection.productsDropped > 0 ? colors.danger : colors.border,
              backgroundColor: selection.productsDropped > 0 ? 'transparent' : colors.surfaceAlt,
            }]}>
              <Text style={[styles.noticeText, {
                color: selection.productsDropped > 0 ? colors.danger : colors.textSecondary,
              }]}>
                {dropWarning}
              </Text>
            </View>
          ) : null}
        </View>
      </Section>

      <Section title="Model" footer="Kling 3.0 is recommended. Select another model to compare results.">
        <View style={styles.padded}>
          <ModelPicker
            models={VIDEO_MODELS}
            value={settings.videoModel || DEFAULT_VIDEO_MODEL}
            defaultId={DEFAULT_VIDEO_MODEL}
            onChange={v => set('videoModel', v)}
          />
        </View>
      </Section>

      <Collapsible
        title="Style and delivery"
        subtitle={`${settings.camera} · ${settings.duration}s · ${settings.vibe || 'Default mood'}${settings.envKey ? ' · ' + settings.envKey : ''}`}
      >
        <Field label="Camera">
          <View style={styles.chipWrap}>
            {CAMERAS.map(c => (
              <Chip key={c} label={c} active={settings.camera === c} onPress={() => set('camera', c)} />
            ))}
          </View>
        </Field>

        <Field label="Length">
          <Segmented
            value={settings.duration}
            onChange={v => set('duration', v)}
            options={DURATIONS.map(d => ({ label: `${d}s`, value: d }))}
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
          hint={getVideoModel(settings.videoModel).supportsSound
            ? 'Sets how the script sounds. Videos with a script or a selected voice include audio.'
            : `${getVideoModel(settings.videoModel).label} does not support audio. Videos will be silent.`}
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

      {error ? (
        <View style={[styles.errorBox, { borderColor: colors.danger }]}>
          <Text style={[styles.errorText, { color: colors.danger }]}>{error}</Text>
        </View>
      ) : null}

      {handedOff ? (
        <View style={[styles.errorBox, { borderColor: colors.brand, backgroundColor: colors.brandSoft }]}>
          <Text style={[styles.errorText, { color: colors.textPrimary }]}>
            Generation is taking longer than usual. You can save the video from
            the Queue tab when it is ready.
          </Text>
        </View>
      ) : null}

      {generating ? (
        <Section title="Generating">
          <View style={[styles.padded, { gap: space.md }]}>
            <View style={styles.progressRow}>
              <ActivityIndicator size="small" color={colors.brand} />
              <Text style={[styles.progressText, { color: colors.textSecondary }]}>
                {progress > 0 ? `${Math.round(progress)}%` : 'Starting…'}
              </Text>
            </View>
            <View style={[styles.track, { backgroundColor: colors.surfaceAlt }]}>
              <View style={[styles.fill, { width: `${Math.max(3, progress)}%`, backgroundColor: colors.brand }]} />
            </View>
            <Button title="Cancel" variant="secondary"
              onPress={() => { cancelRef.current = true; setGenerating(false); setProgress(0) }} />
          </View>
        </Section>
      ) : (
        <Button title="Generate video" onPress={generate} disabled={!canGenerate} />
      )}

      {results.length && !generating ? (
        <Section title="Result">
          <View style={[styles.padded, { gap: space.md }]}>
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

function Chip({ label, active, onPress }) {
  const { colors } = useTheme()
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={[styles.chip, {
        borderColor: active ? colors.brand : colors.border,
        backgroundColor: active ? colors.brandSoft : 'transparent',
      }]}
    >
      <Text style={[styles.chipText, { color: active ? colors.brand : colors.textSecondary }]}>{label}</Text>
    </Pressable>
  )
}

function ResultVideo({ uri }) {
  const player = useVideoPlayer(uri, p => { p.loop = true })
  return <VideoView style={styles.video} player={player} allowsFullscreen nativeControls contentFit="contain" />
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingTop: space.lg },
  padded: { padding: space.lg },

  input: {
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 10,
    paddingHorizontal: space.md, paddingVertical: space.md,
    fontSize: 15, minHeight: 110, textAlignVertical: 'top',
  },

  productRow: { flexDirection: 'row', gap: space.md, flexWrap: 'wrap' },
  product: { width: 76, height: 76, borderRadius: radius.md },
  remove: {
    position: 'absolute', top: -6, right: -6,
    width: 22, height: 22, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
  },
  removeText: { color: '#FFFFFF', fontSize: 15, lineHeight: 17, fontWeight: '700' },

  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: { paddingVertical: 7, paddingHorizontal: 13, borderRadius: radius.sm, borderWidth: 1.5 },
  chipText: { fontSize: 13, fontWeight: '600' },

  errorBox: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, padding: space.md, marginBottom: space.xl },
  errorText: { fontSize: 13, lineHeight: 18 },

  noticeBox: { borderWidth: 1, borderRadius: radius.md, padding: space.md, marginTop: space.md },
  noticeText: { fontSize: 12.5, lineHeight: 18 },

  progressRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  progressText: { fontSize: 13, fontWeight: '600' },
  track: { height: 6, borderRadius: 999, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 999 },

  video: { width: '100%', aspectRatio: 9 / 16, borderRadius: radius.md, backgroundColor: '#000', maxHeight: 420 },
})
