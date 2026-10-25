// Regenerate uses what the profile says now, not only what the influencer was made from.

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildCreationParams, regenerateInputs } from './newInfluencer.js'
import { buildThreeVariationPrompts } from './prompts/systemPrompt.js'

const params = buildCreationParams({
  data: { description: 'Mid-20s, long dark curly hair', gender: 'Female', age: '26', copyAttributes: ['face'] },
  aspectRatio: '9:16',
  referenceAssetId: 'asset-1',
})

test('an appearance edited on the profile is what Regenerate describes', () => {
  const influencer = { name: 'Lena', gender: 'Female', age: '26', physicalDesc: 'Short bright red hair, green eyes', backstory: '' }
  const inputs = regenerateInputs(influencer, params)
  assert.equal(inputs.physicalDesc, 'Short bright red hair, green eyes')
  for (const prompt of buildThreeVariationPrompts(inputs, '9:16')) {
    assert.match(prompt, /Short bright red hair, green eyes/)
    assert.doesNotMatch(prompt, /long dark curly hair/)
  }
})

test('what the influencer was made from is kept: the reference image, the aspect ratio, what was copied', () => {
  const inputs = regenerateInputs({ name: 'Lena', physicalDesc: 'x' }, params)
  assert.equal(inputs.faceAssetId, 'asset-1')
  assert.equal(inputs.aspectRatio, '9:16')
  assert.deepEqual(inputs.copyAttributes, ['face'])
})

test('an empty appearance, gender or age on the profile falls back to the creation values, not to nothing', () => {
  const inputs = regenerateInputs({ name: 'Lena', physicalDesc: '   ', gender: '', age: '' }, params)
  assert.equal(inputs.physicalDesc, 'Mid-20s, long dark curly hair')
  assert.equal(inputs.gender, 'Female')
  assert.equal(inputs.age, '26')
})

test('gender, age, name and backstory edited on the profile are used too', () => {
  const inputs = regenerateInputs({ name: 'Leo', gender: 'Male', age: 31, physicalDesc: 'Tall, short beard', backstory: 'A personal trainer.' }, params)
  assert.deepEqual([inputs.name, inputs.gender, inputs.age, inputs.backstory], ['Leo', 'Male', '31', 'A personal trainer.'])
})
