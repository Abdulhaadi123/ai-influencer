/**
 * Profile — the native counterpart of the web studio's Influencer tab.
 *
 * Identity fields plus the main image, with replace / regenerate / share.
 * Regeneration goes through the SHARED regenerateMainImage from core, so both
 * platforms reuse the same creation params and produce the same kind of result.
 *
 * Edits write through the shared store module, so both platforms persist the
 * same records in the same shape.
 *
 * They do NOT see each other's data: storage is per-installation — the browser
 * keeps its own localStorage per origin, the app keeps its own expo-sqlite store. Sharing an
 * influencer across devices would need a backend, which this app does not have.
 */

import { useCallback, useState } from 'react'
import {
  View, Text, TextInput, ScrollView, Image, Pressable,
  ActivityIndicator, StyleSheet, Alert,
} from 'react-native'

import { useBottomInset } from '../hooks/useBottomInset'
import { mediaSource } from '../lib/seedMedia'

import { useInfluencers } from '@core/store'
import { getNiches } from '@core/niches'
import { regenerateMainImage, NO_CREATION_PARAMS } from '@core/regenerate'
import { downloadImage } from '@core/platform/media'
import { persistMedia, mediaFilename } from '@core/platform/persistMedia'

import { useTheme, space, radius } from '../theme'
import { Section, Row, Button, Collapsible, Field } from '../components/ui'
import IdentityRefs from '../components/IdentityRefs'
import { pickImageWithPrompt } from '../lib/picker'

