// The outfit-change prompt: which picture is which, what must not change, and what a person may add.

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildOutfitPrompt, cleanOutfitNote } from './outfitPrompt.js'
import { INPUT_LIMITS } from '../config/inputLimits.js'
import { IMAGE_PROMPT_MAX } from '../config/promptLimits.js'

test('it says which picture is which, by number, in the order they are sent', () => {
  const prompt = buildOutfitPrompt()
  assert.match(prompt, /Image 1 is the person/)
  assert.match(prompt, /Image 2 shows the outfit/)
  assert.ok(prompt.indexOf('Image 1') < prompt.indexOf('Image 2'))
})

test('it says what must stay: face, hair, body, pose, background, lighting', () => {
  const prompt = buildOutfitPrompt()
  for (const word of ['face', 'skin tone', 'hair', 'body shape', 'pose', 'background', 'lighting', 'camera angle']) {
    assert.match(prompt, new RegExp(word), word)
  }
  assert.match(prompt, /only the clothes change/)
})

test("someone wearing the outfit in the photo lends only their clothes, not their face", () => {
  assert.match(buildOutfitPrompt(), /take only the clothes: ignore their face, hair, skin, body and the background/)
})

test('no invented logos or text, and the person stays dressed', () => {
  const prompt = buildOutfitPrompt()
  assert.match(prompt, /Do not add logos, brand names or text that are not clearly visible in image 2/)
  assert.match(prompt, /fully and appropriately dressed/)
})

test('nothing typed adds no "extra direction"', () => {
  for (const note of [undefined, null, '', '   ', '\n\t']) {
    assert.doesNotMatch(buildOutfitPrompt({ note }), /Extra direction/, JSON.stringify(note))
  }
  assert.doesNotMatch(buildOutfitPrompt(), /Extra direction/)
})

test('what is typed comes after the rules, and is marked as the weaker instruction', () => {
  const prompt = buildOutfitPrompt({ note: 'sleeves rolled up' })
  assert.match(prompt, /follow only where it does not conflict with the rules above: sleeves rolled up/)
  assert.ok(prompt.indexOf('sleeves rolled up') > prompt.indexOf('fully and appropriately dressed'))
})

test('a note is one line, tidied, and cut at the limit', () => {
  assert.equal(cleanOutfitNote('  roll \n the   sleeves  '), 'roll the sleeves')
  assert.equal(cleanOutfitNote('x'.repeat(500)).length, INPUT_LIMITS.outfitNote)
  assert.equal(cleanOutfitNote(undefined), '')
  assert.match(buildOutfitPrompt({ note: 'a\n\nb' }), /: a b/)
})

test('the longest note still leaves the prompt far inside what Nano Banana Pro takes', () => {
  const prompt = buildOutfitPrompt({ note: 'x'.repeat(10_000) })
  assert.ok(prompt.length < 3_000, `${prompt.length} characters`)
  assert.ok(prompt.length <= IMAGE_PROMPT_MAX)
})

test('it does not describe the influencer: the first picture does', () => {
  assert.doesNotMatch(buildOutfitPrompt(), /\b(man|woman|girl|boy|years old)\b/i)
})
