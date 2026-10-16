/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Content moderation — what the endpoints call.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The app generates images and video of people from text and photos the user
 * supplies. Anything harmful in, or out, is the app's responsibility — to the
 * stores that distribute it and to the people it depicts. This file is where
 * that is checked, in four places:
 *
 *   screenCreateRequest   a generation request: its text, and every file it names
 *   screenBase64Upload    a file sent through the proxy straight to KIE
 *   moderateAsset         a stored file, once (uploads, and generated results)
 *   screenText            text on its own (the suggestion endpoint)
 *
 * Each REFUSES by throwing ModerationRefusal, which the endpoint turns into a
 * JSON answer with a code the app can act on and a sentence a person can read.
 * The sentence never says which rule fired or by how much — that would be a map
 * for someone searching for the edge.
 *
 * ── What a file IS comes from its bytes ──────────────────────────────────────
 *
 * Never from what the client called it. Audio is the one kind nothing can check,
 * so "this is audio" must not be something a client can simply say: an explicit
 * image uploaded with an `audio/…` path, a `data:audio/…` header, or an `audio/…`
 * content type was once let through unread, and the link KIE gave back for it was
 * then trusted by its host. Every file is sniffed (sniff.js); only what really is
 * audio skips the check, and a file that is not recognisably an image, a video or
 * audio cannot be used.
 *
 * Likewise a file is not trusted for WHERE it lives. A link into this app's bucket
 * is looked up and checked; a link to KIE's hosts is fetched and checked when it is
 * used (screenKieLink); and an upload is sealed (seal.js) so that the bytes checked
 * are the bytes the generator later receives.
 *
 * ── Before the money, never after ───────────────────────────────────────────
 *
 * Requests are checked BEFORE KIE is called, so a refused request costs
 * nothing. The classifier being unreachable refuses them too (fail-closed — see
 * config.js). Generated results are the opposite: they are already paid for, so
 * an unreachable checker never withholds one. It is stored and checked again
 * later; if it turns out to be bad it is quarantined then.
 *
 * ── Quarantine, not deletion ─────────────────────────────────────────────────
 *
 * A blocked result is hidden from its owner (no gallery entry, no download link,
 * the job shows as failed) but the file is kept, so an admin can see what the
 * checker saw and overturn it. Only a human decision deletes it.
 */

import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { one, many, transaction } from '../db.js'
import {
  BUCKET, MAX_UPLOAD_BYTES, getObjectBytes, getObjectHead, downloadObjectToFile, ObjectTooLargeError,
} from '../s3.js'
import { fetchAllowedSource, ResultError } from '../results.js'
import { SUSPENDED_MESSAGE } from '../suspension.js'
import { sealAsset, isSealed } from './seal.js'
import { moderationConfig } from './config.js'
import { classify, textItem, imageItem, ModerationUnavailableError } from './openai.js'
import { evaluate, scoresOf } from './policy.js'
import { collectInputs, classifyMediaUrl, MAX_URLS } from './inputs.js'
import { extractFrames, FramesUnavailableError, UnreadableMediaError } from './frames.js'
import { sniffMedia } from './sniff.js'
import { recordEvent, applyEnforcement, STRIKE_SOURCES, EXCERPT_CHARS } from './events.js'

// ── What a person is told ────────────────────────────────────────────────────

export const MESSAGES = Object.freeze({
  blocked: 'This request goes against our content guidelines, so it was not sent. Please change it and try again.',
  blockedFile: 'One of the files you selected cannot be used because it goes against our content guidelines.',
  unavailable: 'We could not check your content right now. Please try again in a moment.',
  unverifiable: 'One of the files you selected could not be checked, so it cannot be used. Please choose a different file.',
  notAllowed: 'One of the files you selected cannot be used. Please choose a file from your library.',
  notFound: 'One of the files you selected could not be found.',
  tooMany: 'Too many files were attached to this request.',
  notReady: 'One of the files you selected was not ready to be used. Please select it again.',
})