export default function ProfileTab({ influencer }) {
  const { colors } = useTheme()
  const bottomInset = useBottomInset()
  const [, setInfluencers] = useInfluencers()

  const heroSource = mediaSource(influencer.mainImage)

  const [regenerating, setRegenerating] = useState(false)
  const [nicheOpen, setNicheOpen] = useState(false)

  /** Patch this influencer in the shared store. */
  const update = useCallback(patch => {
    setInfluencers(prev => prev.map(i => i.id === influencer.id ? { ...i, ...patch } : i))
  }, [influencer.id, setInfluencers])

  const replaceImage = useCallback(async () => {
    const uri = await pickImageWithPrompt()
    if (uri) update({ mainImage: uri })
  }, [update])

  const regenerate = useCallback(async () => {
    setRegenerating(true)
    try {
      const url = await regenerateMainImage(influencer)
      // Copy onto the device: KIE's result URLs expire within days.
      const localUri = await persistMedia(url, mediaFilename('image', `${influencer.id}_${Date.now()}`, 'jpg'))
      update({ mainImage: localUri })
    } catch (e) {
      if (e?.message === NO_CREATION_PARAMS) {
        Alert.alert(
          'Nothing to regenerate from',
          'This influencer was created before regeneration was supported. Replace the image manually instead.'
        )
      } else {
        Alert.alert('Regeneration failed', e?.message ?? 'Please try again.')
      }
    } finally {
      setRegenerating(false)
    }
  }, [influencer, update])

  const niches = getNiches(influencer.gender)

  return (
    <ScrollView
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]}
      keyboardShouldPersistTaps="handled"
    >
      <Section title="Main image">
        <View style={styles.padded}>
          {heroSource ? (
            <View style={{ gap: space.md }}>
              <View>
                <Image source={heroSource} style={styles.hero} resizeMode="cover" />
                {regenerating ? (
                  <View style={styles.heroOverlay}>
                    <ActivityIndicator size="large" color="#FFFFFF" />
                    <Text style={styles.heroOverlayText}>Regenerating…</Text>
                  </View>
                ) : null}
              </View>
              <View style={styles.buttonRow}>
                <View style={styles.flex}>
                  <Button title="Regenerate" onPress={regenerate} disabled={regenerating} />
                </View>
                <View style={styles.flex}>
                  <Button title="Replace" variant="secondary" onPress={replaceImage} disabled={regenerating} />
                </View>
              </View>
              <Button
                title="Save or share"
                variant="secondary"
                onPress={() => downloadImage(influencer.mainImage, `${(influencer.name || 'influencer').toLowerCase()}.jpg`)}
              />
            </View>
          ) : (
            <View style={{ gap: space.md }}>
              <Text style={[styles.empty, { color: colors.textSecondary }]}>
                {influencer.name} has no image yet.
              </Text>
              <Button title="Add an image" onPress={replaceImage} />
            </View>
          )}
        </View>
      </Section>

      <IdentityRefs influencer={influencer} />

      <Section title="Identity">
        <Row
          label="Gender"
          right={
            <View style={styles.chipRow}>
              {['Female', 'Male'].map(g => {
                const on = influencer.gender === g
                return (
                  <Pressable
                    key={g}
                    onPress={() => update({ gender: g })}
                    style={[styles.chip, {
                      borderColor: on ? colors.brand : colors.border,
                      backgroundColor: on ? colors.brandSoft : 'transparent',
                    }]}
                  >
                    <Text style={[styles.chipText, { color: on ? colors.brand : colors.textSecondary }]}>{g}</Text>
                  </Pressable>
                )
              })}
            </View>
          }
        />
        <Row
          label="Age"
          right={
            <TextInput
              value={String(influencer.age ?? '')}
              onChangeText={v => update({ age: v.replace(/[^0-9]/g, '') })}
              placeholder="—"
              placeholderTextColor={colors.textTertiary}
              keyboardType="number-pad"
              style={[styles.inlineInput, { color: colors.textPrimary }]}
            />
          }
        />
        <Row
          last
          label="Niche"
          value={influencer.niche || 'Select…'}
          onPress={() => setNicheOpen(o => !o)}
        />
      </Section>

      {nicheOpen ? (
        <Section title="Choose a niche">
          <View style={[styles.padded, styles.nicheWrap]}>
            {niches.map(n => {
              const on = influencer.niche === n
              return (
                <Pressable
                  key={n}
                  onPress={() => { update({ niche: n }); setNicheOpen(false) }}
                  style={[styles.chip, {
                    borderColor: on ? colors.brand : colors.border,
                    backgroundColor: on ? colors.brandSoft : 'transparent',
                  }]}
                >
                  <Text style={[styles.chipText, { color: on ? colors.brand : colors.textSecondary }]}>{n}</Text>
                </Pressable>
              )
            })}
          </View>
        </Section>
      ) : null}

      <Collapsible title="Details" subtitle="Appearance, backstory and prompt">
        <Field label="Appearance" hint="Used as the description when regenerating images.">
          <TextInput
            value={influencer.physicalDesc ?? ''}
            onChangeText={v => update({ physicalDesc: v })}
            placeholder="e.g. mid-20s, long dark curly hair, warm smile"
            placeholderTextColor={colors.textTertiary}
            multiline
            style={[styles.input, { color: colors.textPrimary, borderColor: colors.border, backgroundColor: colors.bg }]}
          />
        </Field>

        <Field label="Backstory" hint="Optional. Adds personality for scripts.">
          <TextInput
            value={influencer.backstory ?? ''}
            onChangeText={v => update({ backstory: v })}
            placeholder="Where they're from, what they care about…"
            placeholderTextColor={colors.textTertiary}
            multiline
            style={[styles.input, { color: colors.textPrimary, borderColor: colors.border, backgroundColor: colors.bg }]}
          />
        </Field>

        <Field label="Prompt" hint="What this influencer's image was generated from.">
          <TextInput
            value={influencer.prompt ?? ''}
            onChangeText={v => update({ prompt: v })}
            placeholder="Paste a prompt here"
            placeholderTextColor={colors.textTertiary}
            multiline
            style={[styles.input, { color: colors.textPrimary, borderColor: colors.border, backgroundColor: colors.bg }]}
          />
        </Field>
      </Collapsible>

    </ScrollView>
  )
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingTop: space.lg },
  padded: { padding: space.lg },
  flex: { flex: 1 },

  hero: { width: '100%', aspectRatio: 9 / 16, borderRadius: radius.md, maxHeight: 420 },
  heroOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: radius.md, gap: space.sm,
  },
  heroOverlayText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
  empty: { fontSize: 14 },

  buttonRow: { flexDirection: 'row', gap: space.md },
  chipRow: { flexDirection: 'row', gap: space.sm },
  chip: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: radius.sm, borderWidth: 1.5 },
  chipText: { fontSize: 13, fontWeight: '600' },
  nicheWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },

  inlineInput: { fontSize: 15, minWidth: 60, textAlign: 'right', paddingVertical: 0 },
  input: {
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 10,
    paddingHorizontal: space.md, paddingVertical: space.md,
    fontSize: 15, minHeight: 88, textAlignVertical: 'top',
  },
})
