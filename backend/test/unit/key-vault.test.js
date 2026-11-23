// The vault that keeps added KIE keys (api/_lib/keyVault.js), and how a KIE answer is read as a refusal of the key
// (api/_lib/kieKeys.js refusalOf). Neither touches a database or the network.

import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { seal, unseal, vaultConfigured, fingerprintOf, hintOf, MIN_SECRET_LENGTH, VaultError } from '../../api/_lib/keyVault.js'
import { refusalOf, COOLDOWN_MS, PROBLEMS } from '../../api/_lib/kieKeys.js'

const SECRET = 'a-vault-secret-that-is-long-enough-0123456789'
let saved
beforeEach(() => { saved = process.env.KEY_VAULT_SECRET; process.env.KEY_VAULT_SECRET = SECRET })
afterEach(() => { if (saved === undefined) delete process.env.KEY_VAULT_SECRET; else process.env.KEY_VAULT_SECRET = saved })

test('a sealed value opens to what was put in, for the row it was sealed for', () => {
  const sealed = seal('0123456789abcdef0123456789abcdef', 'row-1')
  assert.match(sealed, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/)
  assert.equal(unseal(sealed, 'row-1'), '0123456789abcdef0123456789abcdef')
  assert.ok(!sealed.includes('0123456789abcdef'))
})

test('the same value sealed twice looks different, so two rows holding one key are not recognisable as such', () => {
  assert.notEqual(seal('same', 'row-1'), seal('same', 'row-1'))
})

test('a value moved to another row, altered, or opened under another secret does not open', () => {
  const sealed = seal('secret-value-1234567', 'row-1')
  assert.throws(() => unseal(sealed, 'row-2'), e => e instanceof VaultError && e.code === 'VAULT_UNREADABLE')
  const [v, nonce, tag, body] = sealed.split('.')
  // Change one character in the MIDDLE of the ciphertext. Not the last one: the sealed text is unpadded base64url, whose last
  // character holds two bits that are not data, so swapping 'A' for 'B' there (1 time in 16) changes no byte and the value still opens.
  const at = Math.floor(body.length / 2)
  const flipped = `${v}.${nonce}.${tag}.${body.slice(0, at)}${body[at] === 'A' ? 'B' : 'A'}${body.slice(at + 1)}`
  assert.notDeepEqual(Buffer.from(flipped.split('.')[3], 'base64url'), Buffer.from(body, 'base64url'), 'the test really changed a byte')
  assert.throws(() => unseal(flipped, 'row-1'), VaultError)
  assert.throws(() => unseal(`${v}.${nonce}.${tag.slice(2)}.${body}`, 'row-1'), VaultError, 'a tag of the wrong length')
  for (const junk of ['', 'v1', 'v1...', 'v2.a.b.c', null, undefined, 42, 'v1.a.b.c.d']) {
    assert.throws(() => unseal(junk, 'row-1'), VaultError, String(junk))
  }
  process.env.KEY_VAULT_SECRET = 'another-vault-secret-that-is-long-enough-99'
  assert.throws(() => unseal(sealed, 'row-1'), e => e.code === 'VAULT_UNREADABLE')
})

test('with no secret, or one that is too short, nothing is sealed or opened', () => {
  const sealed = seal('x'.repeat(20), 'row-1')
  for (const value of ['', 'short', 'x'.repeat(MIN_SECRET_LENGTH - 1)]) {
    process.env.KEY_VAULT_SECRET = value
    assert.equal(vaultConfigured(), false, value)
    assert.throws(() => seal('x', 'row-1'), e => e.code === 'VAULT_NOT_CONFIGURED')
    assert.throws(() => unseal(sealed, 'row-1'), e => e.code === 'VAULT_NOT_CONFIGURED')
  }
  process.env.KEY_VAULT_SECRET = 'x'.repeat(MIN_SECRET_LENGTH)
  assert.equal(vaultConfigured(), true)
})

test('a fingerprint is one-way and a hint shows only the end of a key', () => {
  assert.equal(fingerprintOf('abc'), fingerprintOf('abc'))
  assert.notEqual(fingerprintOf('abc'), fingerprintOf('abd'))
  assert.match(fingerprintOf('abc'), /^[0-9a-f]{64}$/)
  assert.equal(hintOf('0123456789abcdef'), '…cdef')
  assert.equal(hintOf('short'), '…', 'a key too short to show any of')
})

test('KIE\'s refusals of a KEY are told from its refusals of a request, in the status and inside a 200', () => {
  assert.equal(refusalOf(429, ''), 'rate_limited')
  assert.equal(refusalOf(200, '{"code":429,"msg":"Rate limited"}'), 'rate_limited')
  assert.equal(refusalOf(402, '<html>'), 'no_credits')
  assert.equal(refusalOf(200, '{"code":402}'), 'no_credits')
  assert.equal(refusalOf(401, 'nope'), 'rejected')
  assert.equal(refusalOf(403, ''), 'rejected')
  assert.equal(refusalOf(200, '{"code":401}'), 'rejected')
  assert.equal(refusalOf(200, '{"code":403}'), 'rejected')
  // Not the key's doing: any key would meet these too.
  for (const [status, body] of [[200, '{"code":200,"data":{"taskId":"t"}}'], [200, '{"code":422,"msg":"validation"}'], [200, '{"code":400}'],
    [500, ''], [455, '{"code":455}'], [200, 'not json'], [200, '[]'], [200, '"429"'], [200, '{"code":"429"}'], [200, '{"data":{"code":429}}'], [404, '']]) {
    assert.equal(refusalOf(status, body), null, `${status} ${body}`)
  }
})

test('every kind of refusal has a wait, short for a rate limit and longer for the ones that need a person', () => {
  assert.deepEqual([...PROBLEMS].sort(), ['no_credits', 'rate_limited', 'rejected', 'unreadable'])
  assert.ok(COOLDOWN_MS.rate_limited <= 15_000, 'KIE counts its limit over ten seconds')
  assert.ok(COOLDOWN_MS.no_credits >= 60_000 && COOLDOWN_MS.rejected >= 60_000)
})