/** The job's message when its result is quarantined. Exact text matters: releaseAsset undoes only this one. */
export const OUTPUT_REMOVED_MESSAGE = 'This result was removed because it goes against our content guidelines.'

/** A refusal the endpoint should answer with `{ error, code }` at `status`. */
export class ModerationRefusal extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'ModerationRefusal'
    this.status = status
    this.code = code
  }
}

/** A file that can never be checked as it is (corrupt, wrong type, too large, gone). Retrying will not help. */
export class UnverifiableMediaError extends Error {
  constructor(message, cause) {
    super(message)
    this.name = 'UnverifiableMediaError'
    if (cause) this.cause = cause
  }
}

// ── Shared pieces ────────────────────────────────────────────────────────────

/**
 * What to do when something could not be checked. Closed: refuse. Open: carry on
 * unchecked, loudly. Returns the refusal to throw, or null to continue.
 */
function whenUnchecked(e, cfg, what) {
  console.error(`[moderation] could not check ${what}:`, e?.message ?? e)
  if (!cfg.failClosed) return null
  return e instanceof UnverifiableMediaError
    ? new ModerationRefusal(400, 'MEDIA_UNVERIFIABLE', MESSAGES.unverifiable)
    : new ModerationRefusal(503, 'MODERATION_UNAVAILABLE', MESSAGES.unavailable)
}

/** Whether an error means "could not be checked", as opposed to a bug. */
const isUncheckable = e =>
  e instanceof ModerationUnavailableError || e instanceof UnverifiableMediaError

async function blockedRefusal({ userId, decision, source, cfg, file }) {
  // Only a user's own submissions can suspend them — see events.js.
  if (STRIKE_SOURCES.includes(source)) {
    const { suspended } = await applyEnforcement(userId, { hardRule: decision.hardRule, config: cfg })
    if (suspended) return new ModerationRefusal(403, 'ACCOUNT_SUSPENDED', SUSPENDED_MESSAGE)
  }
  return new ModerationRefusal(400, 'CONTENT_BLOCKED', file ? MESSAGES.blockedFile : MESSAGES.blocked)
}

/**
 * Act on a decision about something that has no asset row yet (text, or a file
 * on its way to KIE): record it, and refuse if it is a block.
 */
async function settle({ user, decision, source, cfg, file = false, excerpt = null, model = null }) {
  if (decision.action === 'allow') return 'allow'

  await recordEvent({
    userId: user.id,
    source,
    action: decision.action === 'block' ? 'blocked' : 'review',
    categories: decision.hits.map(h => h.category),
    scores: scoresOf(decision),
    excerpt,
    model,
  })

  if (decision.action === 'review') return 'review'
  throw await blockedRefusal({ userId: user.id, decision, source, cfg, file })
}

// ── Text ─────────────────────────────────────────────────────────────────────

/**
 * Check a piece of text. Resolves when it may go ahead; throws ModerationRefusal
 * when it may not.
 *
 * @param {{user: {id: string}, text: string, source?: 'prompt'|'prompt_assist', model?: string|null}} args
 * @returns {Promise<'skipped'|'allow'|'review'>}
 */
export async function screenText({ user, text, source = 'prompt', model = null }) {
  const cfg = moderationConfig()
  if (!cfg.enabled) return 'skipped'

  const body = String(text ?? '').trim()
  if (!body) return 'skipped'

  let result
  try {
    result = await classify([textItem(body)], { config: cfg })
  } catch (e) {
    if (!(e instanceof ModerationUnavailableError)) throw e
    const refusal = whenUnchecked(e, cfg, source)
    if (refusal) throw refusal
    return 'skipped'
  }

  return settle({
    user, source, cfg, model,
    decision: evaluate(result, cfg.rules),
    excerpt: body.slice(0, EXCERPT_CHARS),
  })
}

