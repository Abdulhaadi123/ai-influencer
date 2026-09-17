/**
 * Motion Copy — the native counterpart of components/MotionCopyStudio.jsx.
 *
 * A character image plus a driving video: the influencer performs that exact
 * motion while keeping their identity (Kling 3.0 Motion Control). The
 * generation call itself is the shared one from core, so both platforms send
 * identical requests.
 *
 * Native departures from the web studio: the drag-and-drop zone becomes the
 * system video picker, <video> becomes expo-video's VideoView, and the download
 * button becomes the share sheet (via the shared media module).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  View, Text, TextInput, ScrollView, Image, Pressable,
  ActivityIndicator, StyleSheet, Alert,
} from 'react-native'

import { useBottomInset } from '../hooks/useBottomInset'
import { useVideoPlayer, VideoView } from 'expo-video'

import { generateMotionCopy, STILL_RUNNING } from '@core/services/generation'
import { uploadLocal, resolveUrl } from '@core/data/assets'
import { MOTION_MODELS, DEFAULT_MOTION_MODEL, getMotionModel } from '@core/config/videoModels'
import { userMessage } from '@core/errors'
import { persistGenerated } from '@core/platform/persistMedia'
import { useInfluencers } from '@core/store'

import { useTheme, space, radius } from '../theme'
import { Section, Button, Segmented, Collapsible, Field } from '../components/ui'
import { pickImageWithPrompt, pickVideo } from '../lib/picker'
import ModelPicker from '../components/ModelPicker'
import { shareMedia } from '../lib/share'

export default function MotionCopyScreen({ influencer }) {
  const { colors } = useTheme()
  const bottomInset = useBottomInset()
  const { addGeneration } = useInfluencers()

  // Same character sources the web studio offers.
  const characterOptions = useMemo(() => [
    influencer?.mainImage && { key: 'main', label: 'Main image', url: influencer.mainImage },
    influencer?.characterSheetImage && { key: 'sheet', label: 'Character sheet', url: influencer.characterSheetImage },
    influencer?.closeUpImage1 && { key: 'close', label: 'Close-up', url: influencer.closeUpImage1 },
  ].filter(Boolean), [influencer])

  const [characterImage, setCharacterImage] = useState(() => characterOptions[0]?.url || null)
  // The uploaded driving video: a local URI for the preview, and the signed URL
  // KIE will fetch it from.
  const [drivingVideo, setDrivingVideo] = useState(null)     // { previewUri, fetchUrl }
  const [videoName, setVideoName] = useState('')
  const [uploadingVideo, setUploadingVideo] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState('pro') // 'std' = 720p, 'pro' = 1080p
  const [model, setModel] = useState(DEFAULT_MOTION_MODEL)

  const [generating, setGenerating] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  // Polling stopped watching, but the job is alive in the queue.
  const [handedOff, setHandedOff] = useState(false)

  const cancelRef = useRef(false)
  useEffect(() => () => { cancelRef.current = true }, [])

  const chooseCharacter = useCallback(async () => {
    const uri = await pickImageWithPrompt()
    if (!uri) return
    setError(null)
    try {
      // KIE fetches the character itself, so it needs a URL. Uploading first
      // also means the picked photo is stored under this user rather than
      // living only in memory for the length of one screen.
      const { assetId } = await uploadLocal({
        uri, kind: 'image', contentType: 'image/jpeg', influencerId: influencer?.id ?? null,
      })
      setCharacterImage(await resolveUrl(assetId))
    } catch (e) {
      setError(userMessage(e, 'The image could not be uploaded. Please try again.'))
    }
  }, [influencer?.id])

  const chooseVideo = useCallback(async () => {
    setError(null)
    let picked
    try {
      picked = await pickVideo()
    } catch (e) {
      // The size guard throws with a message written for the user.
      setError(userMessage(e, 'This video could not be opened. Please choose a different one.'))
      return
    }
    if (!picked) return

    setVideoName(picked.name)
    setUploadingVideo(true)
    try {
      const { assetId } = await uploadLocal({
        uri: picked.uri,
        kind: 'video',
        contentType: picked.contentType,
        byteSize: picked.size,
        influencerId: influencer?.id ?? null,
      })
      setDrivingVideo({ previewUri: picked.uri, fetchUrl: await resolveUrl(assetId) })
    } catch (e) {
      setVideoName('')
      setError(userMessage(e, 'The video could not be uploaded. Please try again.'))
    } finally {
      setUploadingVideo(false)
    }
  }, [influencer?.id])

  const canGenerate = !!characterImage && !!drivingVideo?.fetchUrl && !generating && !uploadingVideo

  const generate = useCallback(async () => {
    if (!canGenerate) return
    cancelRef.current = false
    setGenerating(true); setProgress(0); setError(null); setResult(null); setHandedOff(false)

    try {
      const { urls } = await generateMotionCopy({
        characterImage,
        // A signed URL, not base64 — KIE pulls the file itself.
        drivingVideo: drivingVideo.fetchUrl,
        prompt,
        mode,
        model,
        onProgress: setProgress,
        isCancelled: () => cancelRef.current,
        queueMeta: { influencerId: influencer?.id, influencerName: influencer?.name, label: 'Motion copy' },
      })

      const url = urls?.[0]
      if (cancelRef.current) return
      if (!url) { setError('No video was returned. Please try again.'); return }

      // KIE deletes results within a day, so the server copies the file into
      // this user's storage before the entry is recorded.
      const { assetId, url: storedUrl } = await persistGenerated({
        sourceUrl: url, kind: 'video', influencerId: influencer?.id ?? null,
      })
      if (cancelRef.current) return

      setResult(storedUrl)

      if (influencer?.id) {
        await addGeneration({
          influencerId: influencer.id, assetId, kind: 'video', label: 'Motion copy',
        })
      }
    } catch (e) {
      if (e?.message === STILL_RUNNING) setHandedOff(true)
      else if (e?.message !== 'CANCELLED') setError(userMessage(e, 'Unable to generate the motion copy. Please try again.'))
    } finally {
      if (!cancelRef.current) { setGenerating(false); setProgress(0) }
    }
  }, [canGenerate, characterImage, drivingVideo, prompt, mode, model, influencer, addGeneration])

  const cancel = useCallback(() => {
    cancelRef.current = true
    setGenerating(false)
    setProgress(0)
  }, [])

  return (
    <ScrollView
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={[styles.sub, { color: colors.textSecondary }]}>
        Upload a motion video and {influencer?.name || 'your influencer'} will perform the same
        movements, gestures and expressions.
      </Text>

      <Section title="Character">
        <View style={styles.padded}>
          {characterImage ? (
            <View style={{ gap: space.md }}>
              <View style={styles.characterRow}>
                <Image source={{ uri: characterImage }} style={styles.characterThumb} resizeMode="cover" />
                <View style={styles.flex}>
                  {characterOptions.length > 1 ? (
                    <View style={styles.chipRow}>
                      {characterOptions.map(opt => {
                        const on = characterImage === opt.url
                        return (
                          <Pressable
                            key={opt.key}
                            onPress={() => setCharacterImage(opt.url)}
                            style={[styles.chip, {
                              borderColor: on ? colors.brand : colors.border,
                              backgroundColor: on ? colors.brandSoft : 'transparent',
                            }]}
                          >
                            <Text style={[styles.chipText, { color: on ? colors.brand : colors.textSecondary }]}>
                              {opt.label}
                            </Text>
                          </Pressable>
                        )
                      })}
                    </View>
                  ) : null}
                  <Button title="Upload image" variant="secondary" onPress={chooseCharacter} />
                </View>
              </View>
            </View>
          ) : (
            <Button title="Upload character image" onPress={chooseCharacter} />
          )}
        </View>
      </Section>

      <Section title="Motion video" footer="MP4, MOV or WebM, up to 60 MB. Clips of 3–30 seconds with one clearly visible person work best.">
        <View style={styles.padded}>
          {drivingVideo ? (
            <View style={{ gap: space.md }}>
              <VideoPreview uri={drivingVideo.previewUri} />
              <Text style={[styles.fileName, { color: colors.textSecondary }]} numberOfLines={1}>
                {videoName}
              </Text>
              <View style={styles.choiceRow}>
                <View style={styles.flex}>
                  <Button title="Replace" variant="secondary" onPress={chooseVideo} />
                </View>
                <View style={styles.flex}>
                  <Button title="Remove" variant="danger"
                    onPress={() => { setDrivingVideo(null); setVideoName('') }} />
                </View>
              </View>
            </View>
          ) : (
            <Button
              title={uploadingVideo ? 'Uploading…' : 'Upload motion video'}
              onPress={chooseVideo}
              disabled={uploadingVideo}
            />
          )}
        </View>
      </Section>

      <Section title="Model" footer="Kling 3.0 is recommended. Select another model to compare results.">
        <View style={styles.padded}>
          <ModelPicker
            models={MOTION_MODELS}
            value={model}
            defaultId={DEFAULT_MOTION_MODEL}
            onChange={setModel}
          />
        </View>
      </Section>

      <Collapsible
        title="Options"
        subtitle={`${getMotionModel(model).label}${prompt ? ' · Scene set' : ''}`}
      >
        <Field label="Scene direction" hint="Optional">
          <TextInput
            value={prompt}
            onChangeText={setPrompt}
            placeholder="e.g. Bright studio background, soft lighting"
            placeholderTextColor={colors.textTertiary}
            style={[styles.input, { color: colors.textPrimary, borderColor: colors.border, backgroundColor: colors.bg }]}
          />
        </Field>

        <Field label="Quality" hint="The output matches the aspect ratio of the motion video.">
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { label: 'Standard · 720p', value: 'std' },
              { label: 'Pro · 1080p', value: 'pro' },
            ]}
          />
        </Field>
      </Collapsible>

      {error ? (
        <View style={[styles.errorBox, { borderColor: colors.danger, backgroundColor: colors.brandSoft }]}>
          <Text style={[styles.errorText, { color: colors.danger }]}>{error}</Text>
        </View>
      ) : null}

      {handedOff ? (
        <View style={[styles.errorBox, { borderColor: colors.brand, backgroundColor: colors.brandSoft }]}>
          <Text style={[styles.errorText, { color: colors.textPrimary }]}>
            Generation is taking longer than usual. Motion copies take the longest
            to generate. You can save the video from the Queue tab when it is ready.
          </Text>
        </View>
      ) : null}

      {generating ? (
        <Section title="Working">
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
            <Button title="Cancel" variant="secondary" onPress={cancel} />
          </View>
        </Section>
      ) : (
        <Button title="Generate motion copy" onPress={generate} disabled={!canGenerate} />
      )}

      {result && !generating ? (
        <Section title="Result">
          <View style={[styles.padded, { gap: space.md }]}>
            <VideoPreview uri={result} autoPlay loop />
            <Button
              title="Share"
              variant="secondary"
              onPress={() => shareMedia(result, `${(influencer?.name || 'motion').toLowerCase()}-motion.mp4`)}
            />
          </View>
        </Section>
      ) : null}
    </ScrollView>
  )
}

/** expo-video replaces the web's <video> element. */
function VideoPreview({ uri, autoPlay = false, loop = false }) {
  const player = useVideoPlayer(uri, p => {
    p.loop = loop
    if (autoPlay) p.play()
  })
  return <VideoView style={styles.video} player={player} allowsFullscreen nativeControls contentFit="contain" />
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingTop: space.xl },
  padded: { padding: space.lg },
  flex: { flex: 1 },
  sub: { fontSize: 14, lineHeight: 20, marginBottom: space.xl },

  characterRow: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
  characterThumb: { width: 84, height: 112, borderRadius: radius.md },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.md },
  chip: { paddingVertical: 5, paddingHorizontal: 11, borderRadius: radius.sm, borderWidth: 1.5 },
  chipText: { fontSize: 12, fontWeight: '600' },

  video: { width: '100%', aspectRatio: 9 / 16, borderRadius: radius.md, backgroundColor: '#000' },
  fileName: { fontSize: 12.5 },
  choiceRow: { flexDirection: 'row', gap: space.md },

  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: space.md, paddingVertical: space.md, fontSize: 15 },

  errorBox: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, padding: space.md, marginBottom: space.xl },
  errorText: { fontSize: 13, lineHeight: 18 },

  progressRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  progressText: { fontSize: 13, fontWeight: '600' },
  track: { height: 6, borderRadius: 999, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 999 },
})
