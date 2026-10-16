/**
 * The integration-test stack.
 *
 * What runs for real: the Express app (server/index.js createApp), the `pg` driver,
 * PostgreSQL itself (PGlite over its wire protocol), every migration, the AWS SDK,
 * argon2, ffmpeg.
 *
 * What is stood in for, by small local servers: S3, KIE, and OpenAI. Nothing here
 * reaches the internet and no credential is used — the "keys" are placeholders
 * the stand-ins accept.
 *
 * Call startStack() once per test file (the environment is read when the app's
 * modules load, and each file runs in its own process).
 */

import http from 'node:http'
import net from 'node:net'
import { randomUUID } from 'node:crypto'

const ROOT = new URL('../../', import.meta.url).href   // file:///…/backend/

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer()
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)))
const readBody = req => new Promise(resolve => {
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => resolve(Buffer.concat(chunks)))
})

// ── Fake S3 (path-style) ─────────────────────────────────────────────────────

function fakeS3(bucket) {
  const objects = new Map()   // key → { body: Buffer, contentType }
  const log = []
  // Set `failCopy` to make the next CopyObject calls fail, the way a refusing S3 would.
  const behaviour = { failCopy: false }

  const xml = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/xml' }); res.end(body) }
  const noSuchKey = res => xml(res, 404, '<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>')

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const body = await readBody(req)
    log.push(`${req.method} ${url.pathname}${url.search}`)

    const prefix = `/${bucket}/`
    const key = url.pathname.startsWith(prefix) ? decodeURIComponent(url.pathname.slice(prefix.length)) : null

    if (key !== null && key !== '') {
      if (req.method === 'PUT' && req.headers['x-amz-copy-source']) {
        // CopyObject: the bytes are copied here, inside the store, and never pass through the caller.
        if (behaviour.failCopy) return xml(res, 500, '<?xml version="1.0" encoding="UTF-8"?><Error><Code>InternalError</Code><Message>We encountered an internal error. Please try again.</Message></Error>')
        const source = decodeURIComponent(String(req.headers['x-amz-copy-source'])).replace(/^\//, '')
        const from = objects.get(source.startsWith(`${bucket}/`) ? source.slice(bucket.length + 1) : source)
        if (!from) return noSuchKey(res)
        objects.set(key, { body: Buffer.from(from.body), contentType: from.contentType })
        return xml(res, 200, '<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>"x"</ETag><LastModified>2026-01-01T00:00:00.000Z</LastModified></CopyObjectResult>')
      }
      if (req.method === 'PUT') {
        objects.set(key, { body, contentType: req.headers['content-type'] || 'application/octet-stream' })
        res.writeHead(200, { etag: '"x"' }); return res.end()
      }
      const obj = objects.get(key)
      if (req.method === 'HEAD') {
        if (!obj) { res.writeHead(404); return res.end() }
        res.writeHead(200, { 'content-length': String(obj.body.length), 'content-type': obj.contentType }); return res.end()
      }
      if (req.method === 'GET') {
        if (!obj) return noSuchKey(res)
        res.writeHead(200, { 'content-length': String(obj.body.length), 'content-type': obj.contentType, etag: '"x"' })
        return res.end(obj.body)
      }
      if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); return res.end() }
    }

    if (url.pathname === `/${bucket}` || url.pathname === `/${bucket}/`) {
      if (req.method === 'POST' && url.searchParams.has('delete')) {
        for (const m of body.toString().matchAll(/<Key>([^<]+)<\/Key>/g)) objects.delete(m[1])
        return xml(res, 200, '<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></DeleteResult>')
      }
      if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
        const wanted = url.searchParams.get('prefix') || ''
        const keys = [...objects.keys()].filter(k => k.startsWith(wanted))
        const contents = keys.map(k => `<Contents><Key>${k}</Key><Size>${objects.get(k).body.length}</Size></Contents>`).join('')
        return xml(res, 200, `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated><KeyCount>${keys.length}</KeyCount>${contents}</ListBucketResult>`)
      }
    }
    res.writeHead(400); res.end()
  })
  return { server, objects, log, behaviour }
}

// ── Fake KIE ─────────────────────────────────────────────────────────────────