// ── Files in memory or on disk ───────────────────────────────────────────────

function storageProblem(e) {
  if (e instanceof ObjectTooLargeError) return new UnverifiableMediaError('This file is too large to check.', e)
  if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return new UnverifiableMediaError('The file is missing.', e)
  return new ModerationUnavailableError('The file could not be read for checking.', { cause: e, retryable: true })
}

async function sniffFile(file) {
  const handle = await fs.open(file, 'r')
  try {
    const head = Buffer.alloc(32)
    const { bytesRead } = await handle.read(head, 0, 32, 0)
    return sniffMedia(head.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}

/** Classify an image held in memory. Its real type comes from its bytes, not from what was declared. */
async function classifyImageBytes(bytes, cfg) {
  const sniffed = sniffMedia(bytes.subarray(0, 32))
  if (sniffed?.kind !== 'image') throw new UnverifiableMediaError('The file is not a readable image.')
  if (bytes.length > cfg.maxImageBytes) throw new UnverifiableMediaError('This image is too large to check.')
  return classify([imageItem(bytes, sniffed.contentType)], { config: cfg })
}

/** Classify a video on disk by sampling frames. */
async function classifyVideoFile(file, cfg) {
  const sniffed = await sniffFile(file)
  if (sniffed?.kind !== 'video') throw new UnverifiableMediaError('The file is not a readable video.')

  let frames
  try {
    frames = await extractFrames(file, { contentType: sniffed.contentType, count: cfg.videoFrames, config: cfg })
  } catch (e) {
    if (e instanceof FramesUnavailableError) throw new ModerationUnavailableError(e.message, { cause: e, retryable: true })
    if (e instanceof UnreadableMediaError) throw new UnverifiableMediaError(e.message, e)
    throw e
  }
  return classify(frames.map(f => imageItem(f, 'image/jpeg')), { config: cfg })
}

/** Run `fn(dir)` with a scratch directory that is gone afterwards, whatever happens. */
async function withScratch(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moderation-'))
  try { return await fn(dir) } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}) }
}

// ── A stored file ────────────────────────────────────────────────────────────

const eventSourceFor = asset => (asset.origin === 'generated' ? 'output' : asset.kind === 'video' ? 'video' : 'image')

async function classifyStoredImage(asset, cfg) {
  let bytes
  try { bytes = await getObjectBytes({ key: asset.s3_key, maxBytes: cfg.maxImageBytes }) } catch (e) { throw storageProblem(e) }
  return classifyImageBytes(bytes, cfg)
}

function classifyStoredVideo(asset, cfg) {
  return withScratch(async dir => {
    const file = path.join(dir, 'video')
    try { await downloadObjectToFile({ key: asset.s3_key, file, maxBytes: MAX_UPLOAD_BYTES }) } catch (e) { throw storageProblem(e) }
    return classifyVideoFile(file, cfg)
  })
}

async function classifyStored(asset, cfg) {
  if (asset.kind === 'image') return classifyStoredImage(asset, cfg)
  if (asset.kind !== 'audio') return classifyStoredVideo(asset, cfg)

  // "Audio" is what the uploader called it when asking for the upload link, and audio is
  // the one kind nothing can check — so an image uploaded under that name used to be
  // marked clear without a single byte being read. Look at what it really is.
  let head
  try { head = await getObjectHead({ key: asset.s3_key }) } catch (e) { throw storageProblem(e) }
  const sniffed = sniffMedia(head)
  if (sniffed?.kind === 'audio') return null   // there is no audio classifier; nothing to read
  if (sniffed?.kind === 'image') return classifyStoredImage(asset, cfg)
  if (sniffed?.kind === 'video') return classifyStoredVideo(asset, cfg)
  throw new UnverifiableMediaError('The file is not a recognised audio file.')
}

