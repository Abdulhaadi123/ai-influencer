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
import { applyCors, requireSessionBeforeBody } from '../api/_lib/auth.js'
import { sendServerError } from '../api/_lib/errors.js'
import { guardRequestInput } from '../api/_lib/requestInput.js'
import { HttpError } from '../api/_lib/http.js'
import { emailConfigured, emailLogOnly } from '../api/_lib/email.js'

import * as account from '../api/auth/account.js'
import * as pages from '../api/auth/pages.js'
import * as oauth from '../api/auth/oauth.js'
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
import quickPreview from '../api/storage/quick-preview.js'
import deleteAsset from '../api/storage/delete.js'
import kie from '../api/kie.js'
import kieCallback, { CALLBACK_PATH, webhooksConfigured } from '../api/kie-callback.js'
import promptAssist from '../api/prompt-assist.js'
import report from '../api/reports/index.js'
import * as billing from '../api/billing/index.js'
import revenueCatWebhook, { REVENUECAT_PATH, revenueCatConfigured, sandboxAccepted } from '../api/revenuecat-webhook.js'
import { billingEnforced } from '../api/_lib/billing.js'
import { registerAdminRoutes } from '../api/admin/routes.js'
import { adminUiAvailable, adminUiDir } from '../api/admin/ui.js'
import { promoteConfiguredAdmins } from '../api/_lib/admin.js'
import { describeModeration } from '../api/_lib/moderation/config.js'

export function createApp() {
  const app = express()

  // Behind Caddy, so the client IP arrives in X-Forwarded-For. Without this the
  // rate limits would see the proxy's address and treat every user as one.
  app.set('trust proxy', 1)
  app.disable('x-powered-by')

  // Nothing the API answers is for keeping or for reading as a web page: not by a shared cache between
  // here and the app (a signed-in answer is one person's), and not by a browser guessing at its type.
  // First of all, so a refusal from the body parser carries it too. An endpoint that sets its own
  // Cache-Control (noStore, in api/_lib/http.js) replaces this one.
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    next()
  })

  // Before the body parsers and the session gate below, so that their refusals carry the CORS headers too
  // (a browser caller on an allowed origin must be able to read a 401).
  app.use('/api', (req, res, next) => {
    if (applyCors(req, res)) return
    next()
  })

  // A body is read in full before any handler — or any guard — runs, so its size limit is all that stands
  // between a caller with no session and the server's memory. Each kind of route gets what it can need:
  //   sign-in, sign-up, resets and the pages the email links open     16 KB
  //   the two webhooks (RevenueCat, KIE)                              256 KB
  //   the generation proxy, which a file can go through as base64     10 MB
  //   everything else, all of it signed in                            1 MB
  // The first parser to read a body wins (body-parser skips one already read), so the narrow routes come first.
  // Everything else under /api takes a body only from a signed-in caller, and is told so before any of it is
  // read (requireSessionBeforeBody) — otherwise the 10 MB and 1 MB limits below are open to anyone.
  app.use('/api/auth', express.json({ limit: '16kb' }))
  app.use('/auth', express.json({ limit: '16kb' }))
  app.use('/webhooks', express.json({ limit: '256kb' }))
  app.use('/api', requireSessionBeforeBody)
  app.use('/api/kie', express.json({ limit: '10mb' }))
  app.use(express.json({ limit: '1mb' }))

  // What a body or query may contain, settled once for every route: no NUL character (a 500 from the
  // database, a 400 here), nothing absurdly deep, and no lone surrogate to upset a jsonb column.
  app.use(guardRequestInput)

  /** Liveness. Deliberately says nothing about configuration. */
  app.get('/health', (_req, res) => res.status(200).json({ ok: true }))

  // ── Accounts ─────────────────────────────────────────────────────────────
  app.post('/api/auth/signup', account.signUp)
  app.post('/api/auth/login', account.signIn)
  app.post('/api/auth/oauth', oauth.oauthSignIn)
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
  app.get('/api/generations/by-influencer', generations.byInfluencer)
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
  app.post('/api/storage/quick-preview', quickPreview)
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

  // ── Reporting and administration ─────────────────────────────────────────
  app.post('/api/reports', report)

  // ── Credits ──────────────────────────────────────────────────────────────
  app.get('/api/billing/me', billing.me)
  registerAdminRoutes(app)

  /**
   * KIE says a generation finished. Outside `/api` deliberately: it carries no
   * session — KIE cannot hold one — and proves the sender with an HMAC
   * signature instead (api/kie-callback.js). Keeping it off `/api` also keeps
   * it clear of the CORS layer and of the proxy route above.
   */
  app.all(CALLBACK_PATH, kieCallback)

  /** RevenueCat reports a purchase. Same reasoning: no session, a shared secret instead (api/revenuecat-webhook.js). */
  app.all(REVENUECAT_PATH, revenueCatWebhook)

  app.use((req, res) => res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' }))

  // Last resort. Without it a throw returns Express's HTML error page, which
  // leaks a stack trace.
  app.use((err, _req, res, next) => {
    if (res.headersSent) return next(err)
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code })
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'The request body is not valid JSON.', code: 'BAD_JSON' })
    }
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'The request is too large.', code: 'TOO_LARGE' })
    }
    // Anything else the body parser refuses on the request's own account — a charset or encoding it does not
    // read, a body that stopped halfway, a length that does not add up — is the caller's doing, not ours.
    const status = err?.status ?? err?.statusCode
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      const unsupported = status === 415
      return res.status(status).json({
        error: unsupported ? 'This content type or encoding is not supported.' : 'The request could not be read.',
        code: unsupported ? 'UNSUPPORTED_MEDIA_TYPE' : 'BAD_REQUEST',
      })
    }
    return sendServerError(res, err, { tag: '[server] unhandled:', message: 'The server hit an unexpected error. Please try again.' })
  })

  return app
}

