/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The API as a long-running server.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The same endpoint files that Vercel serves, mounted under Express so they can
 * run on an ordinary Ubuntu box instead.
 *
 * ── Why the handlers are imported unchanged ──────────────────────────────────
 *
 * Vercel's Node handlers take `(req, res)` and use `res.status().json()`,
 * `res.setHeader()`, `res.send()`, `res.end()` — all of which Express provides
 * natively. So there is nothing to port: the business logic has exactly one
 * copy, and a bug fixed here is fixed on both platforms.
 *
 * That is the point. Hosting becomes a deployment decision rather than a code
 * decision, and moving between the two is changing one environment variable in
 * the app (EXPO_PUBLIC_API_BASE). The mobile app is not aware any of this
 * exists.
 *
 * ── What a server gets you that serverless does not ──────────────────────────
 *
 *   • No function timeout, so ingesting a long video is not a race.
 *   • worker.js — an always-on process that finishes jobs while the app is
 *     closed. That is the real reason to run a server; see that file.
 */

import express from 'express'

import kie from '../api/kie.js'
import promptAssist from '../api/prompt-assist.js'
import authSession from '../api/auth/session.js'
import uploadUrl from '../api/storage/upload-url.js'
import downloadUrl from '../api/storage/download-url.js'
import confirmUpload from '../api/storage/confirm.js'
import ingest from '../api/storage/ingest.js'
import deleteAsset from '../api/storage/delete.js'
import deleteInfluencer from '../api/influencers/delete.js'
import deleteGeneration from '../api/generations/delete.js'
import deleteAccount from '../api/account/delete.js'
import { sendServerError } from '../api/_lib/errors.js'

const app = express()

// Behind Caddy/nginx, so the client IP arrives in X-Forwarded-For. Without
// this the rate limiter would see the proxy's address for every request and
// throttle all users as one.
app.set('trust proxy', 1)

app.disable('x-powered-by')

// Generous because /api/storage/* carries base64 in some paths. Actual file
// bytes never come through here — uploads go straight to S3 — so this does not
// need to accommodate a video.
app.use(express.json({ limit: '10mb' }))

/**
 * Liveness, for the process manager and for uptime checks.
 * Deliberately says nothing about configuration — an unauthenticated endpoint
 * should not confirm which services are wired up.
 */
app.get('/health', (_req, res) => res.status(200).json({ ok: true }))

/**
 * `/api/kie/*` carries the upstream path in the URL, and Vercel's rewrite turns
 * it into a `__kiepath` query parameter. Express has no rewrite, so the same
 * translation happens here — the handler is untouched and still reads
 * `__kiepath` exactly as it does in production on Vercel.
 */
app.all(/^\/api\/kie(\/.*)?$/, (req, res) => {
  const upstreamPath = req.params[0] || ''
  const url = new URL(req.originalUrl, 'http://localhost')
  url.searchParams.set('__kiepath', upstreamPath)
  req.url = `${url.pathname}?${url.searchParams.toString()}`
  return kie(req, res)
})

app.all('/api/prompt-assist', promptAssist)
app.all('/api/auth/session', authSession)

app.all('/api/storage/upload-url', uploadUrl)
app.all('/api/storage/download-url', downloadUrl)
app.all('/api/storage/confirm', confirmUpload)
app.all('/api/storage/ingest', ingest)
app.all('/api/storage/delete', deleteAsset)

app.all('/api/influencers/delete', deleteInfluencer)
app.all('/api/generations/delete', deleteGeneration)

app.all('/api/account/delete', deleteAccount)

app.use((req, res) => res.status(404).json({ error: 'Not found' }))

// Last-resort handler. Without it, a throw inside a handler returns Express's
// default HTML error page — which leaks a stack trace to the client.
app.use((err, _req, res, _next) => {
  // express.json() rejects a malformed or oversized body with an error of its
  // own. Answering those with a 500 blamed the server for the request.
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'The request body is not valid JSON.', code: 'BAD_JSON' })
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'The request is too large.', code: 'TOO_LARGE' })
  }
  return sendServerError(res, err, {
    tag: '[server] unhandled:',
    message: 'The server hit an unexpected error. Please try again.',
  })
})

const port = Number(process.env.PORT || 8080)
const server = app.listen(port, () => {
  console.log(`[server] listening on :${port}`)
})

/**
 * Finish in-flight requests before exiting, so a deploy does not cut off a
 * user mid-upload. Docker sends SIGTERM and waits before SIGKILL.
 */
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[server] ${signal} — draining`)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 10_000).unref()
  })
}
