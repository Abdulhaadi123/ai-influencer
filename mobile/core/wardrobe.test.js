// An influencer's saved outfits, and the request an outfit change sends.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_WARDROBE_SLOTS, NO_MAIN_IMAGE, NO_OUTFIT_IMAGE, WARDROBE_FULL, OUTFIT_LABEL,
  storedSlot, storedSlots, outfitsOf, canAddOutfit, cleanOutfitName, nextOutfitName,
  addOutfit, renameOutfit, removeOutfit, replaceOutfitPhoto, outfitLabel, prepareOutfitChange,
} from './wardrobe.js'
import { INPUT_LIMITS } from './config/inputLimits.js'

/** What a new influencer starts with (newInfluencer.js). */
const PLACEHOLDERS = [
  { id: 'w1', name: 'Wardrobe 1', asset_id: null },
  { id: 'w2', name: 'Wardrobe 2', asset_id: null },
  { id: 'w3', name: 'Wardrobe 3', asset_id: null },
]

const slot = (n, extra = {}) => ({ id: `s${n}`, name: `Outfit ${n}`, asset_id: `asset-${n}`, image: `https://signed.example/${n}?sig=abc`, ...extra })

// ── What counts ──────────────────────────────────────────────────────────────

test('only slots with a photo count: the three empty ones a new influencer starts with are not outfits', () => {
  assert.deepEqual(outfitsOf(PLACEHOLDERS), [])
  assert.deepEqual(outfitsOf({ wardrobeSlots: [...PLACEHOLDERS, slot(1)] }).map(s => s.id), ['s1'])
})

test('a list from the server may hold anything: null, a number, a list — none of it is an outfit', () => {
  assert.deepEqual(outfitsOf([null, 7, [], 'x', undefined, slot(2)]).map(s => s.id), ['s2'])
  assert.deepEqual(outfitsOf(undefined), [])
  assert.deepEqual(outfitsOf({}), [])
  assert.deepEqual(outfitsOf({ wardrobeSlots: 'nope' }), [])
})

test('an influencer or its list of slots are both accepted', () => {
  const slots = [slot(1), slot(2)]
  assert.equal(outfitsOf(slots).length, 2)
  assert.equal(outfitsOf({ wardrobeSlots: slots }).length, 2)
})

// ── What is saved ────────────────────────────────────────────────────────────

test('a slot is saved without the link its photo is drawn from', () => {
  const saved = storedSlot(slot(1))
  assert.deepEqual(saved, { id: 's1', name: 'Outfit 1', asset_id: 'asset-1' })
  assert.ok(!JSON.stringify(saved).includes('https'), 'no signed link reaches the server')
})

test('saving keeps every other field a slot has, drops what is not an object, and changes nothing in place', () => {
  const original = [slot(1, { note: 'kept' }), null, 3, slot(2)]
  const copy = JSON.parse(JSON.stringify(original))
  const saved = storedSlots(original)
  assert.equal(saved.length, 2)
  assert.equal(saved[0].note, 'kept')
  assert.ok(saved.every(s => !('image' in s)))
  assert.deepEqual(original, copy, 'the slots on screen keep their links')
  assert.deepEqual(storedSlots('nope'), [])
})

// ── Adding ───────────────────────────────────────────────────────────────────

test('the first outfit replaces the empty placeholders, and is called "Outfit 1"', () => {
  const { slots, slot: added } = addOutfit(PLACEHOLDERS, { assetId: 'a1', image: 'https://x/1', id: 'n1' })
  assert.deepEqual(slots, [{ id: 'n1', name: 'Outfit 1', asset_id: 'a1', image: 'https://x/1' }])
  assert.equal(added.id, 'n1')
})

test('an outfit is added at the end and named with the first free number', () => {
  const first = addOutfit([], { assetId: 'a1', id: 'n1' })
  const second = addOutfit(first.slots, { assetId: 'a2', id: 'n2' })
  assert.deepEqual(second.slots.map(s => s.name), ['Outfit 1', 'Outfit 2'])
  const without = removeOutfit(second.slots, 'n1')
  assert.equal(nextOutfitName(without), 'Outfit 1', 'a freed number is used again, never a duplicate name')
  assert.equal(nextOutfitName([slot(1), slot(2), slot(4)]), 'Outfit 3')
})

test('a name given is tidied: one line, trimmed, at most the limit, and an empty one gets the default', () => {
  assert.equal(addOutfit([], { assetId: 'a', name: '  Summer \n  fit  ' }).slot.name, 'Summer fit')
  const long = addOutfit([], { assetId: 'a', name: 'x'.repeat(100) }).slot.name
  assert.equal(long.length, INPUT_LIMITS.wardrobeName)
  assert.equal(addOutfit([], { assetId: 'a', name: '   ' }).slot.name, 'Outfit 1')
})

test('a photo is needed: there is no outfit without one', () => {
  assert.throws(() => addOutfit([], { assetId: null }), /asset id/)
})

