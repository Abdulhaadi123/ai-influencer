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
  View, Text, TextInput, ScrollView, Image, Pressable,
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

import { useTheme, space, radius } from '../theme'
import { Section, Row, Button, Collapsible, Field } from '../components/ui'
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
      showError('Could not save', e, 'Your change was not saved. Please try again.')
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
      showError('Could not upload that image', e, 'The image did not upload. Please try again.')
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
          'Nothing to regenerate from',
          'There is no record of what this influencer was generated from, so a matching image cannot be made. Replace the image manually instead.'
        )
      } else if (e?.message === STILL_RUNNING && taskId) {
        // Watched below, so it still becomes the main image when it lands.
        // Collecting it from the Queue only filed it in the gallery.
        setPendingTaskId(taskId)
      } else if (e?.message === STILL_RUNNING) {
        Alert.alert(
          'Still generating',
          'This is taking longer than usual, but it has not failed. It will be saved to the gallery when it finishes.'
        )
      } else {
        showError('Regeneration failed', e, 'A new image could not be generated. Please try again.')
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
        showError('Could not save', e, 'The new image finished but could not be set as the main image.'))
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
      'Every generation and file belonging to them is deleted too. This cannot be undone.',
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
              showError('Could not delete', e, 'The influencer was not deleted. Please try again.')
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
                {regenerating || pendingTaskId ? (
                  <View style={styles.heroOverlay}>
                    <ActivityIndicator size="large" color="#FFFFFF" />
                    <Text style={styles.heroOverlayText}>{pendingTaskId ? 'Still generating…' : 'Regenerating…'}</Text>
                  </View>
                ) : null}
              </View>
              <View style={styles.buttonRow}>
                <View style={styles.flex}>
                  <Button title="Regenerate" onPress={regenerate} disabled={regenerating || !!pendingTaskId} />
                </View>
                <View style={styles.flex}>
                  <Button title="Replace" variant="secondary" onPress={replaceImage} disabled={regenerating || !!pendingTaskId} />
                </View>
              </View>
              <Button
                title="Save or share"
                variant="secondary"
                onPress={() => shareMedia(influencer.mainImage, `${(influencer.name || 'influencer').toLowerCase()}.jpg`)}
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
              style={[styles.inlineInput, styles.nameInput, { color: colors.textPrimary }]}
            />
          }
        />
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
            <DraftInput
              value={String(influencer.age ?? '')}
              onCommit={v => update({ age: v })}
              transform={v => v.replace(/[^0-9]/g, '')}
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
          <DraftInput
            value={influencer.physicalDesc ?? ''}
            onCommit={v => update({ physicalDesc: v })}
            placeholder="e.g. mid-20s, long dark curly hair, warm smile"
            placeholderTextColor={colors.textTertiary}
            multiline
            style={[styles.input, { color: colors.textPrimary, borderColor: colors.border, backgroundColor: colors.bg }]}
          />
        </Field>

        <Field label="Backstory" hint="Optional. Adds personality for scripts.">
          <DraftInput
            value={influencer.backstory ?? ''}
            onCommit={v => update({ backstory: v })}
            placeholder="Where they're from, what they care about…"
            placeholderTextColor={colors.textTertiary}
            multiline
            style={[styles.input, { color: colors.textPrimary, borderColor: colors.border, backgroundColor: colors.bg }]}
          />
        </Field>

        <Field label="Prompt" hint="What this influencer's image was generated from.">
          <DraftInput
            value={influencer.prompt ?? ''}
            onCommit={v => update({ prompt: v })}
            placeholder="Paste a prompt here"
            placeholderTextColor={colors.textTertiary}
            multiline
            style={[styles.input, { color: colors.textPrimary, borderColor: colors.border, backgroundColor: colors.bg }]}
          />
        </Field>
      </Collapsible>

      <Section
        title="Danger zone"
        footer="Deleting removes this influencer, every generation made with them, and every stored file. It cannot be undone."
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
function DraftInput({ value, onCommit, transform, ...props }) {
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

  return (
    <TextInput
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
  nameInput: { minWidth: 160 },
  input: {
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 10,
    paddingHorizontal: space.md, paddingVertical: space.md,
    fontSize: 15, minHeight: 88, textAlignVertical: 'top',
  },
})
