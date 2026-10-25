/**
 * Create — the native influencer wizard.
 *
 * Mirrors the web wizard's three steps (Basics / Reference / Generate) and
 * shares ALL of its logic with the web app: buildImagePrompts, COPY_ATTRIBUTES,
 * buildNewInfluencer and buildCreationParams all come from core, so the two
 * wizards cannot drift apart.
 *
 * The layout is native rather than a transliteration: one step per screen with
 * numbered step badges at the top, and the step's buttons under its fields (the
 * floating tab bar owns the bottom edge, so there is no fixed action bar).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  View, Text, ScrollView, Pressable, ActivityIndicator,
  StyleSheet, KeyboardAvoidingView, Platform,
} from 'react-native'

import { useInfluencers } from '@core/store'
import { generateThreeImages, STILL_RUNNING } from '@core/services/generation'
import { IMAGE_MODEL_ID } from '@core/config/generation'
import { uploadLocal, resolveUrl, remove as removeAsset } from '@core/data/assets'
import { COPY_ATTRIBUTES, buildImagePrompts } from '@core/prompts/influencerPrompts'
import { buildNewInfluencer, buildCreationParams } from '@core/newInfluencer'
import { INPUT_LIMITS, MAX_INFLUENCERS, MIN_AGE, MAX_AGE, cleanAge, ageProblem } from '@core/config/inputLimits'
import { persistGenerated } from '@core/platform/persistMedia'
import { userMessage } from '@core/errors'
import { isOutOfCredits } from '@core/billing/outOfCredits'

import { useBottomInset } from '../hooks/useBottomInset'
import { useTheme, space, radius, font, layout } from '../theme'
import CostNote from '../components/CostNote'
import Screen, { ScreenHeader } from '../components/Screen'
import { Button, GlassCard, Block, PillInput, ChoicePill, Notice, ProgressBar } from '../components/ui'
import Icon from '../components/icons'
import MediaImage from '../components/MediaImage'
import ImageViewer from '../components/ImageViewer'
import { pickImageWithPrompt } from '../lib/picker'
import { showError } from '../lib/alerts'
import PromptSuggestion from '../components/PromptSuggestion'
import { usePromptSuggestion } from '../hooks/usePromptSuggestion'
import { usePendingResult } from '../hooks/usePendingResult'

const STEPS = ['Basics', 'Reference', 'Generate']
const ASPECT_RATIO = '9:16'

function initialData() {
  return {
    name: '', gender: 'Female', age: '',
    description: '',
    // The picked file, for showing a thumbnail immediately…
    referenceImage: null,
    // …and the uploaded asset, which is what the generator and the record use.
    referenceAssetId: null,
    copyAttributes: [], copyNote: '',
  }
}

/**
 * Best-effort delete of a file the wizard no longer points at — a replaced
 * reference, or a variation that was regenerated away. Those used to stay in
 * storage with no influencer attached: never swept, and counted against quota.
 */
function discardAsset(assetId) {
  if (!assetId) return
  removeAsset(assetId).catch(e => console.warn('[create] could not delete an unused file:', e?.message ?? e))
}