test(`a wardrobe holds ${MAX_WARDROBE_SLOTS} outfits, and the next one is refused`, () => {
  let slots = []
  for (let n = 1; n <= MAX_WARDROBE_SLOTS; n++) slots = addOutfit(slots, { assetId: `a${n}` }).slots
  assert.equal(slots.length, MAX_WARDROBE_SLOTS)
  assert.equal(canAddOutfit(slots), false)
  assert.throws(() => addOutfit(slots, { assetId: 'one-too-many' }), new RegExp(WARDROBE_FULL))
  assert.equal(canAddOutfit(removeOutfit(slots, slots[0].id)), true)
})

test('the app never offers more than the server keeps (20)', () => {
  assert.ok(MAX_WARDROBE_SLOTS <= 20)
})

// ── Renaming, removing, replacing ────────────────────────────────────────────

test('renaming changes one outfit and tidies the name; a name with nothing in it changes nothing', () => {
  const slots = [slot(1), slot(2)]
  const renamed = renameOutfit(slots, 's2', '  Blazer   look ')
  assert.deepEqual(renamed.map(s => s.name), ['Outfit 1', 'Blazer look'])
  assert.deepEqual(renameOutfit(slots, 's2', '   ').map(s => s.name), ['Outfit 1', 'Outfit 2'])
  assert.deepEqual(renameOutfit(slots, 'missing', 'X').map(s => s.name), ['Outfit 1', 'Outfit 2'])
  assert.equal(renamed[1].asset_id, 'asset-2', 'the photo stays')
  assert.equal(cleanOutfitName(null), '')
})

test('removing takes one outfit out and leaves the rest in order', () => {
  assert.deepEqual(removeOutfit([slot(1), slot(2), slot(3)], 's2').map(s => s.id), ['s1', 's3'])
  assert.deepEqual(removeOutfit([slot(1)], 'missing').map(s => s.id), ['s1'])
})

test('replacing the photo keeps the outfit\'s place and name', () => {
  const out = replaceOutfitPhoto([slot(1), slot(2)], 's1', { assetId: 'new', image: 'https://x/new' })
  assert.deepEqual(out.map(s => [s.id, s.name, s.asset_id, s.image]), [
    ['s1', 'Outfit 1', 'new', 'https://x/new'],
    ['s2', 'Outfit 2', 'asset-2', 'https://signed.example/2?sig=abc'],
  ])
})

// ── The request ──────────────────────────────────────────────────────────────

test('an outfit change sends the person first and the outfit second, in the shape of the person', () => {
  const request = prepareOutfitChange({ mainImage: 'https://x/main' }, { name: 'Summer fit', image: 'https://x/outfit' })
  assert.equal(request.referenceImage, 'https://x/main')
  assert.equal(request.outfitImage, 'https://x/outfit')
  assert.equal(request.aspectRatio, 'auto')
  assert.match(request.prompt, /image 1/)
  assert.match(request.prompt, /image 2/)
})

test('it is filed as "Outfit change · name", so the gallery and the queue say what it was', () => {
  assert.equal(prepareOutfitChange({ mainImage: 'm' }, { name: 'Summer fit', image: 'o' }).label, 'Outfit change · Summer fit')
  assert.equal(outfitLabel(''), OUTFIT_LABEL)
  assert.equal(outfitLabel(undefined), OUTFIT_LABEL)
  assert.ok(outfitLabel('x'.repeat(100)).length <= 120, 'within what the server keeps for a label')
})

test('what the person typed goes into the prompt; nothing typed adds nothing', () => {
  const withNote = prepareOutfitChange({ mainImage: 'm' }, { image: 'o' }, { note: 'sleeves rolled up' })
  assert.match(withNote.prompt, /sleeves rolled up/)
  assert.doesNotMatch(prepareOutfitChange({ mainImage: 'm' }, { image: 'o' }).prompt, /Extra direction/)
})

test('no main image, or an outfit without a photo, is said, not sent', () => {
  assert.throws(() => prepareOutfitChange({ mainImage: null }, { image: 'o' }), new RegExp(NO_MAIN_IMAGE))
  assert.throws(() => prepareOutfitChange(undefined, { image: 'o' }), new RegExp(NO_MAIN_IMAGE))
  assert.throws(() => prepareOutfitChange({ mainImage: 'm' }, { image: null }), new RegExp(NO_OUTFIT_IMAGE))
  assert.throws(() => prepareOutfitChange({ mainImage: 'm' }, undefined), new RegExp(NO_OUTFIT_IMAGE))
})

test('the influencer\'s description is not sent: the picture is the reference', () => {
  const request = prepareOutfitChange({ mainImage: 'm', physicalDesc: 'Long dark curly hair, green eyes' }, { image: 'o' })
  assert.doesNotMatch(request.prompt, /curly|green eyes/)
})
