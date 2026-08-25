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
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useVideoPlayer, VideoView } from 'expo-video'

import { generateMotionCopy } from '@core/services/generation'
import { downloadImage } from '@core/platform/media'
import { useInfluencers, generateId } from '@core/store'

import { useTheme, space, radius } from '../theme'
import { Section, Button, Segmented } from '../components/ui'
import { pickImageWithPrompt, pickVideo } from '../lib/picker'

export default function MotionCopyScreen({ influencer }) {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const [, setInfluencers] = useInfluencers()

  // Same character sources the web studio offers.
  const characterOptions = useMemo(() => [
    influencer?.mainImage && { key: 'main', label: 'Main image', url: influencer.mainImage },
    influencer?.characterSheetImage && { key: 'sheet', label: 'Character sheet', url: influencer.characterSheetImage },
    influencer?.closeUpImage1 && { key: 'close', label: 'Close-up', url: influencer.closeUpImage1 },
  ].filter(Boolean), [influencer])

  const [characterImage, setCharacterImage] = useState(() => characterOptions[0]?.url || null)
  const [drivingVideo, setDrivingVideo] = useState(null) // data URL
  const [videoName, setVideoName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState('pro') // 'std' = 720p, 'pro' = 1080p

  const [generating, setGenerating] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  const cancelRef = useRef(false)
  useEffect(() => () => { cancelRef.current = true }, [])

  const chooseCharacter = useCallback(async () => {
    const uri = await pickImageWithPrompt()
    if (uri) setCharacterImage(uri)
  }, [])

  const chooseVideo = useCallback(async () => {
    try {
      setError(null)
      const picked = await pickVideo()
      if (!picked) return
      setDrivingVideo(picked.dataUrl)
      setVideoName(picked.name)
    } catch (e) {
      // The size guard throws with a message written for the user.
      setError(e?.message ?? 'Could not load that video.')
    }
  }, [])

  const canGenerate = !!characterImage && !!drivingVideo && !generating

  const generate = useCallback(async () => {
    if (!canGenerate) return
    cancelRef.current = false
    setGenerating(true); setProgress(0); setError(null); setResult(null)

    try {
      const { urls } = await generateMotionCopy({
        characterImage,
        drivingVideo,
        prompt,
        mode,
        onProgress: setProgress,
        isCancelled: () => cancelRef.current,
        pendingKey: influencer?.id,
      })

      const url = urls?.[0]
      if (cancelRef.current) return
      if (!url) { setError('No video was returned — please try again.'); return }

      setResult(url)

      // Record it on the influencer, same as the web studio does.
      if (influencer?.id) {
        setInfluencers(prev => prev.map(inf => inf.id === influencer.id ? {
          ...inf,
          generationHistory: [
            { id: generateId(), type: 'video', label: 'Motion Copy', url, date: Date.now() },
            ...(inf.generationHistory || []),
          ],
        } : inf))
      }
    } catch (e) {
      if (e?.message !== 'CANCELLED') setError(e?.message ?? String(e))
    } finally {
      if (!cancelRef.current) { setGenerating(false); setProgress(0) }
    }
  }, [canGenerate, characterImage, drivingVideo, prompt, mode, influencer, setInfluencers])

  const cancel = useCallback(() => {
    cancelRef.current = true
    setGenerating(false)
    setProgress(0)
  }, [])

  return (
    <ScrollView
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xxl }]}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={[styles.sub, { color: colors.textSecondary }]}>
        Add a motion video and {influencer?.name || 'your influencer'} performs the same movement,
        gestures and expression — identity kept intact.
      </Text>

      <Section title="Character — who moves">
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
                              borderColor: on ? colors.accent : colors.border,
                              backgroundColor: on ? colors.accentSoft : 'transparent',
                            }]}
                          >
                            <Text style={[styles.chipText, { color: on ? colors.accent : colors.textSecondary }]}>
                              {opt.label}
                            </Text>
                          </Pressable>
                        )
                      })}
                    </View>
                  ) : null}
                  <Button title="Use another image" variant="secondary" onPress={chooseCharacter} />
                </View>
              </View>
            </View>
          ) : (
            <Button title="Add a character image" onPress={chooseCharacter} />
          )}
        </View>
      </Section>

      <Section title="Motion video — what to copy" footer="mp4, mov or webm. One clear subject, 3–30s works best. Max 60 MB.">
        <View style={styles.padded}>
          {drivingVideo ? (
            <View style={{ gap: space.md }}>
              <VideoPreview uri={drivingVideo} />
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
            <Button title="Choose a motion video" onPress={chooseVideo} />
          )}
        </View>
      </Section>

      <Section title="Scene direction" footer="Optional.">
        <View style={styles.padded}>
          <TextInput
            value={prompt}
            onChangeText={setPrompt}
            placeholder="e.g. bright studio background, soft lighting"
            placeholderTextColor={colors.textTertiary}
            style={[styles.input, { color: colors.textPrimary, borderColor: colors.border, backgroundColor: colors.bg }]}
          />
        </View>
      </Section>

      <Section title="Quality" footer="The output follows the motion video's shape.">
        <View style={styles.padded}>
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { label: 'Standard · 720p', value: 'std' },
              { label: 'Pro · 1080p', value: 'pro' },
            ]}
          />
        </View>
      </Section>

      {error ? (
        <View style={[styles.errorBox, { borderColor: colors.danger, backgroundColor: colors.accentSoft }]}>
          <Text style={[styles.errorText, { color: colors.danger }]}>{error}</Text>
        </View>
      ) : null}

      {generating ? (
        <Section title="Working">
          <View style={[styles.padded, { gap: space.md }]}>
            <View style={styles.progressRow}>
              <ActivityIndicator size="small" color={colors.accent} />
              <Text style={[styles.progressText, { color: colors.textSecondary }]}>
                {progress > 0 ? `${Math.round(progress)}%` : 'Starting…'}
              </Text>
            </View>
            <View style={[styles.track, { backgroundColor: colors.surfaceAlt }]}>
              <View style={[styles.fill, { width: `${Math.max(3, progress)}%`, backgroundColor: colors.accent }]} />
            </View>
            <Button title="Cancel" variant="secondary" onPress={cancel} />
          </View>
        </Section>
      ) : (
        <Button title="Copy motion" onPress={generate} disabled={!canGenerate} />
      )}

      {result && !generating ? (
        <Section title="Result">
          <View style={[styles.padded, { gap: space.md }]}>
            <VideoPreview uri={result} autoPlay loop />
            <Button
              title="Save or share"
              variant="secondary"
              onPress={() => downloadImage(result, `${(influencer?.name || 'motion').toLowerCase()}-motion.mp4`)}
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