async function main() {
  await migrate()

  if (emailLogOnly()) {
    console.warn('[server] EMAIL_TRANSPORT=log — emails are written to this log and NOT sent. Configure SMTP before real users sign up.')
  } else if (!emailConfigured()) {
    console.warn(
      process.env.NODE_ENV === 'production'
        ? '[server] SMTP_HOST / SMTP_USER / SMTP_PASS are not set — verification and reset emails CANNOT be sent.'
        : '[server] SMTP is not configured — emails will be written to this log instead.',
    )
  }

  if (!webhooksConfigured()) {
    console.warn(
      '[server] KIE_WEBHOOK_SECRET / PUBLIC_BASE_URL are not both set — generation callbacks are off. ' +
      'Results are still collected, by the worker, within a minute or so.',
    )
  }

  for (const { level, text } of describeModeration()) {
    const log = level === 'info' ? console.log : level === 'warn' ? console.warn : console.error
    log(`[server] ${text}`)
  }

  console.log(
    billingEnforced()
      ? '[server] Credits are ENFORCED: a request without enough credits is refused.'
      : '[server] Credits are in shadow mode (BILLING_ENFORCED is not true): nothing is charged; the log says who would have been refused.',
  )
  if (!revenueCatConfigured()) {
    console.warn('[server] REVENUECAT_WEBHOOK_AUTH is not set — purchases cannot be credited (the webhook refuses every delivery).')
  }
  if (billingEnforced() && sandboxAccepted()) {
    // A test purchase costs its buyer nothing, so while these are credited anyone who can make one gets free credits.
    console.warn('[server] Credits are ENFORCED while REVENUECAT_ACCEPT_SANDBOX is not "false": a RevenueCat TEST purchase is credited like a real one. Set it to false before real sales.')
  }

  if (!adminUiAvailable()) {
    console.warn(`[server] The admin panel's files were not found at ${adminUiDir()} — /admin will answer 404. They live in the repository's admin-panel/ folder (README: "Admin panel").`)
  }

  const promoted = await promoteConfiguredAdmins()
  if (promoted) console.log(`[server] ${promoted} account(s) promoted to admin from ADMIN_EMAILS.`)

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
