/**
 * Create — the native influencer wizard.
 *
 * Mirrors the web wizard's three steps (Basics / Reference / Generate) and
 * shares ALL of its logic with the web app: buildImagePrompts, COPY_ATTRIBUTES,
 * buildNewInfluencer and buildCreationParams all come from core, so the two
 * wizards cannot drift apart.
 *
 * The layout is native rather than a transliteration: one step per screen with
 * a progress header, a bottom action bar, and a native image picker offering
 * camera or library.
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import {
  View, Text, TextInput, ScrollView, Image, Pressable, ActivityIndicator,
  StyleSheet, Alert, KeyboardAvoidingView, Platform,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useInfluencers } from '@core/store'
import { generateThreeImages } from '@core/services/generation'
import { COPY_ATTRIBUTES, buildImagePrompts } from '@core/prompts/influencerPrompts'
import { buildNewInfluencer, buildCreationParams } from '@core/newInfluencer'
import { saveCreationParams } from '@core/creationParams'

import { useTheme, space, radius } from '../theme'
import { Section, Button } from '../components/ui'
import { pickImageWithPrompt } from '../lib/picker'

const STEPS = ['Basics', 'Reference', 'Generate']
const ASPECT_RATIO = '9:16'

export default function CreateScreen({ navigation }) {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const [, setInfluencers] = useInfluencers()

  const [step, setStep] = useState(0)
  const [data, setData] = useState({
    name: '', gender: 'Female', age: '',
    description: '', referenceImage: null,
    copyAttributes: [], copyNote: '',
  })

  const [generating, setGenerating] = useState(false)
  const [progress, setProgress] = useState(0)
  const [variations, setVariations] = useState([])
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [error, setError] = useState(null)

  const promptsRef = useRef([])
  const cancelledRef = useRef(false)

  const set = useCallback((key, value) => setData(d => ({ ...d, [key]: value })), [])

  const canContinue = useMemo(() => {
    if (step === 0) return data.name.trim().length > 0
    // Step 2 needs SOMETHING to generate from — a description or a reference.
    if (step === 1) return !!data.referenceImage || data.description.trim().length > 0
    return true
  }, [step, data])

  const addReference = useCallback(async () => {
    const uri = await pickImageWithPrompt()
    if (uri) set('referenceImage', uri)
  }, [set])

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
    setVariations([])
    cancelledRef.current = false

    try {
      const prompts = buildImagePrompts(data)
      promptsRef.current = prompts

      const urls = await generateThreeImages({
        prompts,
        aspectRatio: ASPECT_RATIO,
        faceRef: data.referenceImage || null,
        physicalDesc: data.description || '',
        onProgress: p => setProgress(Math.round(p)),
        onPartialResults: partial => setVariations([...partial]),
      })

      if (cancelledRef.current) return
      setVariations(urls)
      setSelectedIdx(0)
    } catch (e) {
      if (e?.message !== 'CANCELLED') setError(e?.message ?? String(e))
    } finally {
      setGenerating(false)
    }
  }, [data])

  const save = useCallback(() => {
    if (!variations.length) return
    try {
      const influencer = buildNewInfluencer({
        data, variations, selectedIdx, prompts: promptsRef.current, replaceId: null,
      })
      saveCreationParams(influencer.id, buildCreationParams({ data, aspectRatio: ASPECT_RATIO }))
      setInfluencers(prev => [...prev, influencer])
      navigation.navigate('Influencers')
    } catch (e) {
      Alert.alert('Could not save', e?.message ?? 'Please try again.')
    }
  }, [data, variations, selectedIdx, setInfluencers, navigation])

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <StepBar step={step} />

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 96 }]}
        keyboardShouldPersistTaps="handled"
      >
        {step === 0 && <BasicsStep data={data} set={set} />}
        {step === 1 && (
          <ReferenceStep
            data={data}
            set={set}
            onAddReference={addReference}
            onToggleAttribute={toggleAttribute}
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
          />
        )}
      </ScrollView>

      <ActionBar
        step={step}
        canContinue={canContinue}
        generating={generating}
        hasResults={variations.length > 0}
        onBack={() => setStep(s => Math.max(0, s - 1))}
        onNext={() => setStep(s => Math.min(STEPS.length - 1, s + 1))}
        onSave={save}
      />
    </KeyboardAvoidingView>
  )
}

/* ── Steps ─────────────────────────────────────────────────────────────── */

