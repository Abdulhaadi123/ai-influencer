// Which failure messages from the generator read as a content refusal.

import test from 'node:test'
import assert from 'node:assert/strict'

import { isProviderContentRefusal } from '../../api/_lib/moderation/providerRefusals.js'

test('the wording KIE really used is a refusal', () => {
  assert.equal(isProviderContentRefusal('The input or output was flagged as sensitive. Please try again with different inputs.'), true)
})

test('other ways of saying it are caught, in any case', () => {
  for (const m of [
    'Content policy violation', 'content moderation rejected the prompt', 'Your prompt contains sensitive content',
    'This request violates our content policy', 'NSFW content detected', 'Prohibited content', 'Inappropriate content in the image',
  ]) assert.equal(isProviderContentRefusal(m), true, m)
})

test('failures that are not about content are not refusals', () => {
  for (const m of [
    'Internal Error', 'Timed out — the generator never reported a result.', 'image download failed', 'prompt exceeds maximum length of 800 characters',
    'This generation failed.', 'The result expired before it could be saved.', '', '   ',
  ]) assert.equal(isProviderContentRefusal(m), false, m)
})

test('anything that is not text is not a refusal, and never throws', () => {
  for (const m of [null, undefined, 0, {}, [], ['flagged as sensitive'], Symbol.iterator]) assert.equal(isProviderContentRefusal(m), false)
})
