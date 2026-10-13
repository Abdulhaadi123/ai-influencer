// The sign-in screen.

import test, { beforeEach } from 'node:test'
import assert from './assert.js'

import { installDom, reset, click, type, settle, submit, text, apiError, stats } from './helpers.js'

installDom()
const { renderLogin } = await import('../views/login.js')

beforeEach(reset)

const ME = { id: 'admin-1', email: 'boss@test.example' }

/** A scripted API for the sign-in screen: `login` and `get` are functions the test supplies. */
function loginApi({ login = async () => ME, get = async () => stats() } = {}) {
  const calls = { login: [], get: [], logout: 0 }
  return {
    calls,
    async login(email, password) { calls.login.push([email, password]); return login(email, password) },
    async get(path) { calls.get.push(path); return get(path) },
    async logout() { calls.logout++ },
  }
}

function show(api, { notice = null } = {}) {
  const signedIn = []
  const container = document.createElement('div')
  document.body.append(container)
  renderLogin({ container, api, notice, onSignedIn: r => signedIn.push(r) })
  return {
    signedIn, container,
    email: container.querySelector('input[type=email]'),
    password: container.querySelector('input[id^=password]'),
    form: container.querySelector('form'),
    button: container.querySelector('button[type=submit]'),
    error: container.querySelector('[role=alert]'),
  }
}

test('the screen has a labelled email and password, a sign-in button, and puts the cursor in the email', () => {
  const v = show(loginApi())
  assert.equal(v.container.querySelector(`label[for="${v.email.id}"]`).textContent, 'Email')
  assert.equal(v.container.querySelector(`label[for="${v.password.id}"]`).textContent, 'Password')
  assert.equal(v.email.getAttribute('autocomplete'), 'username')
  assert.equal(v.password.getAttribute('autocomplete'), 'current-password')
  assert.equal(v.password.type, 'password')
  assert.equal(text(v.button), 'Sign in')
  assert.equal(document.activeElement, v.email)
  assert.ok(v.container.querySelector('h1'))
})

test('a notice (why you are here again) is shown in the alert region', () => {
  const v = show(loginApi(), { notice: 'Your session ended. Please sign in again.' })
  assert.equal(text(v.error), 'Your session ended. Please sign in again.')
  assert.equal(v.error.classList.contains('form-error-empty'), false)
  assert.equal(show(loginApi()).error.classList.contains('form-error-empty'), true, 'no notice, no gap')
})

test('empty fields are caught without asking the server', async () => {
  const api = loginApi()
  const v = show(api)
  submit(v.form)
  await settle()
  assert.equal(text(v.error), 'Enter your email and password.')
  assert.equal(api.calls.login.length, 0)

  type(v.email, '   ')
  type(v.password, 'x')
  submit(v.form)
  await settle()
  assert.equal(api.calls.login.length, 0, 'an email of spaces is empty')

  type(v.email, 'a@b.c')
  type(v.password, '')
  submit(v.form)
  await settle()
  assert.equal(api.calls.login.length, 0)
})

test('signing in: the email is trimmed, the password is not; the admin check runs; the overview is handed on', async () => {
  const api = loginApi()
  const v = show(api)
  type(v.email, '  boss@test.example  ')
  type(v.password, ' pass with spaces ')
  submit(v.form)
  await settle()

  assert.deepEqual(api.calls.login, [['boss@test.example', ' pass with spaces ']])
  assert.deepEqual(api.calls.get, ['/api/admin/stats'])
  assert.equal(v.signedIn.length, 1)
  assert.deepEqual(v.signedIn[0].user, ME)
  assert.equal(v.signedIn[0].stats.users.total, 5)
  assert.equal(v.password.value, '', 'the password is not left sitting in the field')
  assert.equal(text(v.error), '')
})

