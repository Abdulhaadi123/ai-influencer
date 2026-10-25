import test from 'node:test'
import assert from 'node:assert/strict'

import { INPUT_LIMITS, ASSIST_MAX, cleanAge } from './inputLimits.js'
import { IMAGE_PROMPT_MAX } from './promptLimits.js'
import { VIDEO_MODELS, MOTION_MODELS, getVideoModel } from './videoModels.js'
import { buildVideoPrompt } from '../prompts/videoPrompt.js'
import { fitPrompt } from '../prompts/fitPrompt.js'
import { buildImagePrompts } from '../prompts/influencerPrompts.js'
import { buildInfluencerSheetPrompt, buildFeatureSheetPrompt, buildCloseUpPrompt } from '../prompts/charSheetPrompt.js'

test('cleanAge keeps digits only, drops leading zeros and stops at three digits', () => {
  assert.equal(cleanAge('27'), '27')
  assert.equal(cleanAge('2a7'), '27')
  assert.equal(cleanAge('007'), '7')
  assert.equal(cleanAge('0'), '')
  assert.equal(cleanAge(''), '')
  assert.equal(cleanAge(null), '')
  assert.equal(cleanAge(undefined), '')
  assert.equal(cleanAge('12345'), '123')
  assert.equal(cleanAge(' 3 5 '), '35')
  assert.equal(cleanAge(42), '42')
})

test('every field limit is a positive whole number', () => {
  for (const [field, limit] of Object.entries(INPUT_LIMITS)) {
    assert.ok(Number.isInteger(limit) && limit > 0, field)
  }
})

test('the app never offers more than the server keeps (backend/api/influencers/index.js TEXT_LIMITS)', () => {
  const server = { name: 100, age: 10, appearance: 4000, backstory: 4000, prompt: 12000 }
  for (const [field, ceiling] of Object.entries(server)) {
    assert.ok(INPUT_LIMITS[field] <= ceiling, `${field}: app ${INPUT_LIMITS[field]} vs server ${ceiling}`)
  }
})

test('text the assistant would rewrite never goes past what it accepts', () => {
  assert.equal(ASSIST_MAX, 2000)
  for (const field of ['appearance', 'script', 'scene']) {
    assert.ok(INPUT_LIMITS[field] <= ASSIST_MAX, field)
  }
})

// ── Against what KIE takes ───────────────────────────────────────────────────

/** `n` characters of numbered words, so that what survives a cut can be told apart. */
function words(n, tag) {
  const out = []
  let i = 0
  while (out.join(' ').length < n) out.push(`${tag}${++i}`)
  while (out.join(' ').length > n) out.pop()
  return out
}

test('a script and a scene, each as long as the app lets them be, both reach Kling 3.0 whole', () => {
  const kling = getVideoModel('kling-3.0/video')
  assert.equal(kling.maxPromptChars, 2500, 'Kling 3.0 takes 2,500 (docs.kie.ai; KIE answers "prompt cannot exceed 2500 characters")')

  const script = words(INPUT_LIMITS.script, 'S')
  const scene = words(INPUT_LIMITS.scene, 'C')
  for (const duration of [5, 10, 15]) {
    const built = buildVideoPrompt(
      { name: 'Ashley', gender: 'Female', physicalDesc: 'Mid-20s, long dark curly hair', niche: 'Fitness' },
      { dialogue: script.join(' '), scene: scene.join(' '), duration, shotMode: 'oner' },
    )
    const sent = fitPrompt(built, kling.maxPromptChars)
    assert.ok(sent.length <= kling.maxPromptChars, `${duration}s: ${sent.length} characters`)
    for (const [label, list] of [['script', script], ['scene', scene]]) {
      const last = list[list.length - 1]
      assert.match(sent, new RegExp(`\\b${last}\\b`), `${duration}s: the end of the ${label} (${last}) was cut`)
    }
  }
})

test('a description as long as the app lets it be reaches Nano Banana Pro whole, in every image prompt', () => {
  const desc = words(INPUT_LIMITS.appearance, 'd').join(' ')
  const last = `d${words(INPUT_LIMITS.appearance, 'd').length}`
  const inf = { name: 'Ashley', gender: 'Female', physicalDesc: desc, backstory: 'b'.repeat(INPUT_LIMITS.backstory) }
  const prompts = [
    ...buildImagePrompts({ gender: 'Female', description: desc, referenceImage: null }),
    ...buildImagePrompts({ gender: 'Female', description: desc, referenceImage: 'file:///r.jpg', copyAttributes: ['face', 'hair', 'outfit', 'background', 'expression'] }),
    buildInfluencerSheetPrompt(inf), buildFeatureSheetPrompt(inf), buildCloseUpPrompt(inf),
  ]
  for (const p of prompts) {
    assert.ok(p.length <= IMAGE_PROMPT_MAX, `a prompt of ${p.length} characters would be cut at ${IMAGE_PROMPT_MAX}`)
    assert.ok(p.includes(last), 'the end of the description is in the prompt')
  }
})

test("Motion Copy's scene direction fits what the Motion Control models take", () => {
  for (const m of MOTION_MODELS.filter(m => m.maxPromptChars)) {
    assert.ok(INPUT_LIMITS.sceneDirection <= m.maxPromptChars, `${m.id}: ${INPUT_LIMITS.sceneDirection} vs ${m.maxPromptChars}`)
  }
  assert.ok(MOTION_MODELS.some(m => m.maxPromptChars), 'at least one Motion Control model states its limit')
})

test('the image limit is exactly Nano Banana Pro\'s 20,000, not the 3,000 an old comment claimed', () => {
  assert.equal(IMAGE_PROMPT_MAX, 20000)
  assert.ok(VIDEO_MODELS.length > 0)
})

test("Motion Copy's scene direction is exactly what Kling Motion Control takes", () => {
  assert.equal(INPUT_LIMITS.sceneDirection, 2500)
  assert.equal(MOTION_MODELS.find(m => m.id === 'kling-3.0/motion-control').maxPromptChars, 2500)
})