function BasicsStep({ data, set }) {
  const { colors } = useTheme()
  return (
    <>
      <Text style={[styles.heading, { color: colors.textPrimary }]}>Name your influencer</Text>
      <Text style={[styles.sub, { color: colors.textSecondary }]}>
        Just a name and gender to get started.
      </Text>

      <Section title="Name">
        <View style={styles.padded}>
          <Field value={data.name} onChangeText={v => set('name', v)} placeholder="e.g. Aria" autoFocus />
        </View>
      </Section>

      <Section title="Gender">
        <View style={styles.padded}>
          <View style={styles.choiceRow}>
            {['Female', 'Male'].map(g => (
              <Choice key={g} label={g} active={data.gender === g} onPress={() => set('gender', g)} />
            ))}
          </View>
        </View>
      </Section>

      <Section title="Age" footer="Optional.">
        <View style={styles.padded}>
          <Field
            value={data.age}
            onChangeText={v => set('age', v.replace(/[^0-9]/g, ''))}
            placeholder="e.g. 24"
            keyboardType="number-pad"
          />
        </View>
      </Section>
    </>
  )
}

function ReferenceStep({ data, set, onAddReference, onToggleAttribute }) {
  const { colors } = useTheme()
  return (
    <>
      <Text style={[styles.heading, { color: colors.textPrimary }]}>Describe or upload</Text>
      <Text style={[styles.sub, { color: colors.textSecondary }]}>
        Describe your influencer, add a reference to copy from, or do both.
      </Text>

      <Section
        title="Describe your influencer"
        footer="The AI builds the image from this. Optional if you add a reference below."
      >
        <View style={styles.padded}>
          <Field
            value={data.description}
            onChangeText={v => set('description', v)}
            placeholder="e.g. mid-20s, long dark curly hair, warm smile, freckles"
            multiline
          />
        </View>
      </Section>

      <Section title="Reference image" footer="Copy a real face, outfit or scene.">
        <View style={styles.padded}>
          {data.referenceImage ? (
            <View style={{ gap: space.md }}>
              <Image source={{ uri: data.referenceImage }} style={styles.reference} resizeMode="cover" />
              <View style={styles.choiceRow}>
                <View style={styles.flex}>
                  <Button title="Replace" variant="secondary" onPress={onAddReference} />
                </View>
                <View style={styles.flex}>
                  <Button title="Remove" variant="danger" onPress={() => set('referenceImage', null)} />
                </View>
              </View>
            </View>
          ) : (
            <Button title="Add reference image" onPress={onAddReference} />
          )}
        </View>
      </Section>

      {/* "What to copy" only matters when there IS a reference to copy from. */}
      {data.referenceImage ? (
        <Section
          title="What to copy"
          footer="Pick what to keep from the reference. Nothing selected means copy the whole person."
        >
          <View style={[styles.padded, { gap: space.sm }]}>
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
                      borderColor: on ? colors.brand : colors.borderSubtle,
                      backgroundColor: on ? colors.brandSoft : 'transparent',
                    },
                  ]}
                >
                  <View style={[styles.checkbox, { borderColor: on ? colors.brand : colors.border, backgroundColor: on ? colors.brand : 'transparent' }]}>
                    {on ? <Text style={styles.checkmark}>✓</Text> : null}
                  </View>
                  <View style={styles.flex}>
                    <Text style={[styles.attrLabel, { color: colors.textPrimary }]}>{attr.label}</Text>
                    <Text style={[styles.attrDesc, { color: colors.textSecondary }]}>{attr.desc}</Text>
                  </View>
                </Pressable>
              )
            })}
          </View>
        </Section>
      ) : null}
    </>
  )
}

function GenerateStep({ generating, progress, variations, selectedIdx, onSelect, onGenerate, error }) {
  const { colors } = useTheme()

  if (generating) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.brand} />
        <Text style={[styles.heading, { color: colors.textPrimary }]}>Generating…</Text>
        <Text style={[styles.sub, { color: colors.textSecondary }]}>{progress}%</Text>
        {variations.length ? (
          <Text style={[styles.sub, { color: colors.textSecondary }]}>
            {variations.length} of 3 ready
          </Text>
        ) : null}
      </View>
    )
  }

  if (!variations.length) {
    return (
      <View style={styles.centered}>
        <Text style={[styles.heading, { color: colors.textPrimary }]}>Ready to generate</Text>
        <Text style={[styles.sub, { color: colors.textSecondary, textAlign: 'center' }]}>
          Three looks will be created. Pick your favourite as the main image.
        </Text>
        {error ? <Text style={[styles.error, { color: colors.danger }]}>{error}</Text> : null}
        <Button title="Generate 3 looks" onPress={onGenerate} />
      </View>
    )
  }

  return (
    <>
      <Text style={[styles.heading, { color: colors.textPrimary }]}>Pick your favourite</Text>
      <Text style={[styles.sub, { color: colors.textSecondary }]}>
        This becomes the main image. The others are saved to the gallery.
      </Text>

      <View style={styles.grid}>
        {variations.map((url, i) => (
          <Pressable
            key={url}
            onPress={() => onSelect(i)}
            style={[
              styles.variation,
              { borderColor: i === selectedIdx ? colors.brand : colors.borderSubtle, borderWidth: i === selectedIdx ? 2.5 : StyleSheet.hairlineWidth },
            ]}
          >
            <Image source={{ uri: url }} style={styles.variationImage} resizeMode="cover" />
          </Pressable>
        ))}
      </View>

      <Button title="Regenerate" variant="secondary" onPress={onGenerate} />
    </>
  )
}