/**
 * Check one stored file, once, and remember the answer.
 *
 * Compare-and-set on `unchecked`: when two requests check the same file at the
 * same time, both ask the classifier but only the one whose write lands records
 * the event and reports `newlyBlocked`, so a refusal is never counted twice.
 *
 * @param {{id, user_id, s3_key, kind, origin, moderation_status}} asset
 * @param {{cfg?: ReturnType<typeof moderationConfig>}} [opts]
 * @returns {Promise<{status: 'clear'|'blocked', newlyBlocked: boolean, decision: object|null}>}
 * @throws {ModerationUnavailableError | UnverifiableMediaError}  no verdict could be reached
 */
export async function moderateAsset(asset, { cfg = moderationConfig() } = {}) {
  if (asset.moderation_status !== 'unchecked') {
    return { status: asset.moderation_status, newlyBlocked: false, decision: null }
  }
  if (!cfg.enabled) throw new ModerationUnavailableError('Content moderation is switched off.')

  // Judged on a key that only this server can write to, so the file that is checked is the
  // file the generator later receives (seal.js). Already done for anything confirmed.
  try { asset = await sealAsset(asset) } catch (e) { throw storageProblem(e) }

  const result = await classifyStored(asset, cfg)
  const decision = result ? evaluate(result, cfg.rules) : { action: 'allow', hits: [], hardRule: false }
  const status = decision.action === 'block' ? 'blocked' : 'clear'

  const claimed = await one(
    `update assets set moderation_status = $2, moderated_at = now()
      where id = $1 and moderation_status = 'unchecked' returning id`,
    [asset.id, status],
  )
  if (!claimed) {
    const current = await one('select moderation_status from assets where id = $1', [asset.id])
    return { status: current?.moderation_status ?? status, newlyBlocked: false, decision: null }
  }

  if (decision.action !== 'allow') {
    await recordEvent({
      userId: asset.user_id,
      source: eventSourceFor(asset),
      action: decision.action === 'block' ? 'blocked' : 'review',
      categories: decision.hits.map(h => h.category),
      scores: scoresOf(decision),
      assetId: asset.id,
    })
  }
  return { status, newlyBlocked: status === 'blocked', decision }
}

const ASSET_COLUMNS = 'id, user_id, s3_key, kind, content_type, origin, moderation_status, sealed_at, created_at'

const MAX_BACKGROUND_CHECKS = 3
let backgroundChecks = 0

/**
 * Check a freshly uploaded file in the background, so the answer is waiting when
 * the file is first used. Never throws: this runs after the response was sent.
 * A block here counts as a strike like any other (the file is the user's).
 */
export async function checkUploadInBackground(assetId, userId) {
  // A burst of uploads (a user adds a dozen photos) must not turn into a dozen
  // concurrent downloads and classifications. Past the limit the check is simply
  // skipped here; the file is checked when it is first used instead.
  if (backgroundChecks >= MAX_BACKGROUND_CHECKS) return
  backgroundChecks++
  try {
    const cfg = moderationConfig()
    if (!cfg.enabled) return
    const asset = await one(`select ${ASSET_COLUMNS} from assets where id = $1 and user_id = $2`, [assetId, userId])
    if (!asset || asset.moderation_status !== 'unchecked') return

    const verdict = await moderateAsset(asset, { cfg })
    if (verdict.newlyBlocked && STRIKE_SOURCES.includes(eventSourceFor(asset))) {
      await applyEnforcement(userId, { hardRule: verdict.decision.hardRule, config: cfg })
    }
  } catch (e) {
    // Unreachable checker, unreadable file: the first use will try again.
    console.warn('[moderation] background check did not complete:', e?.message ?? e)
  } finally {
    backgroundChecks--
  }
}

// ── The files a request names ────────────────────────────────────────────────

/** KIE-hosted links one request may name. Each is a download and a check, so the number is bounded. */
const MAX_KIE_LINKS = 8