function fakeKie() {
  const state = {
    requests: [],         // every request: { method, path, body, authorization }
    tasks: new Map(),     // taskId → the `data` recordInfo answers with
    created: 0,
    createStatus: null,   // set { status, body } to make createTask fail
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const raw = await readBody(req)
    let body = null
    try { body = raw.length ? JSON.parse(raw.toString()) : null } catch { body = raw.toString() }
    state.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, authorization: req.headers.authorization })

    const json = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)) }

    if (url.pathname === '/api/v1/jobs/createTask' || url.pathname === '/api/v1/veo/generate') {
      if (state.createStatus) return json(state.createStatus.status, state.createStatus.body)
      const taskId = `task-${++state.created}`
      return json(200, { code: 200, msg: 'success', data: { taskId } })
    }
    if (url.pathname === '/api/file-base64-upload') {
      return json(200, { code: 200, data: { downloadUrl: `https://tempfile.aiquickdraw.com/uploads/${++state.created}.bin` } })
    }
    if (url.pathname === '/api/v1/jobs/recordInfo' || url.pathname === '/api/v1/veo/record-info') {
      const data = state.tasks.get(url.searchParams.get('taskId'))
      return json(200, data ? { code: 200, msg: 'success', data } : { code: 422, msg: 'not found' })
    }
    if (url.pathname === '/api/v1/chat/credit') return json(200, { code: 200, data: 12345 })
    return json(404, { code: 404 })
  })
  return { server, state }
}

// ── Fake OpenAI ──────────────────────────────────────────────────────────────

/**
 * Scripted by what the content CONTAINS, so a test says what it is submitting:
 *
 *   text   'XXX-EXPLICIT' → sexual 0.95      'XXX-BORDER' → sexual 0.6
 *          'XXX-MINOR' → sexual/minors 0.9   'XXX-GRAPHIC' → violence/graphic 0.95
 *   image  bytes containing 'IMG-EXPLICIT' / 'IMG-BORDER' do the same; and a JPEG
 *          smaller than 2500 bytes counts as explicit — that is what a frame of a
 *          flat-colour video is, which is how the video tests make a "bad" video
 *          out of a real one without needing an image decoder here.
 */
function fakeOpenAI() {
  const state = {
    requests: [],
    mode: { status: null, shape: 'per-item', delayMs: 0 },   // status: answer every request with this error
    chat: [],
    chatMode: { status: null, content: undefined },   // make the rewriting model fail, or say something specific
    inflight: 0,
    maxInflight: 0,
  }

  const empty = () => ({ sexual: 0, 'sexual/minors': 0, violence: 0, 'violence/graphic': 0, hate: 0, harassment: 0 })
  const resultFor = scores => ({
    flagged: Object.values(scores).some(v => v >= 0.5),
    categories: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, v >= 0.5])),
    category_scores: scores,
  })

  function score(item) {
    const s = empty()
    if (item.type === 'text') {
      if (item.text.includes('XXX-EXPLICIT')) s.sexual = 0.95
      if (item.text.includes('XXX-BORDER')) s.sexual = 0.6
      if (item.text.includes('XXX-MINOR')) s['sexual/minors'] = 0.9
      if (item.text.includes('XXX-GRAPHIC')) s['violence/graphic'] = 0.95
    } else if (item.type === 'image_url') {
      const bytes = Buffer.from(String(item.image_url.url).split(',')[1] || '', 'base64')
      if (bytes.includes('IMG-EXPLICIT') || (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.length < 2500 && !bytes.includes('IMG-OK'))) s.sexual = 0.95
      if (bytes.includes('IMG-BORDER')) s.sexual = 0.6
    }
    return s
  }

  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req)
    const body = raw.length ? JSON.parse(raw.toString()) : null
    const url = new URL(req.url, 'http://x')
    const json = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)) }
    // How many classifications are being waited on at once — for tests of the concurrency limits.
    state.inflight++
    state.maxInflight = Math.max(state.maxInflight, state.inflight)
    res.on('close', () => { state.inflight-- })
    if (state.mode.delayMs) await new Promise(r => setTimeout(r, state.mode.delayMs))

    if (url.pathname === '/v1/moderations') {
      state.requests.push({ authorization: req.headers.authorization, body })
      if (state.mode.status) return json(state.mode.status, { error: { message: 'scripted failure' } })
      const items = Array.isArray(body.input) ? body.input : [{ type: 'text', text: String(body.input) }]
      // The real endpoint's limit (found by calling it): more than one image in a request is refused.
      const imageCount = items.filter(i => i.type === 'image_url').length
      if (imageCount > 1) return json(400, { error: { message: `Number of images (${imageCount}) exceeds maximum of 1`, type: 'invalid_request_error', param: 'input', code: 'too_many_images' } })
      if (state.mode.shape === 'single') {
        const worst = empty()
        for (const item of items) for (const [k, v] of Object.entries(score(item))) worst[k] = Math.max(worst[k] ?? 0, v)
        return json(200, { id: 'modr-test', model: body.model, results: [resultFor(worst)] })
      }
      return json(200, { id: 'modr-test', model: body.model, results: items.map(i => resultFor(score(i))) })
    }
    if (url.pathname === '/v1/chat/completions') {
      state.chat.push(body)
      if (state.chatMode.status) return json(state.chatMode.status, { error: { message: 'scripted chat failure' } })
      const input = body.messages.at(-1).content
      return json(200, { choices: [{ message: { content: state.chatMode.content ?? `improved: ${input}` } }] })
    }
    json(404, { error: 'not found' })
  })
  return { server, state }
}

