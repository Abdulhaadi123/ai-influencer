/*
 * The panel's connection to the server.
 *
 * ── The session ──────────────────────────────────────────────────────────────
 *
 * Signing in returns an access token (an hour) and a refresh token. The access token lives
 * in this object's memory and nowhere else. The refresh token (and the account's email, for
 * the sidebar) is also kept in the tab's sessionStorage, so that RELOADING the page does not
 * sign anyone out: the page asks the server for a fresh access token with it (`restore`).
 * sessionStorage belongs to that one tab and is gone when the tab is closed, so closing the
 * tab still signs out; it is never localStorage, and never a cookie, so there is no cookie
 * for a forged cross-site request to ride on (which is why this needs no CSRF token). Any
 * script on the page could read it — which is why the page's policy allows no script but its
 * own and the panel never builds markup from text. The server ends an admin session twelve
 * hours after its last use, whatever the tab does.
 *
 * The access token is renewed quietly before it expires, and once more if the
 * server turns a request down for it, so a long session is not interrupted.
 *
 * ── One refresh at a time ────────────────────────────────────────────────────
 *
 * The server rotates the refresh token on every use and treats an old one coming
 * back as stolen, ending the session. Two requests that both noticed an expired
 * token and both refreshed would look exactly like that. So there is only ever one
 * refresh in flight, and every request that needs one waits for it.
 *
 * The fetch function and the clock are arguments, so all of this is tested without
 * a network.
 */