/* ── Pieces ────────────────────────────────────────────────────────────── */

function StepBar({ step }) {
  const { colors } = useTheme()
  return (
    <View style={[styles.stepBar, { borderBottomColor: colors.borderSubtle, backgroundColor: colors.bg }]}>
      {STEPS.map((label, i) => {
        const done = i < step
        const active = i === step
        return (
          <View key={label} style={styles.stepItem}>
            <View style={[styles.stepDot, {
              backgroundColor: done || active ? colors.brand : 'transparent',
              borderColor: done || active ? colors.brand : colors.border,
            }]}>
              <Text style={[styles.stepDotText, { color: done || active ? '#FFFFFF' : colors.textTertiary }]}>
                {done ? '✓' : i + 1}
              </Text>
            </View>
            <Text style={[styles.stepLabel, { color: active ? colors.textPrimary : colors.textTertiary }]}>
              {label}
            </Text>
          </View>
        )
      })}
    </View>
  )
}

function ActionBar({ step, canContinue, generating, hasResults, onBack, onNext, onSave }) {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const isLast = step === STEPS.length - 1

  return (
    <View style={[styles.actionBar, {
      backgroundColor: colors.bgSecondary,
      borderTopColor: colors.borderSubtle,
      paddingBottom: insets.bottom || space.lg,
    }]}>
      {step > 0 ? (
        <View style={styles.flex}>
          <Button title="Back" variant="secondary" onPress={onBack} disabled={generating} />
        </View>
      ) : null}
      <View style={styles.flex}>
        {isLast ? (
          <Button title="Save influencer" onPress={onSave} disabled={!hasResults || generating} />
        ) : (
          <Button title="Continue" onPress={onNext} disabled={!canContinue} />
        )}
      </View>
    </View>
  )
}

function Field({ multiline, ...props }) {
  const { colors } = useTheme()
  return (
    <TextInput
      {...props}
      multiline={multiline}
      placeholderTextColor={colors.textTertiary}
      style={[styles.input, multiline && styles.inputMultiline, {
        color: colors.textPrimary,
        borderColor: colors.border,
        backgroundColor: colors.bg,
      }]}
    />
  )
}

function Choice({ label, active, onPress }) {
  const { colors } = useTheme()
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={[styles.choice, {
        borderColor: active ? colors.brand : colors.border,
        backgroundColor: active ? colors.brandSoft : 'transparent',
      }]}
    >
      <Text style={[styles.choiceLabel, { color: active ? colors.brand : colors.textSecondary }]}>
        {label}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  content: { padding: space.lg },
  heading: { fontSize: 22, fontWeight: '700', letterSpacing: -0.3, marginBottom: space.xs },
  sub: { fontSize: 14, lineHeight: 20, marginBottom: space.xl },
  padded: { padding: space.lg },
  flex: { flex: 1 },

  stepBar: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: space.md, borderBottomWidth: StyleSheet.hairlineWidth },
  stepItem: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  stepDot: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  stepDotText: { fontSize: 11, fontWeight: '700' },
  stepLabel: { fontSize: 13, fontWeight: '600' },

  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: space.md, paddingVertical: space.md, fontSize: 15 },
  inputMultiline: { minHeight: 96, textAlignVertical: 'top' },

  choiceRow: { flexDirection: 'row', gap: space.md },
  choice: { flex: 1, paddingVertical: space.md, borderRadius: radius.md, borderWidth: 1.5, alignItems: 'center' },
  choiceLabel: { fontSize: 15, fontWeight: '600' },

  reference: { width: '100%', aspectRatio: 3 / 4, borderRadius: radius.md },

  attr: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, borderRadius: radius.md, borderWidth: 1.5 },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  checkmark: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
  attrLabel: { fontSize: 15, fontWeight: '600' },
  attrDesc: { fontSize: 12, marginTop: 1 },

  centered: { alignItems: 'center', gap: space.md, paddingVertical: space.xxl },
  error: { fontSize: 13, textAlign: 'center' },

  grid: { gap: space.md, marginBottom: space.lg },
  variation: { borderRadius: radius.lg, overflow: 'hidden' },
  variationImage: { width: '100%', aspectRatio: 9 / 16 },

  actionBar: { flexDirection: 'row', gap: space.md, paddingHorizontal: space.lg, paddingTop: space.md, borderTopWidth: StyleSheet.hairlineWidth },
})
