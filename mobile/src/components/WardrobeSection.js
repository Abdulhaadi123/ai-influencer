/**
 * The Wardrobe section of the Profile tab: the influencer's saved outfit photos.
 *
 * A grid of outfits, each with its photo, a name that can be changed, "Try on" (which opens the outfit
 * sheet with this one chosen) and Replace / Remove, and an "Add outfit" tile while there is room. The
 * rules and the saving are core/wardrobe.js and hooks/useWardrobe.js; this only draws them.
 *
 * Photos are stored like every other file of the influencer (S3, checked by the server when they are
 * uploaded), and an outfit is only ever a photo: nothing here is sent anywhere until Try on.
 */

import { useEffect, useState } from 'react'
import {
  View, Text, Pressable, ActivityIndicator, Modal, KeyboardAvoidingView, Platform, StyleSheet,
} from 'react-native'

import { MAX_WARDROBE_SLOTS, cleanOutfitName } from '@core/wardrobe'
import { INPUT_LIMITS } from '@core/config/inputLimits'
import { thumbUrlFor } from '@core/data/assets'

import { useTheme, space, radius, font } from '../theme'
import { Section, Button, PillInput } from './ui'
import MediaImage from './MediaImage'
import ImageViewer from './ImageViewer'
import Icon from './icons'
import { useWardrobe } from '../hooks/useWardrobe'

/**
 * @param {object} props
 * @param {object} props.influencer
 * @param {(outfit: object) => void} props.onTryOn  open the outfit sheet with this outfit chosen
 */
export default function WardrobeSection({ influencer, onTryOn }) {
  const { colors } = useTheme()
  const wardrobe = useWardrobe(influencer)
  const { outfits, canAdd, busy, error } = wardrobe
  const [viewing, setViewing] = useState(null)
  const [renaming, setRenaming] = useState(null)

  const who = influencer.name || 'this influencer'

  return (
    <Section
      title="Wardrobe"
      footer="Clear, well-lit photos work best: the outfit on its own, or worn by someone. Logos and small text may not come out exactly."
    >
      <View style={styles.body}>
        <Text style={[styles.intro, { color: colors.textSecondary }]}>
          Save photos of outfits, then pick one to dress {who} in. The face and pose stay as they are.
        </Text>

        <View style={styles.grid}>
          {outfits.map(outfit => (
            <OutfitTile
              key={outfit.id}
              outfit={outfit}
              disabled={busy}
              onOpen={() => setViewing(outfit)}
              onRename={() => setRenaming(outfit)}
              onTryOn={() => onTryOn?.(outfit)}
              onReplace={() => wardrobe.replace(outfit)}
              onRemove={() => wardrobe.remove(outfit)}
            />
          ))}
          {canAdd ? <AddTile busy={busy} onPress={wardrobe.add} /> : null}
        </View>

        {!canAdd ? (
          <Text style={[styles.note, { color: colors.textTertiary }]}>
            {`That is the most one influencer can hold (${MAX_WARDROBE_SLOTS}). Remove one to add another.`}
          </Text>
        ) : null}
        {error ? <Text style={[styles.error, { color: colors.danger }]}>{error}</Text> : null}
      </View>

      <ImageViewer
        uri={viewing?.image ?? null}
        previewUri={viewing ? thumbUrlFor(viewing.asset_id) : null}
        title={`${influencer.name || ''} · ${viewing?.name || ''}`}
        onClose={() => setViewing(null)}
      />
      <NameDialog
        visible={!!renaming}
        initial={renaming?.name ?? ''}
        onClose={() => setRenaming(null)}
        onSave={name => {
          const outfit = renaming
          setRenaming(null)
          if (outfit) wardrobe.rename(outfit, name)
        }}
      />
    </Section>
  )
}

