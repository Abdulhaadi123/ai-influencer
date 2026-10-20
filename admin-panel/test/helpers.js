/**
 * A browser for the panel's tests: happy-dom's `window`, installed as the globals
 * the panel's code expects (`document`, `window`, `Node`, `navigator`…), plus the
 * small tools tests need — clicking, typing, waiting — and a scripted stand-in for
 * the API client.
 *
 * Call installDom() once per test file, before importing any panel module that is
 * going to build elements, and reset() between tests.
 */

import { Window } from 'happy-dom'

import { ApiError } from '../lib/api.js'

const GLOBALS = [
  'document', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent',
  'HTMLInputElement', 'HTMLSelectElement', 'HTMLFormElement', 'HTMLDialogElement', 'DocumentFragment',
]

let win = null

export function installDom({ width = 1280, height = 800, url = 'http://localhost/admin' } = {}) {
  win = new Window({ url, width, height })
  globalThis.__ADMIN_TEST__ = true
  globalThis.window = win
  for (const key of GLOBALS) globalThis[key] = win[key]

  const clipboard = { written: [], fail: false, async writeText(text) { if (this.fail) throw new Error('denied'); this.written.push(text) } }
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard, userAgent: 'test' }, configurable: true, writable: true })
  return { window: win, document: win.document, clipboard }
}

/** Empty the page and forget anything one test left behind. */
export function reset() {
  win.document.body.replaceChildren()
  win.document.body.className = ''
  win.document.documentElement.removeAttribute('data-theme')
  win.location.hash = ''
  win.localStorage.clear()
  win.sessionStorage.clear()
}

export const dom = () => win

// ── Doing things ─────────────────────────────────────────────────────────────

export const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))

/** Like settle(), but without timers — for tests that have replaced setTimeout with a fake clock. */
export async function microtasks(times = 40) {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

/** A ctx for a view, with navigation recorded rather than performed. */
export function viewContext(api, route, over = {}) {
  const navigations = []
  return {
    navigations,
    ctx: {
      api, container: document.createElement('div'), route, signal: new AbortController().signal, me: api.user,
      navigate: (hash, opts) => { navigations.push(hash); over.onNavigate?.(hash, opts) },
      refreshShell: () => { navigations.refreshed = (navigations.refreshed || 0) + 1 },
      ...over.ctx,
    },
  }
}

/** Let every pending promise chain (an awaited API call, then the render after it) finish. */
export async function settle(times = 6) {
  for (let i = 0; i < times; i++) await tick(0)
}

export function click(element) {
  if (!element) throw new Error('click: no such element')
  element.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }))
}

export function type(input, value) {
  if (!input) throw new Error('type: no such element')
  input.value = value
  input.dispatchEvent(new win.Event('input', { bubbles: true }))
}

export function change(select, value) {
  select.value = value
  select.dispatchEvent(new win.Event('change', { bubbles: true }))
}

export function press(target, key, init = {}) {
  const event = new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

export function submit(form) {
  const event = new win.Event('submit', { bubbles: true, cancelable: true })
  form.dispatchEvent(event)
  return event
}

// ── Finding things ───────────────────────────────────────────────────────────

/** The first element matching `selector` whose text contains `text`. */
export function byText(root, selector, text) {
  return [...root.querySelectorAll(selector)].find(e => e.textContent.includes(text)) ?? null
}

export const text = node => node.textContent.replace(/\s+/g, ' ').trim()

export const all = (root, selector) => [...root.querySelectorAll(selector)]

// ── A scripted API ───────────────────────────────────────────────────────────

/**
 * A stand-in for the API client. `routes` maps "METHOD /path" to a value, or to a
 * function `(input) => value` (it may throw an ApiError, or return a promise). Every
 * call is recorded in `calls`. A route nobody scripted fails loudly rather than
 * answering with something the test never asked for.
 *
 * @param {Record<string, any>} routes
 * @param {{user?: object}} [opts]
 */
export function fakeApi(routes = {}, { user = { id: 'admin-1', email: 'boss@test.example' } } = {}) {
  const calls = []
  const api = {
    calls,
    routes,
    user,
    isSignedIn: () => true,
    async get(path, query = null, opts = {}) { return answer('GET', path, query, opts) },
    async post(path, body = {}, opts = {}) { return answer('POST', path, body, opts) },
    async login() { return user },
    async logout() { calls.push({ method: 'POST', path: '/api/auth/logout' }) },
    of(method, path) { return calls.filter(c => c.method === method && c.path === path) },
  }

  async function answer(method, path, input, opts) {
    calls.push({ method, path, input, signal: opts?.signal })
    if (opts?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    const route = routes[`${method} ${path}`]
    if (route === undefined) throw new Error(`The test did not script ${method} ${path}`)
    return typeof route === 'function' ? route(input, opts) : structuredClone(route)
  }
  return api
}

export const apiError = (message, status = 400, code = 'BAD_REQUEST') => new ApiError(message, status, code)

// ── Typical data ─────────────────────────────────────────────────────────────

export const ID = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const NOW = Date.parse('2026-10-11T12:00:00Z')
export const ago = seconds => new Date(NOW - seconds * 1000).toISOString()

export const user = (n, over = {}) => ({
  id: ID(n), email: `user${n}@test.example`, displayName: `User ${n}`, role: 'user', status: 'active',
  suspendedAt: null, suspendedReason: null, emailConfirmed: true, createdAt: ago(3600 * n),
  jobs: n, kieCredits: n * 10, openEvents: 0, storageBytes: n * 1000, ...over,
})

export const event = (n, over = {}) => ({
  id: ID(100 + n), userId: ID(n), email: `user${n}@test.example`, userStatus: 'active', source: 'prompt', action: 'blocked',
  categories: ['sexual'], scores: { sexual: 0.93 }, excerpt: `excerpt ${n}`, assetId: null, assetKind: null, assetStatus: null,
  taskId: null, model: null, status: 'open', reviewNote: null, reviewedAt: null, reviewedBy: null, createdAt: ago(60 * n), ...over,
})

export const stats = (over = {}) => ({
  users: { total: 5, suspended: 1, new_7d: 2 },
  jobs: { running: 1, started24h: 7, failed24h: 1, credits24h: 203, credits7d: 300, credits30d: 400, chargeUnknown30d: 0 },
  moderation: { open: 3, openBlocked: 2, events24h: 5 },
  unpricedModels: 0,
  billingProblems30d: 0,
  ...over,
})

export const config = (over = {}) => ({
  moderation: {
    enabled: true, checkerConfigured: true, failMode: 'closed', model: 'omni-moderation-latest', strikeLimit: 5, strikeWindowDays: 30,
    suspendOnMinors: true, videoFrames: 4, thresholdsProblem: null,
    thresholds: { sexual: { block: 0.85, review: 0.5 }, 'sexual/minors': { block: 0.1 }, violence: { review: 0.8 }, harassment: false },
    ...over.moderation,
  },
  kie: { callbacksConfigured: true, nsfwChecker: true, ...over.kie },
  billing: { enforced: false, webhookConfigured: true, acceptSandbox: true, ...over.billing },
})

export const creditsSummary = (over = {}) => ({
  days: 30, enforced: false, providerCost: 650, series: [], packs: [],
  ...over,
  window: { purchased: 2000, purchases: 3, purchasers: 2, spent: 700, refunded: 20, granted: 0, adjusted: 0, clawedBack: 0, ...over.window },
  holding: { held: 1300, holders: 2, owed: 0, owing: 0, ...over.holding },
})