export default function CreateScreen({ navigation }) {
  const bottomInset = useBottomInset()
  const roster = useInfluencers()
  const { addInfluencer } = roster
  // At the limit the server refuses the save — after the image had been generated and paid for. Say so
  // before anything is spent, and do not let the wizard go on.
  const atLimit = (roster[0]?.length ?? 0) >= MAX_INFLUENCERS

  const [step, setStep] = useState(0)
  const [data, setData] = useState(initialData)

  const [generating, setGenerating] = useState(false)
  const [progress, setProgress] = useState(0)
  /** [{ assetId, url }] — the asset is the durable reference, the url is for display. */
  const [variations, setVariations] = useState([])
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [error, setError] = useState(null)
  const [uploadingRef, setUploadingRef] = useState(false)
  const [saving, setSaving] = useState(false)
  /** The generated image is on screen and its copy into storage is still running. */
  const [storing, setStoring] = useState(false)
  /** A generation that outlived the foreground poll, watched until it lands. */
  const [pendingTaskId, setPendingTaskId] = useState(null)

  const promptsRef = useRef([])
  const attemptRef = useRef(0)
  const cancelledRef = useRef(false)
  // Mirrors of state, for callbacks that must keep a stable identity.
  const variationsRef = useRef([])
  const dataRef = useRef(data)
  useEffect(() => { dataRef.current = data }, [data])

  const set = useCallback((key, value) => setData(d => ({ ...d, [key]: value })), [])

  const canContinue = useMemo(() => {
    if (atLimit) return false
    if (step === 0) return data.name.trim().length > 0 && !ageProblem(data.age)
    // Step 2 needs SOMETHING to generate from — a description or a reference.
    if (step === 1) {
      if (uploadingRef) return false
      return !!data.referenceAssetId || data.description.trim().length > 0
    }
    return true
  }, [step, data, uploadingRef, atLimit])

  /**
   * Put `next` on screen as the image. The wizard shows a single variation, so
   * the one it replaces can never be chosen again — its file is deleted.
   */
  const showVariation = useCallback(next => {
    const replaced = variationsRef.current.filter(v => v.assetId && v.assetId !== next.assetId)
    variationsRef.current = [next]
    setVariations([next])
    setSelectedIdx(0)
    replaced.forEach(v => discardAsset(v.assetId))
  }, [])

  const addReference = useCallback(async () => {
    const uri = await pickImageWithPrompt()
    if (!uri) return

    const previous = { image: dataRef.current.referenceImage, assetId: dataRef.current.referenceAssetId }

    // Show it immediately, upload in the background — waiting on S3 before the
    // thumbnail appears makes the picker feel broken.
    set('referenceImage', uri)
    setUploadingRef(true)
    try {
      const { assetId } = await uploadLocal({ uri, kind: 'image', contentType: 'image/jpeg' })
      set('referenceAssetId', assetId)
      if (previous.assetId && previous.assetId !== assetId) discardAsset(previous.assetId)
    } catch (e) {
      // Put the previous reference back, so the thumbnail keeps matching what
      // will actually be sent.
      set('referenceImage', previous.image)
      showError('Upload failed', e, 'The image could not be uploaded. Please try again.')
    } finally {
      setUploadingRef(false)
    }
  }, [set])

  const removeReference = useCallback(() => {
    discardAsset(dataRef.current.referenceAssetId)
    setData(d => ({ ...d, referenceImage: null, referenceAssetId: null }))
  }, [])

  const toggleAttribute = useCallback(id => {
    setData(d => ({
      ...d,
      copyAttributes: d.copyAttributes.includes(id)
        ? d.copyAttributes.filter(a => a !== id)
        : [...d.copyAttributes, id],
    }))
  }, [])

  const generate = useCallback(async () => {
    setGenerating(true)
    setError(null)
    setProgress(0)
    setPendingTaskId(null)
    cancelledRef.current = false
    let taskId = null

    try {
      // One image per run. buildImagePrompts returns three pose variations;
      // a different one is picked each time so pressing Regenerate gives a
      // genuinely different look rather than repeating the same pose.
      const prompts = buildImagePrompts(data)
      const prompt = prompts[attemptRef.current % prompts.length]
      attemptRef.current += 1
      promptsRef.current = [prompt]

      // KIE fetches the reference itself, so it needs a URL rather than the
      // local file. The uploaded asset resolves to a presigned GET, which the
      // generation layer re-signs with a lifetime that outlasts KIE's queue.
      const faceRef = data.referenceAssetId
        ? await resolveUrl(data.referenceAssetId)
        : null

      const urls = await generateThreeImages({
        prompts: [prompt],
        aspectRatio: ASPECT_RATIO,
        faceRef,
        physicalDesc: data.description || '',
        onProgress: p => setProgress(Math.round(p)),
        onJobIds: ids => { taskId = ids?.[0] ?? null },
        // No influencer exists yet, so the queue row is labelled by the name
        // being typed. If it runs long, this screen keeps watching it.
        queueMeta: { influencerName: data.name || 'New influencer', label: 'Influencer image' },
      })

      if (cancelledRef.current) return
      if (!urls?.[0]) { setError('No image was returned. Please try again.'); return }

      // On screen at once, from the generator's own link. The copy into this user's storage (the
      // server downloads the file, checks it and stores it) used to come first, and the picture
      // only appeared after it — as long a wait again. Now the copy runs while the picture shows,
      // and only Save waits for it, because the influencer is saved with the stored file. The
      // link is never saved anywhere: it is what is on screen, for as long as this screen is.
      const generated = urls[0]
      const before = variationsRef.current
      variationsRef.current = [{ assetId: null, url: generated }]
      setVariations(variationsRef.current)
      setSelectedIdx(0)
      setGenerating(false)
      setStoring(true)
      try {
        // KIE deletes results within a day, so the server copies the file into this user's
        // storage — and marks the queue row collected in the same request.
        const { assetId } = await persistGenerated({ sourceUrl: generated, kind: 'image' })
        if (cancelledRef.current) return
        // The link already loaded stays on screen, so the picture is not fetched a second time.
        variationsRef.current = [{ assetId, url: generated }]
        setVariations(variationsRef.current)
        // The image this one replaces can never be chosen again; it goes now that this one is safe.
        before.forEach(v => discardAsset(v.assetId))
      } catch (e) {
        // Not stored (refused by the content check, or the copy failed): it cannot become the
        // influencer, so the previous image comes back and the reason is shown below.
        variationsRef.current = before
        setVariations(before)
        throw e
      } finally {
        setStoring(false)
      }
    } catch (e) {
      if (e?.message === STILL_RUNNING && taskId) {
        // Not a failure — the job is alive, and it is watched below so the image
        // still lands here. Before, it could only be saved from the Queue tab,
        // where it could not become this influencer's image, and people paid
        // for a second generation instead.
        setPendingTaskId(taskId)
      } else if (e?.message === STILL_RUNNING) {
        setError('Generation is taking longer than usual. You can save the image from the Queue tab when it is ready.')
      } else if (e?.message !== 'CANCELLED' && !isOutOfCredits(e)) setError(userMessage(e, 'Unable to generate the image. Please try again.'))
    } finally {
      setGenerating(false)
    }
  }, [data, showVariation])

  // Wait on a generation that outlived the foreground poll, so the image still
  // lands here rather than only in the Queue.
  usePendingResult(pendingTaskId, {
    kind: 'image',
    onReady: ({ assetId, url }) => {
      setPendingTaskId(null)
      setError(null)
      showVariation({ assetId, url })
    },
    onFailed: message => {
      setPendingTaskId(null)
      setError(message)
    },
  })

  /** An empty wizard again. Deletes nothing — whatever was saved stays saved. */
  const reset = useCallback(() => {
    variationsRef.current = []
    promptsRef.current = []
    attemptRef.current = 0
    setData(initialData())
    setVariations([])
    setSelectedIdx(0)
    setError(null)
    setProgress(0)
    setPendingTaskId(null)
    setStep(0)
  }, [])

  const save = useCallback(async () => {
    // No asset yet means the image is still being copied into storage (Save is disabled meanwhile).
    if (!variations.length || saving || !variations[selectedIdx]?.assetId) return
    setSaving(true)
    try {
      const chosen = variations[selectedIdx]

      // One save on the server: the influencer, the two files stored before it
      // existed (linked so deleting the influencer deletes them), and what it
      // was generated from (so Regenerate makes the same person). All of it or
      // none of it.
      await addInfluencer(
        buildNewInfluencer({
          data,
          mainAssetId: chosen.assetId,
          referenceAssetId: data.referenceAssetId || null,
          prompt: promptsRef.current[0] || '',
        }),
        {
          linkAssetIds: [chosen.assetId, data.referenceAssetId],
          creationParams: buildCreationParams({
            data,
            aspectRatio: ASPECT_RATIO,
            referenceAssetId: data.referenceAssetId || null,
          }),
        },
      )

      // A clean wizard for the next influencer. Left as it was, the tab reopened
      // on this one's last step, and "Save influencer" created a duplicate.
      reset()
      navigation.navigate('Influencers')
    } catch (e) {
      showError('Unable to save', e, 'The influencer could not be saved. Please try again.')
    } finally {
      setSaving(false)
    }
  }, [data, variations, selectedIdx, addInfluencer, navigation, saving, reset])

  return (
    <Screen>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={{ paddingBottom: bottomInset }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <ScreenHeader title="Create" size={22} />

          <View style={styles.body}>
            <StepBar step={step} />

            {atLimit ? (
              <Notice tone="error">
                {`You have ${MAX_INFLUENCERS} influencers, the most one account can hold. Delete one to create another.`}
              </Notice>
            ) : null}

            {step === 0 && <BasicsStep data={data} set={set} />}
            {step === 1 && (
              <ReferenceStep
                data={data}
                set={set}
                onAddReference={addReference}
                onRemoveReference={removeReference}
                onToggleAttribute={toggleAttribute}
                uploading={uploadingRef}
              />
            )}
            {step === 2 && (
              <GenerateStep
                generating={generating}
                progress={progress}
                variations={variations}
                selectedIdx={selectedIdx}
                onSelect={setSelectedIdx}
                onGenerate={generate}
                error={error}
                pending={!!pendingTaskId}
                storing={storing}
              />
            )}

            <Actions
              step={step}
              canContinue={canContinue}
              generating={generating || storing}
              hasResults={variations.length > 0}
              saving={saving}
              onBack={() => setStep(s => Math.max(0, s - 1))}
              onNext={() => setStep(s => Math.min(STEPS.length - 1, s + 1))}
              onSave={save}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  )
}

/* ── Steps ─────────────────────────────────────────────────────────────── */

function Heading({ title, sub }) {
  const { colors } = useTheme()
  return (
    <View style={styles.headingWrap}>
      <Text style={[styles.heading, font('regular'), { color: colors.textPrimary }]}>{title}</Text>
      <Text style={[styles.sub, { color: colors.textSecondary }]}>{sub}</Text>
    </View>
  )
}

function BasicsStep({ data, set }) {
  const { colors } = useTheme()
  // Said once the age is complete or the field is left — not while the first digit is still being typed.
  const [ageLeft, setAgeLeft] = useState(false)
  const problem = ageProblem(data.age)
  const shownAgeProblem = problem && (ageLeft || data.age.length >= INPUT_LIMITS.age) ? problem : null
  return (
    <>
      <Heading title="Basic details" sub="Enter a name and select a gender." />

      <Block title="Name">
        <PillInput
          value={data.name}
          onChangeText={v => set('name', v)}
          placeholder="Enter name"
          autoFocus
          maxLength={INPUT_LIMITS.name}
          autoCapitalize="words"
          autoCorrect={false}
          autoComplete="off"
          returnKeyType="done"
        />
      </Block>

      <Block title="Gender">
        <View style={styles.choiceRow}>
          {['Male', 'Female'].map(g => (
            <ChoicePill key={g} label={g} active={data.gender === g} onPress={() => set('gender', g)} />
          ))}
        </View>
      </Block>

      <Block title="Age" footer={`Optional. ${MIN_AGE} to ${MAX_AGE}.`}>
        <PillInput
          value={data.age}
          onChangeText={v => set('age', cleanAge(v))}
          onBlur={() => setAgeLeft(true)}
          placeholder="Enter age"
          keyboardType="number-pad"
          maxLength={INPUT_LIMITS.age}
          autoComplete="off"
          returnKeyType="done"
          error={!!shownAgeProblem}
        />
        {shownAgeProblem ? <Text style={[styles.fieldError, { color: colors.danger }]}>{shownAgeProblem}</Text> : null}
      </Block>
    </>
  )
}

function ReferenceStep({ data, set, onAddReference, onRemoveReference, onToggleAttribute, uploading }) {
  const { colors } = useTheme()
  const assist = usePromptSuggestion(data.description, 'appearance')
  return (
    <>
      <Heading title="Appearance" sub="Describe your influencer, add a reference image, or both." />

      <Block
        title="Description"
        footer="Used to generate the image. Optional if you add a reference image."
      >
        <PillInput
          value={data.description}
          onChangeText={v => set('description', v)}
          placeholder="e.g. Mid-20s, long dark curly hair, warm smile"
          multiline
          maxLength={INPUT_LIMITS.appearance}
        />
        <PromptSuggestion
          suggestion={assist.suggestion}
          notice={assist.notice}
          loading={assist.loading}
          onUse={() => { const next = assist.suggestion; set('description', next); assist.ignore(next) }}
          onDismiss={assist.dismiss}
        />
      </Block>

      <Block title="Reference image" footer="Match the face, outfit or setting from a photo.">
        <GlassCard>
          <View style={styles.cardPad}>
            {data.referenceImage ? (
              <View style={{ gap: space.md }}>
                <MediaImage uri={data.referenceImage} style={styles.reference} contentFit="cover" />
                {uploading ? (
                  <View style={styles.uploadingRow}>
                    <ActivityIndicator size="small" color={colors.primary} />
                    <Text style={[styles.uploadingText, { color: colors.textSecondary }]}>Uploading…</Text>
                  </View>
                ) : null}
                <View style={styles.choiceRow}>
                  <View style={styles.flex}>
                    <Button title="Replace" size="sm" variant="soft" onPress={onAddReference} />
                  </View>
                  <View style={styles.flex}>
                    <Button title="Remove" size="sm" variant="danger" onPress={onRemoveReference} />
                  </View>
                </View>
              </View>
            ) : (
              <Button title="Upload reference image" onPress={onAddReference} />
            )}
          </View>
        </GlassCard>
      </Block>

      {/* "What to copy" only matters when there IS a reference to copy from. */}
      {data.referenceImage ? (
        <Block
          title="Features to match"
          footer="Select the features to take from the reference image. If none are selected, the full appearance is used."
        >
          <View style={{ gap: space.sm }}>
            {COPY_ATTRIBUTES.map(attr => {
              const on = data.copyAttributes.includes(attr.id)
              return (
                <Pressable
                  key={attr.id}
                  onPress={() => onToggleAttribute(attr.id)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  style={[
                    styles.attr,
                    {
                      borderColor: on ? colors.primary : colors.glassEdge,
                      backgroundColor: on ? colors.accentSoft : colors.glass,
                    },
                  ]}
                >
                  <View style={[styles.checkbox, { borderColor: on ? colors.primary : colors.border, backgroundColor: on ? colors.primary : 'transparent' }]}>
                    {on ? <Icon name="check" size={14} color="#FFFFFF" /> : null}
                  </View>
                  <View style={styles.flex}>
                    <Text style={[styles.attrLabel, font('medium'), { color: colors.textPrimary }]}>{attr.label}</Text>
                    <Text style={[styles.attrDesc, { color: colors.textSecondary }]}>{attr.desc}</Text>
                  </View>
                </Pressable>
              )
            })}
          </View>
        </Block>
      ) : null}
    </>
  )
}

function GenerateStep({ generating, progress, variations, selectedIdx, onSelect, onGenerate, error, pending, storing }) {
  const { colors } = useTheme()
  const [viewing, setViewing] = useState(null)

  if (generating) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={[styles.heading, font('regular'), { color: colors.textPrimary }]}>Generating…</Text>
        <Text style={[styles.sub, { color: colors.textSecondary }]}>{progress}%</Text>
        <View style={styles.progress}>
          <ProgressBar value={progress} />
        </View>
      </View>
    )
  }

  // Hides the Generate button on purpose: pressing it here would start, and
  // pay for, a second image while the first is still coming.
  if (pending && !variations.length) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={[styles.heading, font('regular'), { color: colors.textPrimary }]}>Still generating</Text>
        <Text style={[styles.sub, { color: colors.textSecondary, textAlign: 'center' }]}>
          This is taking longer than usual. The image will appear here when it is ready,
          and you can leave this screen in the meantime.
        </Text>
      </View>
    )
  }

  if (!variations.length) {
    return (
      <View style={styles.centered}>
        <Text style={[styles.heading, font('regular'), { color: colors.textPrimary }]}>Ready to generate</Text>
        <Text style={[styles.sub, { color: colors.textSecondary, textAlign: 'center' }]}>
          One image will be generated. You can regenerate it if you want a different result.
        </Text>
        {error ? <View style={styles.stretch}><Notice tone="error">{error}</Notice></View> : null}
        <CostNote model={IMAGE_MODEL_ID} />
        <View style={styles.stretch}>
          <Button title="Generate image" onPress={onGenerate} />
        </View>
      </View>
    )
  }

  return (
    <>
      <Heading title="Preview" sub="This will be the main image. Regenerate it if you want a different result." />

      <GlassCard>
        <View style={styles.cardPad}>
          {variations.map((variation, i) => (
            <Pressable
              // The url, not the asset: the picture is on screen before it has an asset, and
              // keeping the same key when the asset arrives keeps the loaded picture.
              key={variation.url}
              onPress={() => { onSelect(i); setViewing(variation.url) }}
              accessibilityRole="imagebutton"
              accessibilityLabel="Generated image, open full screen"
              style={[
                styles.variation,
                { borderColor: i === selectedIdx ? colors.primary : 'transparent' },
              ]}
            >
              <MediaImage uri={variation.url} style={styles.variationImage} contentFit="cover" loadingIndicator />
            </Pressable>
          ))}
        </View>
      </GlassCard>
      <ImageViewer uri={viewing} title="Preview" onClose={() => setViewing(null)} />

      <View style={styles.afterCard}>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {storing ? (
          <View style={styles.uploadingRow}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={[styles.uploadingText, { color: colors.textSecondary }]}>Saving the image to your library…</Text>
          </View>
        ) : null}
        {pending ? (
          <Text style={[styles.sub, { color: colors.textSecondary, textAlign: 'center' }]}>
            A new image is being generated and will replace this one when it is ready.
          </Text>
        ) : (
          <Button title="Regenerate" variant="soft" onPress={onGenerate} disabled={storing} />
        )}
      </View>
    </>
  )
}

