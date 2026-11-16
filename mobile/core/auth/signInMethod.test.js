import test from 'node:test'
import assert from 'node:assert/strict'

import { confirmMethod, methodLabel, socialHint } from './signInMethod.js'

test('an account with a password confirms with it, whatever else is joined to it', () => {
  assert.equal(confirmMethod({ hasPassword: true, providers: ['apple', 'google'], appleAvailable: true }), 'password')
  assert.equal(confirmMethod({ hasPassword: true }), 'password')
})

test('an account with no password confirms with the provider it has', () => {
  assert.equal(confirmMethod({ hasPassword: false, providers: ['apple'], appleAvailable: true }), 'apple')
  assert.equal(confirmMethod({ hasPassword: false, providers: ['google'], appleAvailable: false }), 'google')
  assert.equal(confirmMethod({ hasPassword: false, providers: ['apple'], appleAvailable: false }), 'apple', 'the server is right about what it has, even if this phone cannot show it')
})

test('with both, the phone decides: Apple on an iPhone, Google elsewhere', () => {
  assert.equal(confirmMethod({ hasPassword: false, providers: ['google', 'apple'], appleAvailable: true }), 'apple')
  assert.equal(confirmMethod({ hasPassword: false, providers: ['apple', 'google'], appleAvailable: false }), 'google')
})

test('when nothing is known the phone decides: an iPhone has only Apple, anywhere else it was Google', () => {
  for (const providers of [undefined, null, [], 'apple', {}]) {
    assert.equal(confirmMethod({ hasPassword: false, providers, appleAvailable: true }), 'apple')
    assert.equal(confirmMethod({ hasPassword: false, providers, appleAvailable: false }), 'google')
  }
})

test('the provider is named as a person reads it', () => {
  assert.equal(methodLabel('apple'), 'Apple')
  assert.equal(methodLabel('google'), 'Google')
  assert.equal(methodLabel('password'), null)
  assert.equal(methodLabel(undefined), null)
})

test('the hint after a wrong password names only the buttons this phone shows', () => {
  assert.equal(socialHint({}), '')
  assert.equal(socialHint({ googleAvailable: false, appleAvailable: false }), '')
  assert.match(socialHint({ googleAvailable: true }), /^ Made your account with Google\? Use Continue with Google below\.$/)
  assert.match(socialHint({ appleAvailable: true }), /^ Made your account with Apple\? Use Continue with Apple below\.$/)
  assert.match(socialHint({ googleAvailable: true, appleAvailable: true }), /Google or Apple\? Use the buttons below\.$/)
})
