/**
 * An influencer's saved outfits, and the things a person does with them: add one from a photo, give
 * it a name, swap its photo, remove it.
 *
 * Shared by the Wardrobe section and the outfit sheet, which both let a person add a photo. The list
 * itself is the influencer's own `wardrobeSlots` (the store keeps it); the rules — which slots count,
 * the limit of eight, names — are core/wardrobe.js. This is the part that touches the phone and the
 * network: the picker, the upload, the save, and clearing away a photo nothing needs any more.
 *
 * A photo is uploaded first and the list saved second, so a failed save is cleaned up (the upload is
 * deleted) rather than left in the person's storage, counted against their quota and shown nowhere.
 * The other way round, a failed upload would leave an outfit with nothing to show.
 */

import { useCallback, useRef, useState } from 'react'

import { useInfluencers } from '@core/store'
import { uploadLocal, remove as removeAsset } from '@core/data/assets'
import { hasActiveJobs } from '@core/data/jobs'
import { isInGallery } from '@core/data/generations'
import { userMessage, isSessionEnded } from '@core/errors'
import { isOutOfCredits } from '@core/billing/outOfCredits'
import {
  outfitsOf, canAddOutfit, addOutfit, renameOutfit, removeOutfit, replaceOutfitPhoto,
} from '@core/wardrobe'

import { pickImageWithPrompt } from '../lib/picker'
import { Alert } from '../lib/dialog'

/** The sentence for a failure, or null when something else has already said it (credits, an ended session). */
export function errorText(e, fallback) {
  if (isSessionEnded(e) || isOutOfCredits(e)) return null
  return userMessage(e, fallback)
}

export function useWardrobe(influencer) {
  const { updateInfluencer } = useInfluencers()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const outfits = outfitsOf(influencer)
  const canAdd = canAddOutfit(influencer)

  const save = useCallback(
    slots => updateInfluencer(influencer.id, { wardrobeSlots: slots }),
    [influencer.id, updateInfluencer],
  )

  /** Ask for a photo and store it: `{assetId, uri}`, or null when the person backed out. */
  const takePhoto = useCallback(async () => {
    const uri = await pickImageWithPrompt()
    if (!uri) return null
    const { assetId } = await uploadLocal({ uri, kind: 'image', contentType: 'image/jpeg', influencerId: influencer.id })
    return { assetId, uri }
  }, [influencer.id])

  /**
   * Delete a photo no outfit uses any more. Kept, like the main image it is modelled on, while a job
   * of this influencer is running (it may not have downloaded the photo yet, and deleting it would
   * fail a job already paid for), and when the gallery holds it. Never fails the caller.
   */
  const discard = useCallback(async assetId => {
    if (!assetId) return
    try {
      if (await hasActiveJobs(influencer.id)) return
      if (await isInGallery(assetId)) return
      await removeAsset(assetId)
    } catch (e) {
      console.warn('[wardrobe] could not delete an outfit photo:', e?.message ?? e)
    }
  }, [influencer.id])

  /**
   * One action at a time: what it does, what it says if it fails. The guard is a ref, not the `busy`
   * state: two taps before the screen has redrawn would both see it false.
   */
  const working = useRef(false)
  const run = useCallback(async (fallback, action) => {
    if (working.current) return null
    working.current = true
    setBusy(true)
    setError(null)
    try {
      return await action()
    } catch (e) {
      setError(errorText(e, fallback))
      return null
    } finally {
      working.current = false
      setBusy(false)
    }
  }, [])

  /** Add an outfit from a photo. @returns {Promise<object|null>} the slot, shown from the photo itself */
  const add = useCallback(() => run('The outfit could not be added. Please try again.', async () => {
    if (!canAdd) return null
    const stored = await takePhoto()
    if (!stored) return null
    try {
      const { slots, slot } = addOutfit(influencer.wardrobeSlots, { assetId: stored.assetId, image: stored.uri })
      await save(slots)
      return slot
    } catch (e) {
      discard(stored.assetId)
      throw e
    }
  }), [run, canAdd, takePhoto, influencer.wardrobeSlots, save, discard])

  /** Swap an outfit's photo, keeping its place and name. */
  const replace = useCallback(slot => run('The photo could not be replaced. Please try again.', async () => {
    const stored = await takePhoto()
    if (!stored) return null
    try {
      await save(replaceOutfitPhoto(influencer.wardrobeSlots, slot.id, { assetId: stored.assetId, image: stored.uri }))
    } catch (e) {
      discard(stored.assetId)
      throw e
    }
    discard(slot.asset_id)
    return slot
  }), [run, takePhoto, influencer.wardrobeSlots, save, discard])

  const rename = useCallback((slot, name) => run('The name could not be saved. Please try again.', async () => {
    await save(renameOutfit(influencer.wardrobeSlots, slot.id, name))
    return slot
  }), [run, influencer.wardrobeSlots, save])

  /** Ask, then remove the outfit and delete its photo. */
  const remove = useCallback(slot => {
    Alert.alert(
      `Remove ${slot.name || 'this outfit'}?`,
      'The photo is deleted. Pictures already made with it stay in the gallery.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => run('The outfit could not be removed. Please try again.', async () => {
            await save(removeOutfit(influencer.wardrobeSlots, slot.id))
            discard(slot.asset_id)
            return slot
          }),
        },
      ],
    )
  }, [run, influencer.wardrobeSlots, save, discard])

  return { outfits, canAdd, busy, error, clearError: () => setError(null), add, replace, rename, remove }
}