/* ── Pieces ────────────────────────────────────────────────────────────── */

/** Numbered badges: the step you are on is violet, the ones ahead are black, done ones are ticked. */
function StepBar({ step }) {
  const { colors } = useTheme()
  return (
    <View style={styles.stepBar}>
      {STEPS.map((label, i) => {
        const done = i < step
        const active = i === step
        return (
          <View key={label} style={styles.stepItem}>
            <View style={[styles.stepDot, { backgroundColor: done || active ? colors.primary : colors.ink }]}>
              {done ? (
                <Icon name="check" size={11} color="#FFFFFF" />
              ) : (
                <Text style={[styles.stepDotText, font('medium'), { color: active ? colors.onPrimary : colors.onInk }]}>
                  {i + 1}
                </Text>
              )}
            </View>
            <Text style={[styles.stepLabel, font(active ? 'medium' : 'regular'), { color: active ? colors.textPrimary : colors.textSecondary }]}>
              {label}
            </Text>
          </View>
        )
      })}
    </View>
  )
}

function Actions({ step, canContinue, generating, hasResults, saving, onBack, onNext, onSave }) {
  const isLast = step === STEPS.length - 1

  return (
    <View style={styles.actions}>
      {step > 0 ? (
        <View style={styles.flex}>
          <Button title="Back" variant="soft" onPress={onBack} disabled={generating} />
        </View>
      ) : null}
      <View style={styles.flex}>
        {isLast ? (
          <Button
            title={saving ? 'Saving…' : 'Save influencer'}
            onPress={onSave}
            disabled={!hasResults || generating || saving}
          />
        ) : (
          <Button title="Continue" onPress={onNext} disabled={!canContinue} />
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  body: { paddingHorizontal: layout.pageGutter },

  headingWrap: { marginTop: space.xl, marginBottom: space.xl },
  heading: { fontSize: 26, letterSpacing: -0.5 },
  sub: { fontSize: 12.5, lineHeight: 18, marginTop: 4 },

  stepBar: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 2, marginTop: space.xs },
  stepItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepDot: { width: 16, height: 16, borderRadius: 3.5, alignItems: 'center', justifyContent: 'center' },
  stepDotText: { fontSize: 10.5, lineHeight: 13 },
  stepLabel: { fontSize: 13 },

  choiceRow: { flexDirection: 'row', gap: space.md },
  fieldError: { fontSize: 12.5, marginTop: 6, marginLeft: space.sm },
  cardPad: { padding: space.md + 2 },
  reference: { width: '100%', aspectRatio: 3 / 4, borderRadius: radius.md },

  attr: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, borderRadius: radius.md, borderWidth: 1 },
  checkbox: { width: 22, height: 22, borderRadius: 7, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  attrLabel: { fontSize: 15 },
  attrDesc: { fontSize: 12, marginTop: 1 },

  centered: { alignItems: 'center', gap: space.md, paddingTop: space.xl, paddingBottom: space.md },
  stretch: { alignSelf: 'stretch' },
  progress: { alignSelf: 'stretch', paddingHorizontal: space.xl },
  uploadingRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  uploadingText: { fontSize: 13 },

  // Small enough that Regenerate, Back and Save all clear the floating tab bar without scrolling.
  variation: { borderRadius: radius.lg, overflow: 'hidden', borderWidth: 2.5, alignSelf: 'center', width: '54%' },
  variationImage: { width: '100%', aspectRatio: 9 / 16 },
  afterCard: { gap: space.md, marginTop: space.lg },

  actions: { flexDirection: 'row', gap: space.md, marginTop: space.lg },
})