/**
 * Every file a generation request references must be one that was checked and
 * allowed — and "checked" is decided here, not by where the link points:
 *
 *   • a link into this app's bucket is looked up (and checked now if it has not been);
 *     it must be sealed, so the checked bytes are the bytes KIE fetches;
 *   • a link to KIE's own hosts is fetched and checked now (screenKieLink). Its host
 *     says who is serving it, not what it shows, and a file there can have come from
 *     somewhere that was never checked;
 *   • any other link cannot be checked and is refused.
 *
 * @param {{user: {id: string}, urls: string[], cfg: ReturnType<typeof moderationConfig>}} args
 */
async function screenReferences({ user, urls, cfg }) {
  if (urls.length > MAX_URLS) throw new ModerationRefusal(400, 'TOO_MANY_FILES', MESSAGES.tooMany)

  const keys = new Set()
  const links = new Set()
  for (const raw of urls) {
    const where = classifyMediaUrl(raw, { bucket: BUCKET, endpoint: process.env.S3_ENDPOINT || '' })
    if (where.kind === 'own') keys.add(where.key)
    else if (where.kind === 'kie') links.add(raw)
    else throw new ModerationRefusal(400, 'MEDIA_NOT_ALLOWED', MESSAGES.notAllowed)
  }
  if (links.size > MAX_KIE_LINKS) throw new ModerationRefusal(400, 'TOO_MANY_FILES', MESSAGES.tooMany)

  if (keys.size) await screenOwnFiles({ user, keys, cfg })
  await Promise.all([...links].map(url => screenKieLink({ user, url, cfg })))
}

/** The caller's own files named by a request: found, sealed, and checked. */
async function screenOwnFiles({ user, keys, cfg }) {
  // Scoped to the caller: a link to someone else's file is simply not found.
  const assets = await many(
    `select ${ASSET_COLUMNS} from assets where user_id = $1 and s3_key = any($2::text[])`,
    [user.id, [...keys]],
  )
  if (assets.length !== keys.size) throw new ModerationRefusal(400, 'MEDIA_NOT_FOUND', MESSAGES.notFound)

  // An upload nobody confirmed can still be written to through its link, and the address
  // this request names is that link's. Sealing it moves the file somewhere nobody can write,
  // but this request still holds the old address — so it cannot go ahead; the next one, with
  // the file selected again, names the sealed one. (The app confirms every upload, which
  // seals it, so this is a client that skipped the step.) A blocked file is refused below.
  const unsealed = assets.filter(a => a.moderation_status !== 'blocked' && !isSealed(a))
  if (unsealed.length) {
    await Promise.all(unsealed.map(a => sealAsset(a).catch(e => console.warn('[moderation] could not seal', a.id, e?.message ?? e))))
    throw new ModerationRefusal(409, 'MEDIA_NOT_READY', MESSAGES.notReady)
  }

  const verdicts = await Promise.all(assets.map(async asset => {
    if (asset.moderation_status === 'clear') return { asset, status: 'clear' }
    if (asset.moderation_status === 'blocked') return { asset, status: 'blocked', newlyBlocked: false }
    try {
      return { asset, ...(await moderateAsset(asset, { cfg })) }
    } catch (e) {
      if (!isUncheckable(e)) throw e
      return { asset, status: 'unchecked', error: e }
    }
  }))

  for (const v of verdicts) {
    if (v.status === 'blocked') {
      // Already blocked earlier: refuse again, no new strike. Blocked just now:
      // this is the refusal that counts, if the file is the user's own upload.
      const source = eventSourceFor(v.asset)
      if (v.newlyBlocked) throw await blockedRefusal({ userId: user.id, decision: v.decision, source, cfg, file: true })
      throw new ModerationRefusal(400, 'CONTENT_BLOCKED', MESSAGES.blockedFile)
    }
  }
  for (const v of verdicts) {
    if (v.status === 'unchecked') {
      const refusal = whenUnchecked(v.error, cfg, `file ${v.asset.id}`)
      if (refusal) throw refusal
    }
  }
}

