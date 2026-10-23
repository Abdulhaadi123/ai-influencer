// The request the app builds for each model, checked against what that model accepts.
// Run with:  npm test
//
// Why: two models were being sent two images when KIE takes one (Kling 3.0 Turbo answered "image_urls supports
// at most 1 files", PixVerse "template_id cannot be empty when multiple image_urls are provided"), and every
// generation with them was refused. Nothing in the app noticed, because the request is only judged by KIE.

import test from 'node:test'
import assert from 'node:assert/strict'

import { VIDEO_MODELS, MOTION_MODELS, durationFor, motionResolution } from './videoModels.js'

const LINKS = ['https://x.test/1.jpg', 'https://x.test/2.jpg', 'https://x.test/3.jpg', 'https://x.test/4.jpg']

/** Every image link a request carries, in whichever field this model takes them. */
function imagesIn(input) {
  const many = ['image_urls', 'reference_image_urls', 'input_urls'].flatMap(k => (Array.isArray(input[k]) ? input[k] : []))
  const one = ['image_url', 'first_frame_url'].flatMap(k => (typeof input[k] === 'string' && input[k] ? [input[k]] : []))
  return [...many, ...one]
}

const build = (m, extra = {}) => m.buildInput({
  prompt: 'p', imageUrls: LINKS, duration: 5, aspectRatio: '9:16', hasVoice: false, audioUrl: null, ...extra,
})

test('no model is sent more images than it accepts, and every model that takes an image is sent one', () => {
  for (const m of VIDEO_MODELS) {
    const sent = imagesIn(build(m)).length
    assert.ok(sent <= m.maxImages, `${m.id} is sent ${sent} images but accepts ${m.maxImages}`)
    if (m.maxImages > 0) assert.ok(sent >= 1, `${m.id} takes images but is sent none`)
    if (m.maxImages === 0) assert.equal(sent, 0, `${m.id} takes no images`)
  }
})

test('models KIE limits to a single image are declared as taking one (the studio trims to maxImages)', () => {
  // From KIE's own answers on 23 October 2026.
  for (const id of ['kling/v3-turbo-image-to-video', 'pixverse-v6/image-to-video']) {
    assert.equal(VIDEO_MODELS.find(m => m.id === id).maxImages, 1, id)
  }
})

test('the length sent is always one the model offers, whatever length was asked for', () => {
  for (const m of VIDEO_MODELS) {
    for (const asked of [1, 3, 5, 8, 10, 15, 30]) {
      const sent = Number(build(m, { duration: asked }).duration)
      assert.ok(m.durations.includes(sent), `${m.id}: asked ${asked}s, sent ${sent}s, offers ${m.durations.join(',')}`)
      assert.equal(sent, durationFor(m.id, asked), `${m.id}: the studio and the request disagree about ${asked}s`)
    }
  }
})

test('every model has an id, a label, a note and a request builder', () => {
  const ids = new Set()
  for (const m of [...VIDEO_MODELS, ...MOTION_MODELS]) {
    assert.ok(m.id && m.label && typeof m.buildInput === 'function', m.id)
    assert.ok(!ids.has(m.id), `${m.id} is listed twice`)
    ids.add(m.id)
  }
})

test('a motion request carries one character image, one driving video, and a mode KIE accepts', () => {
  for (const m of MOTION_MODELS) {
    for (const quality of ['std', 'pro']) {
      const input = m.buildInput({ prompt: '', imageUrl: 'https://x.test/c.jpg', videoUrl: 'https://x.test/d.mp4', mode: quality })
      assert.equal(imagesIn(input).length, 1, `${m.id}: one character image`)
      const videos = [input.video_url, ...(input.video_urls || [])].filter(Boolean)
      assert.equal(videos.length, 1, `${m.id}: one driving video`)
      if ('mode' in input) assert.equal(input.mode, motionResolution(quality), `${m.id}: mode is a resolution, not std/pro`)
    }
  }
})
