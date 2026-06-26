export const config = { runtime: 'edge' }

const KIE_BASE = 'https://api.kie.ai'
const REDPANDA_BASE = 'https://kieai.redpandaai.co'
const API_KEY  = process.env.KIE_API_KEY || ''

export default async function handler(req) {
  const origin = req.headers.get('origin') || '*'
  const corsHeaders = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, authorization',
    'Access-Control-Allow-Credentials': 'true',
  }

  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  const url = new URL(req.url)
  // __kiepath is injected by the vercel.json rewrite
  const subPath = '/' + (url.searchParams.get('__kiepath') || '').replace(/^\/+/, '')
  url.searchParams.delete('__kiepath')
  const qs = url.searchParams.toString()
  
  const base = subPath.startsWith('/api/file-') ? REDPANDA_BASE : KIE_BASE
  const target = `${base}${subPath}${qs ? `?${qs}` : ''}`

  const forward = new Headers()
  forward.set('Authorization', `Bearer ${API_KEY}`)
  forward.set('Content-Type', 'application/json')

  let body = undefined
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = req.body
  }

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: forward,
      body,
    })

    const respHeaders = new Headers(corsHeaders)
    upstream.headers.forEach((v, k) => {
      if (['content-encoding', 'transfer-encoding', 'connection'].includes(k)) return
      respHeaders.set(k, v)
    })

    return new Response(upstream.body, {
      status: upstream.status,
      headers: respHeaders,
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
}
