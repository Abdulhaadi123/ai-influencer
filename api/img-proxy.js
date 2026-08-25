// Allowlisted domains — only proxy media from known trusted sources.
// These are KIE's two CDNs: generated results are served from aiquickdraw,
// and files we upload (reference images, driving videos) from redpandaai.
// Matched by exact host or subdomain (see isSafeUrl).
const ALLOWED_HOSTS = [
  'aiquickdraw.com',  // generation results — tempfile.aiquickdraw.com
  'redpandaai.co',    // uploaded media   — tempfile./kieai.redpandaai.co
  'kie.ai',           // KIE-hosted files
]

function isSafeUrl(raw) {
  try {
    const u = new URL(decodeURIComponent(raw))
    if (u.protocol !== 'https:') return false
    return ALLOWED_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h))
  } catch { return false }
}

function safeFilename(name) {
  return (name || 'image.jpg')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 128)
}

import { rateLimit, clientIp } from '../lib/rateLimit.js'

export default async function handler(req, res) {
  const rl = rateLimit(clientIp(req.headers))
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter))
    res.status(429).send('Too many requests — slow down a moment and try again.'); return
  }

  const { url, name } = req.query
  if (!url) { res.status(400).send('Missing url'); return }
  if (!isSafeUrl(url)) { res.status(403).send('URL not allowed'); return }

  try {
    const upstream = await fetch(decodeURIComponent(url))
    if (!upstream.ok) { res.status(upstream.status).send('Upstream error'); return }

    const ct = upstream.headers.get('content-type') || 'image/jpeg'
    if (!ct.startsWith('image/') && !ct.startsWith('video/')) {
      res.status(400).send('Not an image or video'); return
    }

    const buf = await upstream.arrayBuffer()
    res.setHeader('Content-Type', ct)
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(name)}"`)
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.end(Buffer.from(buf))
  } catch (e) {
    res.status(500).send('Proxy error')
  }
}
