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

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  View, Text, TextInput, ScrollView, Image,
  ActivityIndicator, StyleSheet, Alert,
} from 'react-native'

import { useBottomInset } from '../hooks/useBottomInset'
import { mediaSource } from '../lib/seedMedia'

import { useInfluencers } from '@core/store'
import { getNiches } from '@core/niches'
import { regenerateMainImage, NO_CREATION_PARAMS } from '@core/regenerate'
import { STILL_RUNNING } from '@core/services/generation'
import { uploadLocal, remove as removeAsset } from '@core/data/assets'
import { assetUses } from '@core/data/influencers'
import { hasActiveJobs } from '@core/data/jobs'
import { shareMedia } from '../lib/share'
import { showError } from '../lib/alerts'
import { persistGenerated } from '@core/platform/persistMedia'

import { useTheme, space, radius, font, layout } from '../theme'
import CostNote from '../components/CostNote'
import { IMAGE_MODEL_ID } from '@core/config/generation'
import { Section, Row, Button, Collapsible, Field, Chip, PillInput } from '../components/ui'
import Icon from '../components/icons'
import IdentityRefs from '../components/IdentityRefs'
import { pickImageWithPrompt } from '../lib/picker'
import { usePendingResult } from '../hooks/usePendingResult'

export default function ProfileTab({ influencer, navigation }) {
  const { colors } = useTheme()
  const bottomInset = useBottomInset()
  const { updateInfluencer, removeInfluencer } = useInfluencers()

  const heroSource = mediaSource(influencer.mainImage)

  const [regenerating, setRegenerating] = useState(false)
  const [nicheOpen, setNicheOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  /** A regenerated image that outlived the foreground poll, watched until it lands. */
  const [pendingTaskId, setPendingTaskId] = useState(null)

  // The name is edited locally and written on blur. Patching on every keystroke
  // would be a request per character.
  const [name, setName] = useState(influencer.name || '')
  useEffect(() => { setName(influencer.name || '') }, [influencer.id, influencer.name])

  /** Patch this influencer. Optimistic locally, reconciled with the server. */
  const update = useCallback(patch => {
    updateInfluencer(influencer.id, patch).catch(e => {
      showError('Unable to save', e, 'Your changes could not be saved. Please try again.')
    })
  }, [influencer.id, updateInfluencer])

  /**
   * Make `assetId` the main image, then delete the image it replaced — which
   * otherwise stayed in storage, counted against the quota and shown nowhere.
   * It is kept if still in use (the gallery, a reference sheet, a running job),
   * and deleted only after the new one is saved, so a failed save loses nothing.
   */
  const setMainImage = useCallback(async assetId => {
    const previous = influencer.mainAssetId
    await updateInfluencer(influencer.id, { mainAssetId: assetId })
    if (!previous || previous === assetId) return

    const inGallery = (influencer.generationHistory || []).some(g => g.assetId === previous)
    const usedElsewhere = assetUses({ ...influencer, mainAssetId: null }, previous).length > 0
    if (inGallery || usedElsewhere) return
    // The main image is the reference for every video and sheet. A job still
    // running may not have downloaded it yet, and deleting it would fail a job
    // already paid for — so it stays, and goes when the influencer is deleted.
    if (await hasActiveJobs(influencer.id)) return

    removeAsset(previous).catch(e => console.warn('[profile] could not delete the replaced image:', e?.message ?? e))
  }, [influencer, updateInfluencer])

  const replaceImage = useCallback(async () => {
    const uri = await pickImageWithPrompt()
    if (!uri) return
    setRegenerating(true)
    try {
      const { assetId } = await uploadLocal({
        uri, kind: 'image', contentType: 'image/jpeg', influencerId: influencer.id,
      })
      await setMainImage(assetId)
    } catch (e) {
      showError('Upload failed', e, 'The image could not be uploaded. Please try again.')
    } finally {
      setRegenerating(false)
    }
  }, [setMainImage, influencer.id])

  const regenerate = useCallback(async () => {
    setRegenerating(true)
    let taskId = null
    try {
      const url = await regenerateMainImage(influencer, undefined, {
        influencerId: influencer.id, influencerName: influencer.name, label: 'Main image',
      }, ids => { taskId = ids?.[0] ?? null })
      // KIE's result URLs expire within a day, so the server copies the file
      // into this user's storage before it becomes the influencer's main image.
      const { assetId } = await persistGenerated({
        sourceUrl: url, kind: 'image', influencerId: influencer.id,
      })
      await setMainImage(assetId)
    } catch (e) {
      if (e?.message === NO_CREATION_PARAMS) {
        // Not necessarily an old influencer: the record can also be missing
        // because saving it failed when the influencer was created.
        Alert.alert(
          'Unable to regenerate',
          'The settings this influencer was generated from are not available, so a matching image cannot be created. Upload a new image instead.'
        )
      } else if (e?.message === STILL_RUNNING && taskId) {
        // Watched below, so it still becomes the main image when it lands.
        // Collecting it from the Queue only filed it in the gallery.
        setPendingTaskId(taskId)
      } else if (e?.message === STILL_RUNNING) {
        Alert.alert(
          'Still generating',
          'This is taking longer than usual. The image will be saved to the gallery when it is ready.'
        )
      } else {
        showError('Regeneration failed', e, 'Unable to generate a new image. Please try again.')
      }
    } finally {
      setRegenerating(false)
    }
  }, [influencer, setMainImage])

  usePendingResult(pendingTaskId, {
    kind: 'image',
    influencerId: influencer.id,
    onReady: ({ assetId }) => {
      setPendingTaskId(null)
      setMainImage(assetId).catch(e =>
        showError('Unable to update', e, 'The new image was generated but could not be set as the main image.'))
    },
    onFailed: message => {
      setPendingTaskId(null)
      Alert.alert('Regeneration failed', message)
    },
  })

  const commitName = useCallback(() => {
    const trimmed = name.trim()
    if (trimmed === (influencer.name || '')) return
    update({ name: trimmed })
  }, [name, influencer.name, update])

  const confirmDelete = useCallback(() => {
    Alert.alert(
      `Delete ${influencer.name || 'this influencer'}?`,
      'This will permanently delete this influencer and all of their images and videos. This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeleting(true)
            try {
              await removeInfluencer(influencer.id)
              navigation?.goBack?.()
            } catch (e) {
              showError('Unable to delete', e, 'The influencer could not be deleted. Please try again.')
              setDeleting(false)
            }
          },
        },
      ],
    )
  }, [influencer.id, influencer.name, removeInfluencer, navigation])

  const niches = getNiches(influencer.gender)

  return (
    <ScrollView
      contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <Section title="Main image">
        <View style={styles.padded}>
          {heroSource ? (
            <View style={{ gap: space.md }}>
              <View>
                <Image source={heroSource} style={styles.hero} resizeMode="cover" />
                {regenerating || pendingTaskId ? (
                  <View style={styles.heroOverlay}>
                    <ActivityIndicator size="large" color="#FFFFFF" />
                    <Text style={[styles.heroOverlayText, font('medium')]}>{pendingTaskId ? 'Still generating…' : 'Generating…'}</Text>
                  </View>
                ) : null}
              </View>
              <CostNote model={IMAGE_MODEL_ID} />
              <View style={styles.buttonRow}>
                <View style={styles.flex}>
                  <Button title="Regenerate" size="sm" onPress={regenerate} disabled={regenerating || !!pendingTaskId} />
                </View>
                <View style={styles.flex}>
                  <Button title="Replace" size="sm" variant="soft" onPress={replaceImage} disabled={regenerating || !!pendingTaskId} />
                </View>
              </View>
              <Button
                title="Share"
                size="sm"
                variant="secondary"
                onPress={() => shareMedia(influencer.mainImage, `${(influencer.name || 'influencer').toLowerCase()}.jpg`)}
              />
            </View>
          ) : (
            <View style={{ gap: space.md }}>
              <Text style={[styles.empty, { color: colors.textSecondary }]}>
                {influencer.name} does not have an image yet.
              </Text>
              <Button title="Upload image" onPress={replaceImage} />
            </View>
          )}
        </View>
      </Section>

      <IdentityRefs influencer={influencer} />

      <Section title="Identity">
        <Row
          label="Name"
          right={
            <TextInput
              value={name}
              onChangeText={setName}
              onEndEditing={commitName}
              onBlur={commitName}
              placeholder="Unnamed"
              placeholderTextColor={colors.textTertiary}
              returnKeyType="done"
              style={[styles.inlineInput, styles.nameInput, font('regular'), { color: colors.textSecondary }]}
            />
          }
        />
        <Row
          label="Gender"
          right={
            <View style={styles.chipRow}>
              {['Female', 'Male'].map(g => (
                <Chip key={g} label={g} active={influencer.gender === g} onPress={() => update({ gender: g })} />
              ))}
            </View>
          }
        />
        <Row
          label="Age"
          right={
            <DraftInput
              value={String(influencer.age ?? '')}
              onCommit={v => update({ age: v })}
              transform={v => v.replace(/[^0-9]/g, '')}
              placeholder="—"
              placeholderTextColor={colors.textTertiary}
              keyboardType="number-pad"
              style={[styles.inlineInput, font('regular'), { color: colors.textSecondary }]}
            />
          }
        />
        <Row
          last
          label="Niche"
          value={influencer.niche || 'Select…'}
          right={<Icon name="chevron" size={16} color={colors.textSecondary} />}
          onPress={() => setNicheOpen(o => !o)}
        />
      </Section>

      {nicheOpen ? (
        <Section title="Select a niche">
          <View style={[styles.padded, styles.nicheWrap]}>
            {niches.map(n => (
              <Chip
                key={n}
                label={n}
                active={influencer.niche === n}
                onPress={() => { update({ niche: n }); setNicheOpen(false) }}
              />
            ))}
          </View>
        </Section>
      ) : null}

      <Collapsible title="Details" subtitle="Appearance, backstory and prompt">
        <Field label="Appearance" hint="Used as the description when regenerating the image.">
          <DraftInput
            field
            value={influencer.physicalDesc ?? ''}
            onCommit={v => update({ physicalDesc: v })}
            placeholder="e.g. Mid-20s, long dark curly hair, warm smile"
            multiline
          />
        </Field>

        <Field label="Backstory" hint="Optional. Adds personality to scripts.">
          <DraftInput
            field
            value={influencer.backstory ?? ''}
            onCommit={v => update({ backstory: v })}
            placeholder="Background, interests and values"
            multiline
          />
        </Field>

        <Field label="Prompt" hint="The prompt used to generate this influencer's image.">
          <DraftInput
            field
            value={influencer.prompt ?? ''}
            onCommit={v => update({ prompt: v })}
            placeholder="Enter a prompt"
            multiline
          />
        </Field>
      </Collapsible>

      <Section
        title="Delete influencer"
        footer="Permanently delete this influencer and all of their images and videos. This action cannot be undone."
      >
        <View style={styles.padded}>
          <Button title="Delete influencer" variant="danger" onPress={confirmDelete} disabled={deleting} />
        </View>
      </Section>

    </ScrollView>
  )
}

