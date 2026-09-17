import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Local dev image proxy — mirrors api/img-proxy.js for Vercel production
const imgProxyPlugin = {
  name: 'img-proxy',
  configureServer(server) {
    server.middlewares.use('/api/img-proxy', async (req, res) => {
      const qs = new URLSearchParams(req.url.split('?')[1] || '')
      const url = qs.get('url')
      const name = qs.get('name') || 'image.jpg'
      if (!url) { res.writeHead(400); res.end('Missing url'); return }
      try {
        const r = await fetch(decodeURIComponent(url))
        const ct = r.headers.get('content-type') || 'image/jpeg'
        const buf = await r.arrayBuffer()
        res.writeHead(r.status, {
          'Content-Type': ct,
          'Content-Disposition': `attachment; filename="${decodeURIComponent(name)}"`,
          'Access-Control-Allow-Origin': '*',
        })
        res.end(Buffer.from(buf))
      } catch (e) {
        res.writeHead(500); res.end('Proxy error: ' + e.message)
      }
    })
  },
}

// Local dev Claude proxy — mirrors api/claude.js for Vercel production
const claudePlugin = {
  name: 'claude-proxy',
  configureServer(server) {
    server.middlewares.use('/api/claude', async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, anthropic-version, anthropic-beta')
      if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return }
      if (req.method !== 'POST') { res.writeHead(405); res.end('Method not allowed'); return }
      const apiKey = req.headers['x-api-key']
      if (!apiKey) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Missing x-api-key' } })); return }
      const chunks = []
      req.on('data', c => chunks.push(c))
      await new Promise(r => req.on('end', r))
      const body = Buffer.concat(chunks).toString()
      try {
        const upstreamHeaders = {
          'x-api-key': apiKey,
          'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
          'content-type': 'application/json',
        }
        if (req.headers['anthropic-beta']) upstreamHeaders['anthropic-beta'] = req.headers['anthropic-beta']
        const upstream = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: upstreamHeaders, body })
        const data = await upstream.json()
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(data))
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: e.message } }))
      }
    })
  },
}

// Local dev KIE.AI proxy — mirrors api/kie.js for Vercel production
const kiePlugin = {
  name: 'kie-proxy',
  configureServer(server) {
    server.middlewares.use('/api/kie', async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization')
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

      const url = new URL(req.url, 'http://localhost')
      const subPath = '/' + (url.searchParams.get('__kiepath') || '').replace(/^\/+/, '')
      url.searchParams.delete('__kiepath')
      const qs = url.searchParams.toString()

      const KIE_BASE = 'https://api.kie.ai'
      const REDPANDA_BASE = 'https://kieai.redpandaai.co'
      const base = subPath.startsWith('/api/file-') ? REDPANDA_BASE : KIE_BASE
      const target = `${base}${subPath}${qs ? `?${qs}` : ''}`

      const apiKey = process.env.KIE_API_KEY || ''
      
      const forwardHeaders = {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }

      let body = undefined
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const chunks = []
        req.on('data', c => chunks.push(c))
        await new Promise(r => req.on('end', r))
        body = Buffer.concat(chunks)
      }

      try {
        const upstream = await fetch(target, {
          method: req.method,
          headers: forwardHeaders,
          body
        })

        const buf = await upstream.arrayBuffer()
        res.writeHead(upstream.status, {
          'Content-Type': upstream.headers.get('content-type') || 'application/json',
          'Access-Control-Allow-Origin': '*'
        })
        res.end(Buffer.from(buf))
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    })
  },
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  process.env.KIE_API_KEY = env.KIE_API_KEY || ''

  return {
    plugins: [react(), imgProxyPlugin, claudePlugin, kiePlugin],

    /**
     * The shared core reads configuration from `process.env.EXPO_PUBLIC_*`,
     * because Expo inlines those names and Metro cannot parse `import.meta`.
     * Vite has no process.env at all, so the same three values are injected
     * here under the same names — one accessor in core, no platform fork.
     *
     * Only PUBLIC values may appear in this list. The anon key is public by
     * design (Row Level Security is what protects the data); the service-role
     * key, the KIE key and any AWS credential must never be defined here, or
     * they end up in the browser bundle.
     */
    define: {
      'process.env.EXPO_PUBLIC_SUPABASE_URL': JSON.stringify(env.SUPABASE_URL || ''),
      'process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY': JSON.stringify(env.SUPABASE_ANON_KEY || ''),
      // Same origin in the browser, so a relative base is correct.
      'process.env.EXPO_PUBLIC_API_BASE': JSON.stringify(''),
      'process.env.EXPO_PUBLIC_PASSWORD_RESET_REDIRECT': JSON.stringify(
        env.PASSWORD_RESET_REDIRECT || '',
      ),
    },

    server: {
      proxy: {},
    },
  }
})
