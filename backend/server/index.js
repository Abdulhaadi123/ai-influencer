/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The API server.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Runs in Docker next to Postgres and the worker (docker-compose.yml), behind
 * Caddy for TLS. The app reaches it through EXPO_PUBLIC_API_BASE and nothing
 * else: it never connects to the database.
 *
 * On start it applies any pending database migrations (db/migrate.js), so
 * deploying a schema change is deploying the code.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import express from 'express'

import { migrate } from '../db/migrate.js'
import { closeDb } from '../api/_lib/db.js'
import { applyCors } from '../api/_lib/auth.js'
import { sendServerError } from '../api/_lib/errors.js'
import { emailConfigured, emailLogOnly } from '../api/_lib/email.js'

import * as account from '../api/auth/account.js'
import * as pages from '../api/auth/pages.js'
import deleteAccount from '../api/account/delete.js'
import * as influencers from '../api/influencers/index.js'
import deleteInfluencer from '../api/influencers/delete.js'
import * as generations from '../api/generations/index.js'
import deleteGeneration from '../api/generations/delete.js'
import * as jobs from '../api/jobs/index.js'
import * as settings from '../api/settings/index.js'
import uploadUrl from '../api/storage/upload-url.js'
import downloadUrl from '../api/storage/download-url.js'
import confirmUpload from '../api/storage/confirm.js'
import ingest from '../api/storage/ingest.js'
import deleteAsset from '../api/storage/delete.js'
import kie from '../api/kie.js'
import promptAssist from '../api/prompt-assist.js'

export function createApp() {
  const app = express()

  // Behind Caddy, so the client IP arrives in X-Forwarded-For. Without this the
  // rate limits would see the proxy's address and treat every user as one.
  app.set('trust proxy', 1)
  app.disable('x-powered-by')

  app.use(express.json({ limit: '10mb' }))

  app.use('/api', (req, res, next) => {
    if (applyCors(req, res)) return
    next()
  })

  /** Liveness. Deliberately says nothing about configuration. */
  app.get('/health', (_req, res) => res.status(200).json({ ok: true }))

  // ── Accounts ─────────────────────────────────────────────────────────────
  app.post('/api/auth/signup', account.signUp)
  app.post('/api/auth/login', account.signIn)
  app.post('/api/auth/refresh', account.refresh)
  app.post('/api/auth/logout', account.signOut)
  app.get('/api/auth/me', account.me)
  app.post('/api/auth/me', account.updateMe)
  app.post('/api/auth/change-password', account.changePassword)
  app.post('/api/auth/forgot-password', account.forgotPassword)
  app.post('/api/auth/resend-confirmation', account.resendConfirmation)
  app.post('/api/account/delete', deleteAccount)

  // The pages email links open. Forms post url-encoded, and only these need it.
  const form = express.urlencoded({ extended: false, limit: '10kb' })
  app.get('/auth/confirm-email', pages.confirmEmailPage)
  app.post('/auth/confirm-email', form, pages.confirmEmailSubmit)
  app.get('/auth/reset-password', pages.resetPasswordPage)
  app.post('/auth/reset-password', form, pages.resetPasswordSubmit)

  // ── Data ─────────────────────────────────────────────────────────────────
  app.get('/api/influencers', influencers.list)
  app.post('/api/influencers/create', influencers.create)
  app.post('/api/influencers/update', influencers.update)
  app.post('/api/influencers/delete', deleteInfluencer)

  app.get('/api/generations/by-asset', generations.byAsset)
  app.post('/api/generations/add', generations.add)
  app.post('/api/generations/delete', deleteGeneration)

  app.get('/api/jobs', jobs.list)
  app.get('/api/jobs/by-task', jobs.byTask)
  app.get('/api/jobs/active-count', jobs.activeCount)
  app.get('/api/jobs/changes', jobs.changes)
  app.get('/api/jobs/sync', jobs.sync)
  app.post('/api/jobs/register', jobs.register)
  app.post('/api/jobs/remove', jobs.remove)
  app.post('/api/jobs/clear-settled', jobs.clearSettled)

  app.get('/api/studio-settings', settings.getStudioSettings)
  app.post('/api/studio-settings', settings.saveStudioSettings)
  app.get('/api/creation-params', settings.getCreationParams)

  // ── Files ────────────────────────────────────────────────────────────────
  app.post('/api/storage/upload-url', uploadUrl)
  app.post('/api/storage/download-url', downloadUrl)
  app.post('/api/storage/confirm', confirmUpload)
  app.post('/api/storage/ingest', ingest)
  app.post('/api/storage/delete', deleteAsset)

  // ── Generation ───────────────────────────────────────────────────────────
  /**
   * `/api/kie/<upstream path>` — the handler reads the upstream path from
   * `__kiepath`, so it is set from the URL here.
   */
  app.all(/^\/api\/kie(\/.*)?$/, (req, res) => {
    const url = new URL(req.originalUrl, 'http://localhost')
    url.searchParams.set('__kiepath', req.params[0] || '')
    req.url = `${url.pathname}?${url.searchParams.toString()}`
    return kie(req, res)
  })
  app.all('/api/prompt-assist', promptAssist)

  app.use((req, res) => res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' }))

  // Last resort. Without it a throw returns Express's HTML error page, which
  // leaks a stack trace.
  app.use((err, _req, res, _next) => {
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'The request body is not valid JSON.', code: 'BAD_JSON' })
    }
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'The request is too large.', code: 'TOO_LARGE' })
    }
    return sendServerError(res, err, { tag: '[server] unhandled:', message: 'The server hit an unexpected error. Please try again.' })
  })

  return app
}

async function main() {
  await migrate()

  if (emailLogOnly()) {
    console.warn('[server] EMAIL_TRANSPORT=log — emails are written to this log and NOT sent. Set SendGrid before real users sign up.')
  } else if (!emailConfigured()) {
    console.warn(
      process.env.NODE_ENV === 'production'
        ? '[server] SENDGRID_API_KEY / EMAIL_FROM are not set — verification and reset emails CANNOT be sent.'
        : '[server] SendGrid is not configured — emails will be written to this log instead.',
    )
  }

  const port = Number(process.env.PORT || 8080)
  const server = createApp().listen(port, () => console.log(`[server] listening on :${port}`))

  // Finish in-flight requests before exiting, so a deploy does not cut off a
  // user mid-request. Docker sends SIGTERM and waits before SIGKILL.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      console.log(`[server] ${signal} — draining`)
      server.close(() => closeDb().finally(() => process.exit(0)))
      setTimeout(() => process.exit(1), 10_000).unref()
    })
  }
}

// Start only when run as a process (node server/index.js), so tests can import
// createApp without it listening.
const entry = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : ''
if (entry && entry === fileURLToPath(import.meta.url).toLowerCase()) {
  main().catch(e => {
    console.error('[server] could not start:', e?.message ?? e)
    process.exit(1)
  })
}
