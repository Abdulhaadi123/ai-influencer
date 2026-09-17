/**
 * Authentication for the web app — sign in, sign up, forgot, reset.
 *
 * One file rather than four routes: the forms share a skeleton, and the whole
 * screen is a mode switch on a single piece of state. Splitting it would mean
 * four copies of the same layout.
 *
 * ── The reset link ───────────────────────────────────────────────────────────
 *
 * With PKCE the email carries a single-use `code` in the query string, not the
 * tokens themselves. `detectSessionInUrl` is off in the Supabase client so that
 * code is not swallowed during module import; it is read here and exchanged
 * deliberately, which is what lets this screen tell an expired link from a
 * valid one.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { useAuth } from '../../mobile/core/auth/AuthContext'
import { exchangeRecoveryCode, validatePassword, MIN_PASSWORD_LENGTH } from '../../mobile/core/auth'

const MODES = { SIGN_IN: 'signIn', SIGN_UP: 'signUp', FORGOT: 'forgot', RESET: 'reset' }

const input = {
  width: '100%', padding: '12px 14px', borderRadius: 10,
  border: '1.5px solid var(--border)', background: 'var(--bg)',
  fontSize: 15, color: 'var(--text-primary)', boxSizing: 'border-box',
  outline: 'none', fontFamily: 'inherit',
}

const label = {
  fontSize: 12, fontWeight: 700, color: 'var(--text-tertiary)',
  textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6, display: 'block',
}

export default function Auth() {
  const { signIn, signUp, requestPasswordReset, updatePassword, signOut } = useAuth()

  // A recovery code in the URL means the user followed a reset link, so that
  // is the mode regardless of what they clicked to get here.
  const recoveryCode = useMemo(() => {
    if (typeof window === 'undefined') return null
    return new URLSearchParams(window.location.search).get('code')
  }, [])

  const [mode, setMode] = useState(recoveryCode ? MODES.RESET : MODES.SIGN_IN)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState(false)
  const [recoveryReady, setRecoveryReady] = useState(false)

  useEffect(() => {
    if (!recoveryCode) return
    let cancelled = false
    ;(async () => {
      try {
        await exchangeRecoveryCode(recoveryCode)
        if (!cancelled) setRecoveryReady(true)
        // Take the code out of the address bar so a reload or a shared link
        // cannot replay it, and so it stays out of browser history.
        window.history.replaceState({}, '', window.location.pathname)
      } catch (e) {
        if (!cancelled) setError(e?.message ?? 'That reset link is not valid.')
      }
    })()
    return () => { cancelled = true }
  }, [recoveryCode])

  const passwordProblem = password ? validatePassword(password) : null
  const mismatch = confirm.length > 0 && confirm !== password

  const submit = useCallback(async e => {
    e?.preventDefault?.()
    if (busy) return
    setBusy(true); setError(null); setNotice(null)

    try {
      if (mode === MODES.SIGN_IN) {
        await signIn({ email, password })
      } else if (mode === MODES.SIGN_UP) {
        const { needsEmailConfirmation } = await signUp({ email, password, displayName })
        if (needsEmailConfirmation) {
          setNotice(`Account created. Check ${email} for a confirmation link, then sign in.`)
          setMode(MODES.SIGN_IN)
        }
      } else if (mode === MODES.FORGOT) {
        await requestPasswordReset(email)
        setNotice('If there is an account for that address, a reset link is on its way.')
      } else if (mode === MODES.RESET) {
        await updatePassword(password)
        // The recovery session grants exactly one power. Ending it means the
        // user signs in with the new password, which also proves it took.
        await signOut()
        setNotice('Password updated. Sign in with your new password.')
        setMode(MODES.SIGN_IN)
        setPassword(''); setConfirm('')
      }
    } catch (err) {
      setError(err?.message ?? 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }, [busy, mode, email, password, displayName, signIn, signUp, requestPasswordReset, updatePassword, signOut])

  const titles = {
    [MODES.SIGN_IN]: ['Welcome back', 'Sign in to reach your influencers and gallery.'],
    [MODES.SIGN_UP]: ['Create your account', 'Everything you make is private to you.'],
    [MODES.FORGOT]: ['Reset your password', 'We will email you a link.'],
    [MODES.RESET]: ['Choose a new password', 'Pick something you have not used here before.'],
  }
  const [title, subtitle] = titles[mode]

  const canSubmit =
    mode === MODES.FORGOT ? !!email.trim()
    : mode === MODES.RESET ? recoveryReady && !!password && !passwordProblem && !mismatch
    : mode === MODES.SIGN_UP ? !!email.trim() && !!password && !passwordProblem && !mismatch
    : !!email.trim() && !!password

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <form onSubmit={submit} style={{ width: '100%', maxWidth: 420 }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.6px', color: 'var(--text-primary)', marginBottom: 8 }}>
          {title}
        </h1>
        <p style={{ fontSize: 15, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 28 }}>
          {subtitle}
        </p>

        {error ? (
          <div style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid #FF3B30', color: '#FF3B30', fontSize: 13.5, marginBottom: 16 }}>
            {error}
          </div>
        ) : null}
        {notice ? (
          <div style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid #8B5CF6', background: 'rgba(139,92,246,0.08)', color: 'var(--text-primary)', fontSize: 13.5, marginBottom: 16 }}>
            {notice}
          </div>
        ) : null}

        {mode === MODES.SIGN_UP ? (
          <div style={{ marginBottom: 16 }}>
            <label style={label}>Name</label>
            <input style={input} value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Your name" autoComplete="name" />
          </div>
        ) : null}

        {mode !== MODES.RESET ? (
          <div style={{ marginBottom: 16 }}>
            <label style={label}>Email</label>
            <input
              style={input} type="email" value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com" autoComplete="email" required
            />
          </div>
        ) : null}

        {mode !== MODES.FORGOT ? (
          <div style={{ marginBottom: 16 }}>
            <label style={label}>{mode === MODES.RESET ? 'New password' : 'Password'}</label>
            <input
              style={input} type="password" value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={mode === MODES.SIGN_IN ? 'Your password' : 'Choose a password'}
              autoComplete={mode === MODES.SIGN_IN ? 'current-password' : 'new-password'}
              disabled={mode === MODES.RESET && !recoveryReady}
              required
            />
            {passwordProblem && mode !== MODES.SIGN_IN ? (
              <div style={{ fontSize: 12, color: '#FF3B30', marginTop: 5 }}>{passwordProblem}</div>
            ) : mode !== MODES.SIGN_IN ? (
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 5 }}>
                At least {MIN_PASSWORD_LENGTH} characters, with a letter and a number.
              </div>
            ) : null}
          </div>
        ) : null}

        {mode === MODES.SIGN_UP || mode === MODES.RESET ? (
          <div style={{ marginBottom: 16 }}>
            <label style={label}>Confirm password</label>
            <input
              style={input} type="password" value={confirm}
              onChange={e => setConfirm(e.target.value)}
              placeholder="Type it again" autoComplete="new-password"
              disabled={mode === MODES.RESET && !recoveryReady}
              required
            />
            {mismatch ? <div style={{ fontSize: 12, color: '#FF3B30', marginTop: 5 }}>These do not match.</div> : null}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={!canSubmit || busy}
          style={{
            width: '100%', padding: 14, borderRadius: 12, fontSize: 15, fontWeight: 700, border: 'none',
            background: canSubmit && !busy ? 'linear-gradient(135deg,#EC4899,#8B5CF6)' : 'var(--bg-tertiary)',
            color: canSubmit && !busy ? '#fff' : 'var(--text-tertiary)',
            cursor: canSubmit && !busy ? 'pointer' : 'default', marginTop: 8,
          }}
        >
          {busy ? 'Working…' : {
            [MODES.SIGN_IN]: 'Sign in',
            [MODES.SIGN_UP]: 'Create account',
            [MODES.FORGOT]: 'Email me a link',
            [MODES.RESET]: 'Save new password',
          }[mode]}
        </button>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', marginTop: 20 }}>
          {mode === MODES.SIGN_IN ? (
            <>
              <Link onClick={() => { setMode(MODES.FORGOT); setError(null) }}>Forgot your password?</Link>
              <Link onClick={() => { setMode(MODES.SIGN_UP); setError(null) }}>No account? Create one</Link>
            </>
          ) : (
            <Link onClick={() => { setMode(MODES.SIGN_IN); setError(null) }}>Back to sign in</Link>
          )}
        </div>
      </form>
    </div>
  )
}

function Link({ onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ background: 'none', border: 'none', color: '#7C3AED', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
    >
      {children}
    </button>
  )
}