// ── The stack ────────────────────────────────────────────────────────────────

/**
 * @param {{env?: Record<string,string>}} [opts]  extra environment, applied before the app loads
 */
export async function startStack({ env = {} } = {}) {
  const { PGlite } = await import('@electric-sql/pglite')
  const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket')

  const bucket = 'test-bucket'
  const s3 = fakeS3(bucket)
  const kie = fakeKie()
  const openai = fakeOpenAI()
  const s3Port = await listen(s3.server)
  const kiePort = await listen(kie.server)
  const openaiPort = await listen(openai.server)

  const pglite = await PGlite.create()
  const pgPort = await freePort()
  const pgServer = new PGLiteSocketServer({ db: pglite, port: pgPort, host: '127.0.0.1' })
  await pgServer.start()

  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${pgPort}/postgres`,
    // One connection: PGlite serves one at a time. Nothing in the code under test
    // may hold a transaction while asking the pool for another connection, and
    // this is what would catch it (as a hang).
    DATABASE_POOL_MAX: '1',
    S3_BUCKET: bucket,
    AWS_REGION: 'us-east-2',
    AWS_ACCESS_KEY_ID: 'AKIATESTTESTTESTTEST',
    AWS_SECRET_ACCESS_KEY: 'test-secret-test-secret-test-secret-00',
    S3_ENDPOINT: `http://127.0.0.1:${s3Port}`,
    KIE_API_KEY: 'test-kie-key',
    KIE_BASE_URL: `http://127.0.0.1:${kiePort}`,
    KIE_FILE_BASE_URL: `http://127.0.0.1:${kiePort}`,
    OPENAI_API_KEY: 'test-openai-key',
    OPENAI_BASE_URL: `http://127.0.0.1:${openaiPort}/v1`,
    REQUIRE_EMAIL_CONFIRMATION: 'true',
    EMAIL_TRANSPORT: 'log',
    PUBLIC_BASE_URL: 'https://api.test.example',
    ...env,
  })

  // The app logs plenty; tests read their own output.
  const quiet = {}
  for (const level of ['log', 'warn', 'error']) { quiet[level] = console[level]; console[level] = () => {} }
  const restoreConsole = () => { for (const level of Object.keys(quiet)) console[level] = quiet[level] }

  const load = path => import(new URL(path, ROOT).href)
  const { migrate } = await load('db/migrate.js')
  await migrate({ log: () => {} })

  const db = await load('api/_lib/db.js')
  const { createApp } = await load('server/index.js')
  const sessions = await load('api/_lib/sessions.js')
  const passwords = await load('api/_lib/passwords.js')

  const appServer = createApp().listen(0, '127.0.0.1')
  await new Promise(r => appServer.once('listening', r))
  const base = `http://127.0.0.1:${appServer.address().port}`

  const stack = {
    base, bucket, s3, kie: kie.state, openai: openai.state, db, load,

    sql: (text, params) => db.query(text, params).then(r => r.rows),
    one: (text, params) => db.one(text, params),

    /** Call the real API over HTTP. */
    async api(method, path, { token, body, headers = {} } = {}) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      const text = await res.text()
      let json = null
      try { json = text ? JSON.parse(text) : null } catch { /* not JSON */ }
      return { status: res.status, body: json, text, headers: res.headers }
    },

    /** A user, confirmed and signed in, straight in the database. */
    async createUser({ email = `${randomUUID().slice(0, 8)}@test.example`, role = 'user', status = 'active', password = null } = {}) {
      const hash = await passwords.hashPassword(password || 'a-long-test-password-1')
      const row = await db.one(
        `insert into users (email, password_hash, display_name, email_confirmed_at, role, status)
         values ($1, $2, $3, now(), $4, $5) returning *`,
        [email, hash, email.split('@')[0], role, status],
      )
      const session = await sessions.createSession(row)
      return { id: row.id, email: row.email, token: session.accessToken, refreshToken: session.refreshToken, password: password || 'a-long-test-password-1' }
    },

    /**
     * A file in the fake bucket plus its asset row.
     *
     * An upload is made as the app leaves it — confirmed, and therefore sealed — unless a test
     * asks otherwise: `sealed: false` is an upload nobody confirmed (its link can still write to
     * it), and `ageMinutes` makes the row older, for an upload from before sealing existed.
     */
    async putAsset({ userId, kind = 'image', origin = 'upload', bytes, contentType, influencerId = null, moderationStatus = 'unchecked', sealed = true, ageMinutes = 0 }) {
      const id = randomUUID()
      const ext = kind === 'video' ? 'mp4' : kind === 'audio' ? 'mp3' : 'jpg'
      const key = `users/${userId}/2026/10/${id}.${ext}`
      const type = contentType || (kind === 'video' ? 'video/mp4' : kind === 'audio' ? 'audio/mpeg' : 'image/jpeg')
      s3.objects.set(key, { body: bytes, contentType: type })
      await db.query(
        `insert into assets (id, user_id, influencer_id, s3_key, kind, origin, content_type, byte_size, moderation_status, sealed_at, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, case when $10::boolean then now() else null end,
                 now() - $11::int * interval '1 minute')`,
        [id, userId, influencerId, key, kind, origin, type, bytes.length, moderationStatus, sealed, ageMinutes],
      )
      const url = `http://127.0.0.1:${s3Port}/${bucket}/${key}`   // a link into the bucket, as the app sends
      return { id, key, url }
    },

    async waitFor(fn, { timeout = 8000, every = 25, what = 'the condition' } = {}) {
      const end = Date.now() + timeout
      for (;;) {
        const value = await fn()
        if (value) return value
        if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`)
        await new Promise(r => setTimeout(r, every))
      }
    },

    /** Empty every table and reset the stand-ins, between tests. */
    async reset() {
      await db.query('truncate table users cascade')
      s3.objects.clear(); s3.log.length = 0; s3.behaviour.failCopy = false
      kie.state.requests.length = 0; kie.state.tasks.clear(); kie.state.created = 0; kie.state.createStatus = null
      openai.state.requests.length = 0; openai.state.chat.length = 0; openai.state.maxInflight = 0; Object.assign(openai.state.chatMode, { status: null, content: undefined })
      Object.assign(openai.state.mode, { status: null, shape: 'per-item', delayMs: 0 })
    },

    async stop() {
      restoreConsole()
      await new Promise(r => { appServer.closeAllConnections?.(); appServer.close(r) })
      await db.closeDb()
      await pgServer.stop().catch(() => {})
      await pglite.close().catch(() => {})
      for (const s of [s3.server, kie.server, openai.server]) { s.closeAllConnections?.(); await new Promise(r => s.close(r)) }
    },
  }
  return stack
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Bytes that sniff as a JPEG, carrying a marker the fake classifier reads. */
export const jpeg = (marker = 'IMG-OK') => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), Buffer.from('JFIF\0'), Buffer.from(marker), Buffer.alloc(64, 1)])

/** As above, but not an image at all: HTML claiming to be one. */
export const notAnImage = () => Buffer.from('<!doctype html><html><body>hi</body></html>')