export class ApiError extends Error {
  constructor(message, status = 0, code = 'ERROR') {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

/** Renew when fewer than this many seconds are left on the token. */
const RENEW_BEFORE_SECONDS = 60

/** Where the tab keeps what survives a reload. */
export const STORAGE_KEY = 'influenza_admin_session'

export const SESSION_ENDED = 'Your session ended. Please sign in again.'

/** `?a=1&b=2` from an object, leaving out anything empty. */
export function queryString(params) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

/**
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {() => number} [opts.now]  milliseconds
 * @param {(message: string) => void} [opts.onSessionEnded]  called when the session cannot continue
 * @param {Pick<Storage, 'getItem'|'setItem'|'removeItem'>|null} [opts.storage]  the tab's sessionStorage, or nothing
 *        (then a reload signs out). Never localStorage.
 */
export function createApi({ fetchImpl = (...args) => fetch(...args), now = Date.now, onSessionEnded = () => {}, storage = null } = {}) {
  /** @type {{accessToken: string, refreshToken: string, expiresAt: number, user: object} | null} */
  let session = null
  let refreshing = null

  // Storage can be missing, full or refused (a private window): the panel works without it.
  const keep = () => {
    try { storage?.setItem(STORAGE_KEY, JSON.stringify({ refreshToken: session.refreshToken, user: { id: session.user?.id, email: session.user?.email } })) } catch { /* a reload will sign out */ }
  }
  const forget = () => { try { storage?.removeItem(STORAGE_KEY) } catch { /* nothing to do */ } }
  const saved = () => {
    try {
      const value = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null')
      return typeof value?.refreshToken === 'string' && value.refreshToken && typeof value.user?.email === 'string' ? value : null
    } catch { return null }
  }

  const setSession = issued => {
    session = {
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      expiresAt: now() + (Number(issued.expiresIn) || 3600) * 1000,
      user: issued.user,
    }
    keep()
  }

  function end(message) {
    const wasSignedIn = session !== null
    session = null
    refreshing = null
    forget()
    if (wasSignedIn) onSessionEnded(message)
  }

  async function send(method, path, { body, token, signal } = {}) {
    let res
    try {
      res = await fetchImpl(path, {
        method,
        signal,
        headers: {
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    } catch (e) {
      if (e?.name === 'AbortError') throw e
      throw new ApiError('Could not reach the server. Check your connection and try again.', 0, 'NETWORK')
    }

    let json = null
    if (res.status !== 204) {
      try { json = await res.json() } catch { /* an HTML error page from a proxy */ }
    }
    if (!res.ok) {
      throw new ApiError(
        typeof json?.error === 'string' ? json.error : `The server answered ${res.status}.`,
        res.status,
        typeof json?.code === 'string' ? json.code : `HTTP_${res.status}`,
      )
    }
    return json
  }

  /** Exchange the refresh token for a new pair — shared by everyone who needs it. */
  function refresh() {
    // (Every caller has a session: request() checks before it asks.)
    if (!refreshing) {
      const started = session
      refreshing = send('POST', '/api/auth/refresh', { body: { refreshToken: started.refreshToken } })
        .then(json => {
          // Signed out (or signed in as someone else) while this was on its way: the
          // answer belongs to a session that no longer exists, and must not revive it.
          if (session !== started) return
          if (!json?.session) throw new ApiError(SESSION_ENDED, 401, 'SESSION_EXPIRED')
          setSession(json.session)
        })
        .catch(e => {
          // Only the server saying no ends the session. No connection does not: the
          // person is still signed in, and the next request will try again.
          if (e instanceof ApiError && e.status >= 400 && e.status < 500) end(SESSION_ENDED)
          throw e
        })
        .finally(() => { refreshing = null })
    }
    return refreshing
  }

  async function request(method, path, { body, signal } = {}) {
    if (!session) throw new ApiError(SESSION_ENDED, 401, 'NOT_AUTHENTICATED')

    if (session.expiresAt - now() < RENEW_BEFORE_SECONDS * 1000) await refresh()
    if (!session) throw new ApiError(SESSION_ENDED, 401, 'NOT_AUTHENTICATED')

    try {
      return await send(method, path, { body, token: session.accessToken, signal })
    } catch (e) {
      // The token was refused although it looked fine here (the server's clock, a
      // revoked session). One renewal settles whether the session is really over.
      if (e instanceof ApiError && e.status === 401 && e.code === 'NOT_AUTHENTICATED' && session) {
        await refresh()
        if (!session) throw new ApiError(SESSION_ENDED, 401, 'NOT_AUTHENTICATED')
        try {
          return await send(method, path, { body, token: session.accessToken, signal })
        } catch (again) {
          if (again instanceof ApiError && again.status === 401 && again.code === 'NOT_AUTHENTICATED') end(SESSION_ENDED)
          throw again
        }
      }
      // A suspended administrator is signed out by the server; say so.
      if (e instanceof ApiError && e.status === 403 && e.code === 'ACCOUNT_SUSPENDED') end(e.message)
      throw e
    }
  }

  return {
    /**
     * Signs in to the PANEL: `scope: 'admin'` tells the server which place this is. Only an
     * administrator account gets a session here (an admin session, which works on /api/admin/*
     * and nowhere in the app), and an administrator is refused at the app's own sign-in.
     *
     * @returns {Promise<{id, email}>} the signed-in user
     */
    async login(email, password) {
      const json = await send('POST', '/api/auth/login', { body: { email, password, scope: 'admin' } })
      if (!json?.session?.accessToken) throw new ApiError('The server sent an unexpected answer.', 0, 'BAD_RESPONSE')
      setSession(json.session)
      return session.user
    },

    /** Whether this tab holds a session from before a reload (no request is made to find out). */
    hasSavedSession: () => session === null && saved() !== null,

    /**
     * After a reload: pick the session up again by asking the server for a fresh access token with
     * the refresh token this tab kept. Resolves to the signed-in user, or null when there is nothing
     * to pick up or the server no longer accepts it (then `onSessionEnded` says so, once). A server that
     * cannot be reached is not a "no": the person stays signed in and the next request tries again.
     */
    async restore() {
      if (session) return session.user
      const found = saved()
      if (!found) { forget(); return null }
      session = { accessToken: '', refreshToken: found.refreshToken, expiresAt: 0, user: found.user }
      try { await refresh() } catch { /* a refusal has ended the session; a dropped connection has not */ }
      return session?.user ?? null
    },

    /** Signs out on the server too, then forgets everything. Never throws. */
    async logout() {
      const current = session
      session = null
      refreshing = null
      forget()
      if (!current) return
      try {
        await send('POST', '/api/auth/logout', { body: { refreshToken: current.refreshToken }, token: current.accessToken })
      } catch { /* signing out locally is what matters */ }
    },

    get: (path, query, opts) => request('GET', `${path}${queryString(query)}`, opts),
    post: (path, body, opts) => request('POST', path, { body: body ?? {}, ...opts }),

    isSignedIn: () => session !== null,
    get user() { return session?.user ?? null },
  }
}
