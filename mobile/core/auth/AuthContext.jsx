/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The session, as React state.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * One source of truth for "who is signed in". The navigation gate, the store
 * and the screens read from here, so there is never a moment where one part of
 * the UI thinks the user is signed in and another does not.
 *
 * ── Why `initialising` is separate from signed-out ───────────────────────────
 *
 * On a cold start the session has to come out of the Keychain, which takes a
 * moment. Treating "not read yet" as "signed out" would flash the sign-in screen
 * at every returning user on every launch.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import { isApiConfigured } from '../config/env'
import { onSessionEnded, SESSION_ENDED_MESSAGE, isNetworkFailure } from '../errors'
import * as auth from './index'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [session, setSessionState] = useState(null)
  const [initialising, setInitialising] = useState(true)
  const [configError, setConfigError] = useState(null)

  /**
   * Shown on the sign-in screen after the app — not the user — ended the
   * session: signed out elsewhere, password reset, account changed. Without it
   * people were dropped at sign-in with no idea why.
   */
  const [notice, setNotice] = useState(null)

  const sessionRef = useRef(null)
  useEffect(() => { sessionRef.current = session }, [session])

  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  useEffect(() => {
    if (!isApiConfigured()) {
      setConfigError(
        'This build is not connected to a server. Set EXPO_PUBLIC_API_BASE in mobile/.env ' +
        '(or the EAS environment variables) and rebuild.',
      )
      setInitialising(false)
      return
    }

    // Subscribe before the first read, so a change that lands in between is not missed.
    const unsubscribe = auth.onAuthStateChange((event, next) => {
      if (!alive.current) return
      setSessionState(next)
      if (event === 'SIGNED_IN') setNotice(null)
      if (event === 'SESSION_EXPIRED') setNotice(SESSION_ENDED_MESSAGE)
    })

    ;(async () => {
      const stored = await auth.getSession()
      if (!alive.current) return
      setSessionState(stored)
      setInitialising(false)

      // Check a stored session with the server in the background. A session
      // ended elsewhere clears itself (SESSION_EXPIRED); no connection just
      // leaves it as it is.
      if (stored) {
        auth.refreshUser().catch(e => {
          if (!isNetworkFailure(e)) console.warn('[auth] could not check the stored session:', e?.message ?? e)
        })
      }
    })()

    return unsubscribe
  }, [])

  // ── Actions ────────────────────────────────────────────────────────────────
  // State follows the session events these cause; nothing is set here twice.

  const signIn = useCallback((...args) => auth.signIn(...args), [])
  const signUp = useCallback((...args) => auth.signUp(...args), [])
  const signOut = useCallback(() => auth.signOut(), [])
  const deleteAccount = useCallback((...args) => auth.deleteAccount(...args), [])
  const requestPasswordReset = useCallback((...args) => auth.requestPasswordReset(...args), [])
  const resendConfirmation = useCallback((...args) => auth.resendConfirmation(...args), [])
  const changePassword = useCallback((...args) => auth.changePassword(...args), [])
  const refreshProfile = useCallback(() => auth.refreshUser(), [])

  // Any layer that finds the session gone — an API call refused as
  // unauthenticated — ends up here: sign out, with the notice, once.
  useEffect(() => onSessionEnded(() => {
    if (!sessionRef.current) return
    setNotice(SESSION_ENDED_MESSAGE)
    auth.signOut().catch(e => console.warn('[auth] sign-out after an ended session:', e?.message ?? e))
  }), [])

  const clearNotice = useCallback(() => setNotice(null), [])

  const user = session?.user ?? null

  const value = useMemo(() => ({
    session,
    user,
    userId: user?.id ?? null,
    // The shape screens have always read: profile.display_name.
    profile: user ? { id: user.id, email: user.email, display_name: user.displayName } : null,
    initialising,
    configError,
    notice,
    clearNotice,
    isSignedIn: !!session,
    signIn,
    signUp,
    signOut,
    deleteAccount,
    requestPasswordReset,
    resendConfirmation,
    changePassword,
    refreshProfile,
  }), [
    session, user, initialising, configError, notice, clearNotice,
    signIn, signUp, signOut, deleteAccount,
    requestPasswordReset, resendConfirmation, changePassword, refreshProfile,
  ])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