/**
 * A text field that saves when editing ends, not on every keystroke.
 *
 * Saving per character sent a request per key, and on a slow connection the
 * answers could arrive out of order and put back text the user had already
 * typed past. While the field is being edited the draft is local; the stored
 * value replaces it only when it is not.
 */
function DraftInput({ value, onCommit, transform, field, ...props }) {
  const [draft, setDraft] = useState(value ?? '')
  const draftRef = useRef(draft)
  const editing = useRef(false)

  useEffect(() => {
    if (editing.current) return
    draftRef.current = value ?? ''
    setDraft(value ?? '')
  }, [value])

  // onEndEditing and onBlur both fire; the `editing` flag makes the second a no-op.
  const commit = () => {
    if (!editing.current) return
    editing.current = false
    if (draftRef.current !== (value ?? '')) onCommit(draftRef.current)
  }
  const commitRef = useRef(commit)
  commitRef.current = commit

  // Leaving the screen mid-edit still saves what was typed.
  useEffect(() => () => commitRef.current(), [])

  // `field`: the design's tinted input; otherwise a bare inline input for the rows.
  const Input = field ? PillInput : TextInput
  return (
    <Input
      {...props}
      value={draft}
      onFocus={() => { editing.current = true }}
      onChangeText={v => {
        const next = transform ? transform(v) : v
        draftRef.current = next
        setDraft(next)
      }}
      onEndEditing={commit}
      onBlur={commit}
    />
  )
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: layout.pageGutter, paddingTop: space.sm },
  padded: { padding: space.md + 2 },
  flex: { flex: 1 },

  hero: { width: '100%', aspectRatio: 4 / 5, borderRadius: radius.md },
  heroOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(8,3,83,0.55)', borderRadius: radius.md, gap: space.sm,
  },
  heroOverlayText: { color: '#FFFFFF', fontSize: 14 },
  empty: { fontSize: 14 },

  buttonRow: { flexDirection: 'row', gap: space.md },
  chipRow: { flexDirection: 'row', gap: space.sm },
  nicheWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },

  inlineInput: { fontSize: 14, minWidth: 60, textAlign: 'right', paddingVertical: 0 },
  nameInput: { minWidth: 160 },
})
