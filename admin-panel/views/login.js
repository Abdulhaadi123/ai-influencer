/*
 * Sign in.
 *
 * Signing in is two steps: the account's password is checked, then the admin API
 * is asked for the overview. The second is what actually decides whether this
 * account may be here — a perfectly valid user who is not an administrator is signed
 * straight back out with a plain message, rather than shown an empty panel.
 */

import { h, mount, uid } from '../lib/dom.js'
import { icon } from '../lib/icons.js'
import { PANEL_NAME } from '../lib/brand.js'

/**
 * @param {object} ctx
 * @param {HTMLElement} ctx.container
 * @param {ReturnType<import('../lib/api.js').createApi>} ctx.api
 * @param {string|null} [ctx.notice]  why the person is here again ("Your session ended…")
 * @param {(result: {user: object, stats: object}) => void} ctx.onSignedIn
 */
export function renderLogin({ container, api, notice = null, onSignedIn }) {
  const emailId = uid('email')
  const passwordId = uid('password')

  const email = h('input', { class: 'control', id: emailId, type: 'email', autocomplete: 'username', required: true, spellcheck: 'false', autocapitalize: 'off' })
  const password = h('input', { class: 'control', id: passwordId, type: 'password', autocomplete: 'current-password', required: true })
  const message = h('div', { class: ['form-error', !notice && 'form-error-empty'], role: 'alert' }, notice || '')
  const submit = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Sign in')

  const reveal = h('button', {
    class: 'icon-btn field-affix', type: 'button', 'aria-label': 'Show password', 'aria-pressed': 'false',
    onclick: () => {
      const showing = password.type === 'text'
      password.type = showing ? 'password' : 'text'
      reveal.setAttribute('aria-pressed', String(!showing))
      reveal.setAttribute('aria-label', showing ? 'Show password' : 'Hide password')
      reveal.replaceChildren(icon(showing ? 'eye' : 'eye-off', { size: 18 }))
    },
  }, icon('eye', { size: 18 }))

  const setBusy = busy => {
    submit.disabled = busy
    submit.textContent = busy ? 'Signing in…' : 'Sign in'
  }
  const fail = text => {
    message.textContent = text
    message.classList.remove('form-error-empty')
  }

  const form = h('form', {
    class: 'login-card',
    novalidate: true,
    onsubmit: async event => {
      event.preventDefault()
      message.textContent = ''
      message.classList.add('form-error-empty')
      if (!email.value.trim() || !password.value) { fail('Enter your email and password.'); return }

      setBusy(true)
      try {
        const user = await api.login(email.value.trim(), password.value)
        password.value = ''
        // The overview is also how the panel learns whether this account is an admin.
        const stats = await api.get('/api/admin/stats')
        onSignedIn({ user, stats })
      } catch (e) {
        if (e.code === 'NOT_ADMIN') {
          await api.logout()
          fail('This account is not an administrator.')
        } else if (e.code === 'ACCOUNT_SUSPENDED' || e.code === 'NOT_AUTHENTICATED') {
          fail(e.message)
        } else {
          fail(e.message || 'Could not sign in. Please try again.')
        }
        setBusy(false)
        password.focus()
      }
    },
  },
  h('div', { class: 'login-brand' }, h('span', { class: 'brand-mark' }, icon('brand', { size: 20 })), h('span', { class: 'brand-name' }, PANEL_NAME), h('span', { class: 'brand-tag' }, 'Admin')),
  h('h1', { class: 'login-title' }, 'Sign in'),
  h('p', { class: 'login-sub' }, 'Administrator access only. Everything you do here is recorded.'),
  h('div', { class: 'field' }, h('label', { class: 'field-label', for: emailId }, 'Email'), email),
  h('div', { class: 'field' }, h('label', { class: 'field-label', for: passwordId }, 'Password'), h('div', { class: 'field-with-affix' }, password, reveal)),
  message,
  submit)

  mount(container, h('main', { class: 'login-page' }, form))
  email.focus()
}
