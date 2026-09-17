/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The session, as React state.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * One source of truth for "who is signed in", shared by both apps. Everything
 * else — the navigation gate, the data layer, the storage layer — reads from
 * here rather than calling supabase.auth on its own, so there is never a moment
 * where one part of the UI thinks the user is signed in and another does not.
 *
 * ── Why `initialising` is separate from `loading` ────────────────────────────
 *
 * On a cold start we do not yet know whether there is a session: on native it
 * has to come out of the Keychain, on web out of an httpOnly cookie over the
 * network. Both take a moment. If the app treated "no session yet" as "signed
 * out" it would flash the sign-in screen at a signed-in user on every launch.
 *
 * So `initialising` means "still finding out" and the app should show a splash;
 * `session === null` after that means genuinely signed out.
 */

import { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react'

import { supabase, isSupabaseConfigured } from '../supabase'
import { onSessionEnded, SESSION_ENDED_MESSAGE } from '../errors'
import * as auth from './index'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [initialising, setInitialising] = useState(true)
  const [configError, setConfigError] = useState(null)

  /**
   * True between following a reset link and finishing the password change.
   *
   * A recovery session is a real session — without this flag the navigator sees
   * `isSignedIn` go true and swaps to the main app, unmounting the very screen
   * that was about to set the new password. The user lands in the app with the
   * old password still in force and no idea the reset did not happen.
   */
  const [recovering, setRecovering] = useState(false)

  // Guards every setState that follows an await, so a provider unmounted
  // mid-request cannot update state afterwards.
  /**
   * Shown on the sign-in screen after the app — not the user — ended the
   * session: the token was revoked on another device, the account was changed,
   * the refresh token expired. Without it the app just dropped them at sign-in
   * with no idea why.
   */
  const [notice, setNotice] = useState(null)
  // Whether the next SIGNED_OUT is one the user asked for, so it carries no notice.
  const userSignedOut = useRef(false)
  const sessionRef = useRef(null)
  useEffect(() => { sessionRef.current = session }, [session])

  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const user = session?.user ?? null
  const userId = user?.id ?? null

  /**
   * Load the profile row for the signed-in user.
   *
   * Best-effort on purpose: the profile is display sugar (name, avatar). If it
   * has not been created yet — the trigger runs a beat after sign-up — the app
   * still works, and the next auth event will pick it up.
   */
  const loadProfile = useCallback(async id => {
    if (!id) { setProfile(null); return }
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, email, display_name, avatar_key')
        .eq('id', id)
        .maybeSingle()

      if (!alive.current) return
      if (error) { console.warn('[auth] profile load:', error.message); return }
      setProfile(data ?? null)
    } catch (e) {
      console.warn('[auth] profile load failed:', e?.message ?? e)
    }
  }, [])

  useEffect(() => {
    if (!isSupabaseConfigured()) {
      setConfigError(
        'Supabase is not configured. Add EXPO_PUBLIC_SUPABASE_URL and ' +
        'EXPO_PUBLIC_SUPABASE_ANON_KEY, then restart the dev server.',
      )
      setInitialising(false)
      return
    }

    let unsubscribe = () => {}

    ;(async () => {
      // Subscribe BEFORE the first read. Doing it the other way round leaves a
      // window where a token refresh completes between the read and the
      // subscription, and the app never hears about it.
      unsubscribe = auth.onAuthStateChange((event, nextSession) => {
        if (!alive.current) return
        setSession(nextSession ?? null)

        // PASSWORD_RECOVERY carries a session that exists only to set a new
        // password. Flagged rather than treated as a sign-in, so the navigator
        // keeps showing the reset screen instead of dropping the user into the
        // app with their old password still working.
        if (event === 'PASSWORD_RECOVERY') { setRecovering(true); return }
        if (event === 'SIGNED_IN') {
          setNotice(null)
          // A reset link opened and then abandoned leaves `recovering` set, and a
          // normal sign-in afterwards then looked like it did nothing. A recovery
          // code arrives as PASSWORD_RECOVERY, never SIGNED_IN (auth-js
          // _exchangeCodeForSession), so this cannot end a reset in progress.
          setRecovering(false)
        }
        if (event === 'SIGNED_OUT') {
          setRecovering(false)
          if (!userSignedOut.current && sessionRef.current) setNotice(SESSION_ENDED_MESSAGE)
          userSignedOut.current = false
        }

        if (nextSession?.user?.id) loadProfile(nextSession.user.id)
        else setProfile(null)
      })

      const current = await auth.getSession()
      if (!alive.current) return

      setSession(current)
      if (current?.user?.id) await loadProfile(current.user.id)

      if (alive.current) setInitialising(false)
    })()

    return () => unsubscribe()
  }, [loadProfile])

  // ── Actions ────────────────────────────────────────────────────────────────
  //
  // Thin wrappers. State is not set here — onAuthStateChange fires for all of
  // these, and setting it in both places produces a visible double render and,
  // worse, a chance of the two disagreeing.

  const signIn = useCallback((...args) => auth.signIn(...args), [])
  const signUp = useCallback((...args) => auth.signUp(...args), [])
  const requestPasswordReset = useCallback((...args) => auth.requestPasswordReset(...args), [])
  const resendConfirmation = useCallback((...args) => auth.resendConfirmation(...args), [])
  const updatePassword = useCallback((...args) => auth.updatePassword(...args), [])
  const changePassword = useCallback((...args) => auth.changePassword(...args), [])
  const signOutEverywhere = useCallback((...args) => auth.signOutEverywhere(...args), [])

  const signOut = useCallback(async () => {
    userSignedOut.current = true
    setRecovering(false)
    await auth.signOut()
    // Cleared eagerly rather than waiting for the event: sign-out must feel
    // instant, and it must hold even if the network call failed.
    if (alive.current) { setSession(null); setProfile(null) }
  }, [])

  /**
   * Delete the account. The session is cleared here rather than by an auth
   * event, for the same reason as signOut: it must hold whatever the network
   * does, and the user it belonged to no longer exists.
   */
  const deleteAccount = useCallback(async (...args) => {
    userSignedOut.current = true
    try {
      await auth.deleteAccount(...args)
    } catch (e) {
      userSignedOut.current = false
      throw e
    }
    setRecovering(false)
    if (alive.current) { setSession(null); setProfile(null) }
  }, [])

  // Any layer that finds the session gone — an API call or a database write
  // refused as unauthenticated — ends up here: sign out, with the notice, once.
  useEffect(() => onSessionEnded(() => {
    if (!sessionRef.current) return
    setNotice(SESSION_ENDED_MESSAGE)
    signOut().catch(e => console.warn('[auth] sign-out after an ended session:', e?.message ?? e))
  }), [signOut])

  const clearNotice = useCallback(() => setNotice(null), [])

  const refreshProfile = useCallback(() => loadProfile(userId), [loadProfile, userId])

  const value = useMemo(() => ({
    session,
    user,
    userId,
    profile,
    initialising,
    configError,
    recovering,
    notice,
    clearNotice,
    // Recovery is explicitly NOT signed in: it grants exactly one power, and
    // the rest of the app must stay closed until a new password is set.
    isSignedIn: !!session && !recovering,
    signIn,
    signUp,
    signOut,
    signOutEverywhere,
    deleteAccount,
    requestPasswordReset,
    resendConfirmation,
    updatePassword,
    changePassword,
    refreshProfile,
  }), [
    session, user, userId, profile, initialising, configError, recovering, notice, clearNotice,
    signIn, signUp, signOut, signOutEverywhere, deleteAccount,
    requestPasswordReset, resendConfirmation, updatePassword, changePassword, refreshProfile,
  ])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
