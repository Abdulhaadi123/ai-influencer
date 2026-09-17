import { useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Analytics } from '@vercel/analytics/react'
import { ThemeProvider, useTheme } from './context/theme'
import { AuthProvider, useAuth } from '../mobile/core/auth/AuthContext'
import { StoreProvider } from '../mobile/core/store'
import Nav from './components/Nav'
import Influencers from './pages/Influencers'
import Create from './pages/Create'
import Settings from './pages/Settings'
import Auth from './pages/Auth'

const FEEDBACK_FORM_URL = 'https://forms.gle/p5cBXw4sYaHPdcANA'

function FeedbackButton() {
  const { isDark } = useTheme()
  const [hover, setHover] = useState(false)

  return (
    <a
      href={FEEDBACK_FORM_URL}
      target="_blank"
      rel="noopener noreferrer"
      title="Something broke? Have an idea? Send feedback"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'fixed', bottom: 24, right: 24, zIndex: 200,
        display: 'flex', alignItems: 'center', gap: 8,
        height: 44, padding: '0 16px', borderRadius: 22,
        background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
        border: isDark ? '1px solid rgba(255,255,255,0.12)' : '1px solid rgba(0,0,0,0.08)',
        backdropFilter: 'blur(12px)',
        color: isDark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.7)',
        fontSize: 14, fontWeight: 600, textDecoration: 'none',
        cursor: 'pointer',
        boxShadow: isDark ? '0 2px 12px rgba(0,0,0,0.4)' : '0 2px 12px rgba(0,0,0,0.10)',
        transform: hover ? 'translateY(-2px)' : 'none',
        transition: 'transform 0.18s cubic-bezier(0.34,1.56,0.64,1), background 0.18s',
      }}
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
      </svg>
      Feedback
    </a>
  )
}

/**
 * Provider order is load-bearing: AuthProvider must wrap StoreProvider, because
 * the store reads the signed-in user to decide whose data to load and clears
 * itself when that user changes.
 */
export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <StoreProvider>
          <BrowserRouter>
            <Routed />
          </BrowserRouter>
        </StoreProvider>
      </AuthProvider>
    </ThemeProvider>
  )
}

/**
 * The gate.
 *
 * Signed out renders the auth page for every route rather than redirecting —
 * a redirect would lose the `?code=` on a password-reset link, which is the one
 * query parameter that has to survive.
 *
 * `initialising` gets its own state so a returning user is not shown the
 * sign-in form for the moment it takes to read the session cookie.
 */
function Routed() {
  const { isSignedIn, initialising, configError } = useAuth()

  if (configError) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'grid', placeItems: 'center', padding: 24 }}>
        <div style={{ maxWidth: 460 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: '#FF3B30', marginBottom: 8 }}>Not configured</h1>
          <p style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--text-secondary)' }}>{configError}</p>
        </div>
      </div>
    )
  }

  if (initialising) {
    return <div style={{ minHeight: '100vh', background: 'var(--bg)' }} />
  }

  if (!isSignedIn) return <Auth />

  return (
    <>
      <Nav />
      <Routes>
        <Route path="/" element={<Navigate to="/influencers" replace />} />
        <Route path="/influencers" element={<Influencers />} />
        <Route path="/create" element={<Create />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/influencers" replace />} />
      </Routes>
      <FeedbackButton />
      <Analytics />
    </>
  )
}
