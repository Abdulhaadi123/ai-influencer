/**
 * Serves the admin panel's static files.
 *
 * The panel is its own folder, `admin-panel/` at the top of the repository, with its own
 * tests. It is plain files with no build step, so this server only has to hand them out.
 * Where they are: ADMIN_UI_DIR, or by default `admin-panel/` next to `backend/` — which,
 * inside the Docker image, is /admin-panel (docker-compose.yml mounts the folder there).
 *
 * A fixed list, not a static-file middleware: nothing outside these paths can be
 * requested, so there is no directory to traverse and nothing to mistake for the
 * panel. Adding a file to the panel means adding it here, deliberately.
 *
 * The page's Content-Security-Policy is what makes the panel's "nothing from the
 * server is inserted as HTML" rule enforceable rather than a promise: scripts and
 * styles may come only from this origin (no inline), it may talk only to this
 * origin, and the only other thing it may load is a file from the storage bucket,
 * when a reviewer asks to see one.
 */

import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The folder holding the panel's files: ADMIN_UI_DIR, or `admin-panel/` beside `backend/`. */
export function adminUiDir(env = process.env) {
  if (env.ADMIN_UI_DIR) return path.resolve(env.ADMIN_UI_DIR)
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../admin-panel')
}

/** Whether the panel is installed here (checked once at startup, so a missing folder is said out loud). */
export function adminUiAvailable(env = process.env) {
  return existsSync(path.join(adminUiDir(env), 'index.html'))
}

const JS = 'text/javascript; charset=utf-8'

/** Every file the panel is made of, and its type. Paths are relative to the panel's folder. */
export const PANEL_FILES = Object.freeze({
  'index.html': 'text/html; charset=utf-8',
  'app.css': 'text/css; charset=utf-8',
  'main.js': JS,
  'lib/api.js': JS,
  'lib/brand.js': JS,
  'lib/components.js': JS,
  'lib/dom.js': JS,
  'lib/format.js': JS,
  'lib/icons.js': JS,
  'lib/router.js': JS,
  // The panel's one typeface (Inter, SIL Open Font License; the licence sits beside it in fonts/OFL.txt).
  // It is served from here so every computer shows the same letters, instead of whatever the system has.
  'fonts/inter-latin.woff2': 'font/woff2',
  'views/audit.js': JS,
  'views/credits.js': JS,
  'views/jobs.js': JS,
  'views/login.js': JS,
  'views/moderation.js': JS,
  'views/overview.js': JS,
  'views/prices.js': JS,
  'views/settings.js': JS,
  'views/users.js': JS,
})

/** The URL each is served at. The page itself is at /admin and /admin/. */
const ROUTES = Object.freeze({
  '/admin': 'index.html',
  '/admin/': 'index.html',
  ...Object.fromEntries(Object.keys(PANEL_FILES).filter(f => f !== 'index.html').map(f => [`/admin/${f}`, f])),
})

export const ADMIN_UI_PATHS = Object.freeze(Object.keys(ROUTES))

/**
 * In production the files are read once and kept: they do not change while the
 * server runs. Anywhere else they are read each time, so an edit shows on reload.
 */
const cache = new Map()

async function read(file) {
  const full = path.join(adminUiDir(), file)
  if (process.env.NODE_ENV !== 'production') return fs.readFile(full)
  if (!cache.has(full)) cache.set(full, await fs.readFile(full))
  return cache.get(full)
}

/** Where a reviewed image or video may be loaded from: the bucket (and its endpoint, for S3-compatible storage). */
export function contentSecurityPolicy(env = process.env) {
  const storage = ['https://*.amazonaws.com']
  if (env.S3_ENDPOINT) {
    try { storage.push(new URL(env.S3_ENDPOINT).origin) } catch { /* a bad endpoint is the storage layer's problem */ }
  }
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    `img-src 'self' data: ${storage.join(' ')}`,
    `media-src ${storage.join(' ')}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
}

export async function serveAdminUi(req, res) {
  const file = Object.hasOwn(ROUTES, req.path) ? ROUTES[req.path] : null
  if (!file) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' })

  let body
  try {
    body = await read(file)
  } catch (e) {
    // The folder is not there (a checkout without admin-panel/): say so, instead of a bare 500.
    if (e?.code === 'ENOENT') return res.status(404).json({ error: 'The admin panel is not installed on this server', code: 'ADMIN_UI_MISSING' })
    throw e
  }

  res.set({
    'Content-Type': PANEL_FILES[file],
    'Content-Security-Policy': contentSecurityPolicy(),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    // The panel is only ever used over https (Caddy terminates TLS): a browser that has seen it once will not
    // be talked into plain http for it. Nothing else may reach into its window, and it needs no device feature.
    'Strict-Transport-Security': 'max-age=31536000',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), clipboard-read=(), display-capture=()',
    // The page and its code are never cached (an update shows on the next load); the typeface does not change.
    'Cache-Control': file.startsWith('fonts/') ? 'public, max-age=86400' : 'no-store',
  })
  res.send(body)
}
