import test from 'node:test'
import assert from 'node:assert/strict'

import { hexOf, appleSignInPayload, NONCE_BYTES } from './appleCredential.js'

test('hexOf writes every byte as two lower-case characters', () => {
  assert.equal(hexOf(new Uint8Array([0, 1, 15, 16, 255])), '00010f10ff')
  assert.equal(hexOf([]), '')
  assert.equal(hexOf(new Uint8Array(NONCE_BYTES)).length, NONCE_BYTES * 2)
  assert.match(hexOf(Uint8Array.from({ length: NONCE_BYTES }, (_, i) => i * 8)), /^[0-9a-f]+$/)
})

test('the payload carries the token, the nonce, the one-time code and the name', () => {
  const payload = appleSignInPayload({
    identityToken: 'header.body.signature',
    authorizationCode: 'c1234',
    fullName: { givenName: ' Ada ', familyName: 'Lovelace', middleName: 'K', nickname: null },
    email: 'ada@example.com',
  }, 'raw-nonce')
  assert.deepEqual(payload, {
    idToken: 'header.body.signature',
    nonce: 'raw-nonce',
    authorizationCode: 'c1234',
    fullName: { givenName: 'Ada', familyName: 'Lovelace' },
  })
})

test('the name is only sent when Apple gave one (it does so once, the first time)', () => {
  const base = { identityToken: 't.t.t', authorizationCode: 'c' }
  assert.equal(appleSignInPayload({ ...base, fullName: null }, 'n').fullName, null)
  assert.equal(appleSignInPayload({ ...base, fullName: { givenName: null, familyName: null } }, 'n').fullName, null)
  assert.equal(appleSignInPayload({ ...base, fullName: { givenName: '  ', familyName: '' } }, 'n').fullName, null)
  assert.deepEqual(appleSignInPayload({ ...base, fullName: { givenName: 'Ada', familyName: null } }, 'n').fullName, { givenName: 'Ada', familyName: null })
  assert.equal(appleSignInPayload(base, 'n').fullName, null, 'no name field at all')
  assert.equal(appleSignInPayload({ ...base, fullName: { givenName: 42, familyName: ['x'] } }, 'n').fullName, null, 'not text: ignored')
})

test('no authorization code is none, not an empty string', () => {
  assert.equal(appleSignInPayload({ identityToken: 't.t.t' }, 'n').authorizationCode, null)
  assert.equal(appleSignInPayload({ identityToken: 't.t.t', authorizationCode: '' }, 'n').authorizationCode, null)
})

test('no identity token is an error: the server could do nothing with it', () => {
  for (const credential of [undefined, null, {}, { identityToken: null }, { identityToken: '' }, { identityToken: 5 }]) {
    assert.throws(() => appleSignInPayload(credential, 'n'), /no identity token/)
  }
})