function OutfitTile({ outfit, disabled, onOpen, onRename, onTryOn, onReplace, onRemove }) {
  const { colors } = useTheme()
  return (
    <View style={styles.tile}>
      <Pressable
        onPress={onOpen}
        accessibilityRole="imagebutton"
        accessibilityLabel={`${outfit.name}, open full screen`}
        style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
      >
        <MediaImage
          uri={outfit.image}
          previewUri={thumbUrlFor(outfit.asset_id)}
          style={[styles.photo, { backgroundColor: colors.surfaceAlt }]}
          contentFit="cover"
          loadingIndicator
        />
      </Pressable>

      <Pressable
        onPress={onRename}
        disabled={disabled}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={`${outfit.name}. Rename`}
      >
        <Text style={[styles.name, font('medium'), { color: colors.textPrimary }]} numberOfLines={1}>{outfit.name}</Text>
      </Pressable>

      <Button title="Try on" size="sm" onPress={onTryOn} disabled={disabled} />

      <View style={styles.links}>
        <Pressable onPress={onReplace} disabled={disabled} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Replace the photo of ${outfit.name}`}>
          <Text style={[styles.link, font('semibold'), { color: colors.primary, opacity: disabled ? 0.5 : 1 }]}>Replace</Text>
        </Pressable>
        <Pressable onPress={onRemove} disabled={disabled} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Remove ${outfit.name}`}>
          <Text style={[styles.link, font('semibold'), { color: colors.danger, opacity: disabled ? 0.5 : 1 }]}>Remove</Text>
        </Pressable>
      </View>
    </View>
  )
}

function AddTile({ busy, onPress }) {
  const { colors } = useTheme()
  return (
    <View style={styles.tile}>
      <Pressable
        onPress={onPress}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel="Add outfit"
        style={({ pressed }) => [styles.photo, styles.add, { borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}
      >
        {busy ? <ActivityIndicator color={colors.primary} /> : <Icon name="plus" size={26} color={colors.primary} />}
        <Text style={[styles.addText, font('semibold'), { color: colors.primary }]}>{busy ? 'Adding…' : 'Add outfit'}</Text>
      </Pressable>
    </View>
  )
}

/** The name of an outfit: one line, at most INPUT_LIMITS.wardrobeName, never empty. */
function NameDialog({ visible, initial, onSave, onClose }) {
  const { colors } = useTheme()
  const [name, setName] = useState(initial)
  useEffect(() => { if (visible) setName(initial) }, [visible, initial])

  const ready = !!cleanOutfitName(name)
  const submit = () => { if (ready) onSave(name) }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[styles.dialog, { backgroundColor: colors.sheet, borderColor: colors.glassEdge }]}>
          <Text style={[styles.dialogTitle, font('bold'), { color: colors.textPrimary }]}>Name this outfit</Text>
          <PillInput
            value={name}
            onChangeText={setName}
            placeholder="e.g. Summer fit"
            maxLength={INPUT_LIMITS.wardrobeName}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={submit}
            accessibilityLabel="Outfit name"
          />
          <View style={styles.dialogActions}>
            <Button title="Save" onPress={submit} disabled={!ready} />
            <Button title="Cancel" variant="neutral" onPress={onClose} />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: space.lg + 2, paddingVertical: space.lg, gap: space.md },
  intro: { fontSize: 13.5, lineHeight: 19 },

  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: space.lg },
  tile: { width: '48%', gap: space.sm },
  photo: { width: '100%', aspectRatio: 3 / 4, borderRadius: radius.md },
  name: { fontSize: 14 },
  links: { flexDirection: 'row', justifyContent: 'space-between' },
  link: { fontSize: 13 },

  add: { alignItems: 'center', justifyContent: 'center', gap: space.sm, borderWidth: 1.2, borderStyle: 'dashed' },
  addText: { fontSize: 13 },

  note: { fontSize: 12.5, lineHeight: 17 },
  error: { fontSize: 13, lineHeight: 18 },

  backdrop: { flex: 1, justifyContent: 'center', padding: space.xl, backgroundColor: 'rgba(8,3,83,0.55)' },
  dialog: { borderRadius: 28, borderWidth: 1, padding: space.xl, gap: space.md },
  dialogTitle: { fontSize: 20, letterSpacing: -0.3 },
  dialogActions: { gap: space.sm, marginTop: space.xs },
})