test('while signing in the button is busy and cannot be pressed again', async () => {
  let release
  const api = loginApi({ login: () => new Promise(r => { release = () => r(ME) }) })
  const v = show(api)
  type(v.email, 'a@b.c'); type(v.password, 'x')
  submit(v.form)
  assert.equal(v.button.disabled, true)
  assert.equal(text(v.button), 'Signing in…')
  release()
  await settle()
  assert.equal(api.calls.login.length, 1)
})

test('wrong credentials: the server\'s words, the button back, the cursor in the password', async () => {
  const api = loginApi({ login: async () => { throw apiError('Incorrect email or password.', 401, 'INVALID_CREDENTIALS') } })
  const v = show(api)
  type(v.email, 'a@b.c'); type(v.password, 'bad')
  submit(v.form)
  await settle()
  assert.equal(text(v.error), 'Incorrect email or password.')
  assert.equal(v.button.disabled, false)
  assert.equal(text(v.button), 'Sign in')
  assert.equal(document.activeElement, v.password)
  assert.equal(v.signedIn.length, 0)
  assert.equal(api.calls.get.length, 0, 'no admin check without a session')
})

test('a person who is not an administrator is signed straight back out, with a plain message', async () => {
  const api = loginApi({ get: async () => { throw apiError('This area is for administrators.', 403, 'NOT_ADMIN') } })
  const v = show(api)
  type(v.email, 'user@test.example'); type(v.password, 'x')
  submit(v.form)
  await settle()
  assert.equal(api.calls.logout, 1, 'the session that was just made is ended')
  assert.equal(text(v.error), 'This account is not an administrator.')
  assert.equal(v.signedIn.length, 0)
  assert.equal(v.button.disabled, false)
})

test('a suspended account, a lost connection and a server error each say so', async () => {
  for (const [error, expected] of [
    [apiError('Your account has been suspended.', 403, 'ACCOUNT_SUSPENDED'), /suspended/],
    [apiError('Could not reach the server. Check your connection and try again.', 0, 'NETWORK'), /Could not reach the server/],
    [apiError('Too many attempts. Please try again in 15 minutes.', 429, 'RATE_LIMITED'), /15 minutes/],
    [Object.assign(new Error(''), { code: 'X' }), /Could not sign in/],
  ]) {
    const v = show(loginApi({ login: async () => { throw error } }))
    type(v.email, 'a@b.c'); type(v.password, 'x')
    submit(v.form)
    await settle()
    assert.match(text(v.error), expected)
    assert.equal(v.button.disabled, false)
    reset()
  }
})

test('after a failure it can be tried again and succeed', async () => {
  let attempts = 0
  const api = loginApi({ login: async () => { if (++attempts === 1) throw apiError('Incorrect email or password.', 401, 'INVALID_CREDENTIALS'); return ME } })
  const v = show(api)
  type(v.email, 'a@b.c'); type(v.password, 'x')
  submit(v.form); await settle()
  assert.match(text(v.error), /Incorrect/)
  submit(v.form); await settle()
  assert.equal(text(v.error), '', 'the old message is cleared')
  assert.equal(v.signedIn.length, 1)
})

test('the show/hide control toggles the password field and says what it will do', () => {
  const v = show(loginApi())
  const toggle = v.container.querySelector('button[aria-pressed]')
  assert.equal(toggle.getAttribute('aria-label'), 'Show password')
  click(toggle)
  assert.equal(v.password.type, 'text')
  assert.equal(toggle.getAttribute('aria-label'), 'Hide password')
  assert.equal(toggle.getAttribute('aria-pressed'), 'true')
  click(toggle)
  assert.equal(v.password.type, 'password')
  assert.equal(toggle.getAttribute('aria-pressed'), 'false')
})

test('words from the server are text, whatever they contain', async () => {
  const v = show(loginApi({ login: async () => { throw apiError('<img src=x onerror=alert(1)>', 400, 'X') } }))
  type(v.email, 'a@b.c'); type(v.password, 'x')
  submit(v.form)
  await settle()
  assert.equal(v.container.querySelectorAll('img').length, 0)
  assert.match(text(v.error), /<img src=x/)
})