// ── A file on KIE's hosts ────────────────────────────────────────────────────

/** A person is waiting on the request this runs in; a slow CDN must not hold it for minutes. */
const KIE_LINK_TIMEOUT_MS = 15_000

/** A file that passed, by link, so several requests naming it (or one request, three times) fetch it once. */
const LINK_VERDICT_TTL_MS = 10 * 60_000
const LINK_VERDICTS_MAX = 500
const passedLinks = new Map()      // url → when the verdict stops being reused
const checkingLinks = new Map()    // url → the check in progress

function rememberPassed(url, now = Date.now()) {
  if (passedLinks.size >= LINK_VERDICTS_MAX) passedLinks.delete(passedLinks.keys().next().value)
  passedLinks.set(url, now + LINK_VERDICT_TTL_MS)
}

/**
 * Fetch a KIE-hosted file to disk, as strictly as results.js fetches a result: https only,
 * KIE's hosts only, every redirect hop re-checked, and bounded in time and size.
 */
async function downloadLink(url, file, maxBytes) {
  let res
  try {
    res = await fetchAllowedSource(url, fetch, { timeoutMs: KIE_LINK_TIMEOUT_MS })
  } catch (e) {
    // A redirect off KIE's hosts, or too many hops: this link can never be checked.
    if (e instanceof ResultError) throw new UnverifiableMediaError('The file is not available from an allowed source.', e)
    throw new ModerationUnavailableError('The file could not be fetched for checking.', { cause: e, retryable: true })
  }

  if (!res.ok) {
    await res.body?.cancel?.().catch(() => {})
    // Gone, or not ours to read: nothing to wait for. A struggling CDN: try again.
    if (res.status === 429 || res.status >= 500) {
      throw new ModerationUnavailableError(`The file host answered HTTP ${res.status}.`, { retryable: true })
    }
    throw new UnverifiableMediaError(`The file could not be fetched (HTTP ${res.status}).`)
  }
  if (Number(res.headers.get('content-length') || 0) > maxBytes) {
    await res.body?.cancel?.().catch(() => {})
    throw new UnverifiableMediaError('This file is too large to check.')
  }
  if (!res.body) throw new UnverifiableMediaError('The file is empty.')

  let total = 0
  const cap = new Transform({
    transform(chunk, _enc, done) {
      total += chunk.length
      done(total > maxBytes ? new UnverifiableMediaError('This file is too large to check.') : null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(res.body), cap, createWriteStream(file))
  } catch (e) {
    if (e instanceof UnverifiableMediaError) throw e
    throw new ModerationUnavailableError('The file could not be read for checking.', { cause: e, retryable: true })
  }
}

/** Download, sniff, classify. @returns {Promise<{source: string, result: object|null}>}  `result` is null for audio */
function checkLink(url, cfg) {
  return withScratch(async dir => {
    const file = path.join(dir, 'file')
    await downloadLink(url, file, MAX_UPLOAD_BYTES)

    const sniffed = await sniffFile(file)
    if (sniffed?.kind === 'audio') return { source: 'audio', result: null }
    if (sniffed?.kind === 'video') return { source: 'video', result: await classifyVideoFile(file, cfg) }
    if (sniffed?.kind === 'image') {
      // Never read a large file into memory just to be told it is too large.
      if ((await fs.stat(file)).size > cfg.maxImageBytes) throw new UnverifiableMediaError('This image is too large to check.')
      return { source: 'image', result: await classifyImageBytes(await fs.readFile(file), cfg) }
    }
    throw new UnverifiableMediaError('The file is not a recognised image, video or audio file.')
  })
}

/**
 * A request names a file on KIE's hosts. Whoever wrote the link, the host says nothing about
 * what is behind it — an upload that skipped the check, a result somebody else's account
 * produced — so it is fetched and judged here, exactly as an uploaded file is, and the answer
 * is the same: refused (and a strike, for the one who named it), held for review, or allowed.
 *
 * @throws {ModerationRefusal}
 */
async function screenKieLink({ user, url, cfg }) {
  const until = passedLinks.get(url)
  if (until && until > Date.now()) return

  let pending = checkingLinks.get(url)
  if (!pending) {
    pending = checkLink(url, cfg).finally(() => checkingLinks.delete(url))
    checkingLinks.set(url, pending)
  }

  let verdict
  try {
    verdict = await pending
  } catch (e) {
    if (!isUncheckable(e)) throw e
    const refusal = whenUnchecked(e, cfg, 'a linked file')
    if (refusal) throw refusal
    return
  }

  // Audio: nothing to read it with. Everything else is judged like any other submission.
  if (verdict.result) {
    await settle({ user, source: verdict.source, cfg, file: true, decision: evaluate(verdict.result, cfg.rules) })
  }
  rememberPassed(url)
}

/**
 * Check a generation request before it is sent to KIE.
 *
 * @param {{user: {id: string}, payload: object}} args  the parsed request body
 * @throws {ModerationRefusal}
 */
export async function screenCreateRequest({ user, payload }) {
  const cfg = moderationConfig()
  if (!cfg.enabled) return

  const { text, urls } = collectInputs(payload)
  await screenText({ user, text, source: 'prompt', model: typeof payload?.model === 'string' ? payload.model : null })
  await screenReferences({ user, urls: urls.map(u => u.url), cfg })
}

// ── A file sent through the proxy to KIE ─────────────────────────────────────

/**
 * Check the body of a `/api/file-base64-upload` request before it is forwarded.
 * Audio is not checked (there is nothing to check it with); everything else must
 * be a real image or video.
 *
 * "Audio" is a fact about the BYTES. This used to skip the check when the request
 * said so — a `data:audio/…` header, or an `uploadPath` starting `audio/` — and both
 * are the client's to write: an explicit image sent that way was forwarded to KIE
 * unread, and the link KIE returned was then trusted. Neither field is consulted now.
 *
 * @param {{user: {id: string}, payload: {base64Data?: string, uploadPath?: string}}} args
 * @throws {ModerationRefusal}
 */
export async function screenBase64Upload({ user, payload }) {
  const cfg = moderationConfig()
  if (!cfg.enabled) return

  const raw = payload?.base64Data
  if (typeof raw !== 'string' || !raw) return     // nothing to check; KIE will reject it

  let verdict
  try {
    const bytes = Buffer.from(raw.replace(/^data:[^,]*,/, ''), 'base64')
    const sniffed = sniffMedia(bytes.subarray(0, 32))
    if (!sniffed) throw new UnverifiableMediaError('The file is not a recognised image, video or audio file.')
    if (sniffed.kind === 'audio') return          // really audio: nothing can read it

    verdict = {
      source: sniffed.kind === 'video' ? 'video' : 'image',
      result: sniffed.kind === 'video'
        ? await withScratch(async dir => {
          const file = path.join(dir, 'video')
          await fs.writeFile(file, bytes)
          return classifyVideoFile(file, cfg)
        })
        : await classifyImageBytes(bytes, cfg),
    }
  } catch (e) {
    if (!isUncheckable(e)) throw e
    const refusal = whenUnchecked(e, cfg, 'an upload')
    if (refusal) throw refusal
    return
  }

  await settle({ user, source: verdict.source, cfg, file: true, decision: evaluate(verdict.result, cfg.rules) })
}

// ── Results the generator produced ───────────────────────────────────────────

/**
 * Hide a blocked result from its owner: out of the gallery, and its job shows as
 * failed. The file stays, for an admin.
 */
export async function quarantineAsset(assetId, userId) {
  await transaction(async client => {
    await client.query('delete from generations where asset_id = $1 and user_id = $2', [assetId, userId])
    await client.query(
      `update generation_jobs set state = 'fail', fail_msg = $3
        where asset_id = $1 and user_id = $2 and state = 'success'`,
      [assetId, userId, OUTPUT_REMOVED_MESSAGE],
    )
  })
}

/**
 * Overturn a block (an admin decided the checker was wrong): the file is clear
 * again, back in the gallery it was taken from, and its job a success again.
 *
 * @returns {Promise<boolean>} false when the file was not blocked
 */
export async function releaseAsset(assetId) {
  return transaction(async client => {
    const { rows } = await client.query(
      `update assets set moderation_status = 'clear', moderated_at = now()
        where id = $1 and moderation_status = 'blocked'
        returning id, user_id, influencer_id, kind`,
      [assetId],
    )
    const asset = rows[0]
    if (!asset) return false

    await client.query(
      `update generation_jobs set state = 'success', fail_msg = null
        where asset_id = $1 and user_id = $2 and fail_msg = $3`,
      [asset.id, asset.user_id, OUTPUT_REMOVED_MESSAGE],
    )
    if (asset.influencer_id) {
      await client.query(
        `insert into generations (user_id, influencer_id, asset_id, kind, label)
         values ($1, $2, $3, $4,
                 coalesce((select label from generation_jobs where asset_id = $3 and user_id = $1 limit 1), 'Generation'))
         on conflict (asset_id) do nothing`,
        [asset.user_id, asset.influencer_id, asset.id, asset.kind],
      )
    }
    return true
  })
}

/**
 * Check a result that was just stored (or re-check one that could not be). Used
 * by the collectors, so it NEVER throws: a result that has been paid for is never
 * lost to a moderation failure. Anything that goes wrong leaves the file
 * `unchecked`, and the worker tries again.
 *
 * @returns {Promise<{status: 'unchecked'|'clear'|'blocked'|'missing'}>}
 */
export async function moderateGeneratedResult(userId, assetId) {
  try {
    const cfg = moderationConfig()
    if (!cfg.enabled) return { status: 'unchecked' }

    const asset = await one(`select ${ASSET_COLUMNS} from assets where id = $1 and user_id = $2`, [assetId, userId])
    if (!asset) return { status: 'missing' }

    try {
      const verdict = await moderateAsset(asset, { cfg })
      if (verdict.newlyBlocked) await quarantineAsset(asset.id, userId)
      return { status: verdict.status }
    } catch (e) {
      if (e instanceof UnverifiableMediaError) return await markUncheckable(asset)
      throw e
    }
  } catch (e) {
    if (e instanceof ModerationUnavailableError) console.warn(`[moderation] result ${assetId} left unchecked for now:`, e.message)
    else console.error(`[moderation] could not check result ${assetId}:`, e)
    return { status: 'unchecked' }
  }
}

/**
 * A result no classifier can read (a corrupt file, a type it does not know). It
 * will not become checkable by waiting, so it is let through — and put in front
 * of a person, which is the honest thing to do with what a machine cannot judge.
 */
async function markUncheckable(asset) {
  const claimed = await one(
    `update assets set moderation_status = 'clear', moderated_at = now()
      where id = $1 and moderation_status = 'unchecked' returning id`,
    [asset.id],
  )
  if (claimed) {
    await recordEvent({ userId: asset.user_id, source: eventSourceFor(asset), action: 'review', categories: ['unverifiable'], assetId: asset.id })
  }
  return { status: 'clear' }
}

/** Generated results still unchecked, oldest first — what the worker works through. */
export function listUncheckedResults({ limit = 10, maxAgeHours = 48 } = {}) {
  return many(
    `select id, user_id from assets
      where origin = 'generated' and moderation_status = 'unchecked'
        and created_at > now() - $2::int * interval '1 hour'
      order by created_at asc
      limit $1`,
    [limit, maxAgeHours],
  )
}
