import { kieFetch } from '../../../platform/kieTransport'
import { IMAGE_MODEL_ID, VIDEO_MODEL_KLING, VIDEO_MODEL_VEO, MOTION_MODEL_KIE } from '../../../config/generation'
import { getVideoModel, getMotionModel } from '../../../config/videoModels'
import { compressImage } from '../../../platform/media'
import { registerJobs, syncJob } from '../../../data/jobs'
import { urlForGeneration } from '../../../data/assets'
import { replaceImageTags } from '../../../prompts/videoPrompt'
import { AppError, ERROR_CODES, generatorMessage, isSessionEnded } from '../../../errors'

/**
 * Thrown when foreground polling gives up while KIE is still working.
 *
 * This is NOT a failure and must never be shown as one. The task is alive, the
 * credits are spent, and the result will land — the app simply stopped watching.
 * Callers catch this and point the user at the Queue tab, which holds the
 * taskId and can collect the result whenever it is ready.
 */
export const STILL_RUNNING = 'STILL_RUNNING'

/**
 * The error for a request to start work that was refused.
 *
 * Two different things refuse. Our own API — the session ended, the server is
 * not configured, the connection dropped — answers with a sentence already
 * written for people, carried on `res.error`. The generator answers with a
 * numeric code, which generatorMessage() words for people. Treating the two
 * alike is how an ended session once read "the generation engine rejected our
 * key", and a misconfigured server "Image generate failed (HTTP 503)".
 */
async function refusal(res) {
  const own = res.error
  if (own && (typeof own.code === 'string' || !res.status)) return own
  const body = await res.json().catch(() => null)
  return generatorError(body?.code ?? res.status, body?.msg)
}

/** A generator answer that did not start a job. */
function generatorError(code, detail) {
  if (detail) console.warn(`[KIE] code ${code}: ${detail}`)
  return new AppError(
    code === 200 ? 'The generator did not start the job. Please try again.' : generatorMessage(code),
    { code: `GENERATOR_${code}` },
  )
}

/** Every job came back failed: say so, with the generator's reason when it gave one. */
function failedGeneration(reasons) {
  const reason = String(reasons.find(Boolean) || '').trim().slice(0, 240)
  return new AppError(
    reason
      ? `The generator could not create this: ${reason}`
      : 'The generator could not create this. Try again, or change the prompt.',
    { code: ERROR_CODES.GENERATION_FAILED },
  )
}

/**
 * Thrown BEFORE a job starts when an input it depends on is unavailable. The
 * upload helpers return null on failure, and callers used to carry on without
 * the input — generating a stranger instead of this influencer, and paying for it.
 */
function referenceError(what) {
  return new AppError(
    `The ${what} could not be prepared, so nothing was generated. Please try again.`,
    { code: ERROR_CODES.REFERENCE_FAILED },
  )
}

/**
 * Read one task's current state, normalised.
 *
 * KIE reports five states — waiting, queuing, generating, success, fail — and
 * the first three all mean "still working". The old polling only ever tested
 * for success/fail, so it could not tell a queued job from a running one, and
 * had nothing useful to show while waiting.
 *
 * A 429 comes back as its own state rather than an error, because the correct
 * response is to back off and retry, not to fail the job.
 *
 * @returns {Promise<{state:string, resultUrls:string[], failMsg:string|null,
 *                    completeTime:number|null, creditsConsumed:number|null}>}
 */
export async function fetchTaskStatus(taskId) {
  // The server asks KIE and records the answer on the job itself, so polling
  // here keeps the Queue current without the app ever writing a job's state.
  let result
  try {
    result = await syncJob(taskId)
  } catch (e) {
    if (e?.status === 429 || e?.code === 'RATE_LIMITED') return { state: 'ratelimited', resultUrls: [], failMsg: null, job: null }
    // An ended session must still end the watch; anything else is "try again later".
    if (isSessionEnded(e)) throw e
    return { state: 'unknown', resultUrls: [], failMsg: e?.message ?? null, job: null }
  }

  const { status, job } = result
  return {
    state: status?.state || 'unknown',
    resultUrls: status?.resultUrls || [],
    failMsg: status?.failMsg || null,
    completeTime: status?.completeTime || null,
    job,
  }
}

/**
 * Refresh every taskId given and fold the answers into the queue.
 *
 * Serial, with a gap between calls: KIE allows 20 new generations per 10
 * seconds and answers 429 when pushed, so a queue with a dozen rows must not
 * fan out in parallel.
 */
export async function refreshJobs(taskIds) {
  const updated = []
  for (const taskId of taskIds) {
    try {
      const status = await fetchTaskStatus(taskId)
      // Nothing is known about the task this time; try it again next pass.
      if (status.state === 'ratelimited' || status.state === 'unknown') {
        await new Promise(r => setTimeout(r, 1200))
        continue
      }
      if (status.job) updated.push(status.job)
    } catch (e) {
      console.warn('[KIE] refresh failed for', taskId, e?.message ?? e)
    }
    await new Promise(r => setTimeout(r, 350))
  }
  return updated
}

// KIE.AI enforces a 3000-character prompt limit — trim with a small safety margin
const KIE_PROMPT_MAX = 2900
function capPrompt(p) {
  if (!p || p.length <= KIE_PROMPT_MAX) return p
  return p.slice(0, KIE_PROMPT_MAX - 3) + '...'
}

const KIE_VIDEO_PROMPT_MAX = 2450
function capVideoPrompt(p) {
  if (!p || p.length <= KIE_VIDEO_PROMPT_MAX) return p
  return p.slice(0, KIE_VIDEO_PROMPT_MAX - 3) + '...'
}

// ── Reference-upload cache ──────────────────────────────────────────
//
// Uploading the same reference photo twice in one session is pure waste, so
// the KIE upload URL is remembered against a fingerprint of the source.
//
// Memory only, deliberately. It used to be written to device storage, which
// meant a fingerprint of the user's own photos sat on disk in plaintext and
// outlived the session it belonged to. The saving was never worth that: the
// cache exists to avoid a duplicate upload inside one burst of generations,
// and it does that just as well without being persisted.
const _mediaCache = new Map()

/** Cheap content fingerprint — length plus both ends. Good enough to spot the
 *  identical data URL again; it is a cache key, not a checksum. */
function mediaFingerprint(dataUrl) {
  return `${dataUrl.length}:${dataUrl.slice(0, 48)}:${dataUrl.slice(-24)}`
}

/** No-op retained so the upload helpers below read unchanged. */
function _mediaCacheSave() {}

/** Called on sign-out so one user's uploads are never reused for the next. */
export function clearMediaCache() {
  _mediaCache.clear()
}

export const initSession = async () => {} // No MCP session to initialize

// ── Base64 Reference Image Upload ───────────────────────────────────
/**
 * Resolve whatever an influencer record holds into base64 the uploader accepts.
 *
 * Stored media is not handled here: it reaches the generator as a signed https
 * URL, which uploadRefImage passes straight through. What arrives here is a
 * picked photo that was never uploaded — a data URL, or a file:// URI.
 * The upload endpoint takes base64, and the old code only special-cased http,
 * so a file path fell through and the path STRING was POSTed as image data —
 * every upload failed, and Motion Copy reported "Failed to upload the
 * character image".
 *
 * compressImage already reads a file:// URI and returns a data URL, so it does
 * the conversion and keeps the size down in one step.
 */
async function toBase64(source) {
  if (!source) return null
  if (source.startsWith('data:')) return source
  const converted = await compressImage(source)
  // compressImage falls back to returning its input unchanged on failure, so
  // only accept a genuine data URL back.
  return typeof converted === 'string' && converted.startsWith('data:') ? converted : null
}

async function uploadRefImage(source) {
  if (!source) return null
  // Our own S3 links are re-signed to outlive KIE's queue; others pass through.
  if (source.startsWith('http')) return urlForGeneration(source)

  // Key the cache on the ORIGINAL reference so a repeat upload skips the
  // conversion too, not just the network call.
  const cacheKey = mediaFingerprint(source)
  if (_mediaCache.has(cacheKey)) {
    const hit = _mediaCache.get(cacheKey)
    if (hit && hit.url && (Date.now() - hit.uploadedAt < 24 * 60 * 60 * 1000)) return hit.url
    _mediaCache.delete(cacheKey)
    _mediaCacheSave()
  }

  const base64Data = await toBase64(source)
  if (!base64Data) {
    console.error('[KIE Upload] could not read image:', String(source).slice(0, 80))
    return null
  }

  const fp = cacheKey
  try {
    const res = await kieFetch('/api/file-base64-upload', {
      method: 'POST',
      body: JSON.stringify({
        base64Data,
        uploadPath: 'images/base64',
        fileName: `ref_${Date.now()}.jpg`
      })
    })
    
    if (!res.ok) {
      console.error(`[KIE Upload] HTTP ${res.status} — proceeding without reference image`)
      return null
    }
    
    const json = await res.json()
    
    // API may return downloadUrl directly or nested under data
    const url = json.data?.downloadUrl || json.downloadUrl || null
    if (!url) {
      console.error('[KIE Upload] No downloadUrl in response:', JSON.stringify(json).slice(0, 200))
      return null
    }
    
    _mediaCache.set(fp, { url, uploadedAt: Date.now() })
    _mediaCacheSave()
    return url
  } catch (e) {
    console.error('[KIE Upload] Exception — proceeding without reference image:', e.message)
    return null
  }
}

// ── Base64 Audio Upload ──────────────────────────────────────────────
// Uploads an audio data URL to KIE's file API and returns the CDN URL.
async function uploadAudioFile(base64Data) {
  if (!base64Data) return null
  if (base64Data.startsWith('http')) return urlForGeneration(base64Data)
  // Guard the same trap uploadRefImage fell into: anything that is not already
  // base64 would otherwise be POSTed as audio data as a literal string.
  if (!base64Data.startsWith('data:')) {
    console.error('[KIE Upload] audio is not base64:', String(base64Data).slice(0, 80))
    return null
  }

  const fp = mediaFingerprint(base64Data)
  if (_mediaCache.has(fp)) {
    const cached = _mediaCache.get(fp)
    if (cached && cached.url && (Date.now() - cached.uploadedAt < 24 * 60 * 60 * 1000)) {
      console.log('[KIE Audio] cache hit — skipping upload')
      return cached.url
    } else {
      _mediaCache.delete(fp)
      _mediaCacheSave()
    }
  }

  try {
    // Derive extension from data URL header (data:audio/mpeg;base64,...)
    const mimeMatch = base64Data.match(/^data:(audio\/[^;]+);base64,/)
    const mime = mimeMatch?.[1] || 'audio/mpeg'
    const ext = mime.includes('wav') ? 'wav' : mime.includes('m4a') || mime.includes('mp4') ? 'm4a' : 'mp3'
    const fileName = `audio_${Date.now()}.${ext}`

    const res = await kieFetch('/api/file-base64-upload', {
      method: 'POST',
      body: JSON.stringify({
        base64Data,
        uploadPath: 'audio/base64',
        fileName
      })
    })

    if (!res.ok) {
      console.error(`[KIE Audio Upload] HTTP ${res.status} — proceeding without audio`)
      return null
    }

    const json = await res.json()
    const url = json.data?.downloadUrl || json.downloadUrl || null
    if (!url) {
      console.error('[KIE Audio Upload] No downloadUrl:', JSON.stringify(json).slice(0, 200))
      return null
    }

    console.log('[KIE Audio Upload] success:', url.slice(0, 80))
    _mediaCache.set(fp, { url, uploadedAt: Date.now() })
    _mediaCacheSave()
    return url
  } catch (e) {
    console.error('[KIE Audio Upload] Exception — proceeding without audio:', e.message)
    return null
  }
}

// ── Polling functions ──────────────────────────────────────────────
/**
 * Watch image jobs while the user is looking at them.
 *
 * Runs for roughly the 10–15 minutes KIE's docs suggest as a polling ceiling,
 * then hands over to the queue rather than declaring a failure — the task is
 * still alive on their side and the credits are already spent.
 *
 * A 429 backs off instead of being swallowed by `if (!res.ok) continue`, which
 * previously just retried at the same rate and could keep the limit tripped.
 */
export async function pollAllJobs(jobIds, total, onProgress, _staleTolerance = 8, isCancelled = null, onPartialResults = null) {
  const pending = new Set(jobIds)
  const urls = []
  const failures = []
  let backoff = 0

  for (let round = 0; round < 200 && pending.size > 0 && urls.length < total; round++) {
    if (isCancelled?.()) throw new Error('CANCELLED')
    if (round > 0) await new Promise(r => setTimeout(r, 3000 + backoff))
    if (isCancelled?.()) throw new Error('CANCELLED')

    for (const jobId of [...pending]) {
      if (isCancelled?.()) throw new Error('CANCELLED')
      try {
        const status = await fetchTaskStatus(jobId)

        if (status.state === 'ratelimited') {
          // Exponential, capped — KIE asks for 2–3s growing gradually.
          backoff = Math.min(backoff ? backoff * 2 : 2000, 20000)
          break
        }
        backoff = 0

        if (status.state === 'success' && status.resultUrls[0]) {
          pending.delete(jobId)
          const resultUrl = status.resultUrls[0]
          if (!urls.includes(resultUrl)) {
            urls.push(resultUrl)
            onProgress?.(Math.min(22 + (urls.length / total) * 73, 95))
            onPartialResults?.(urls.slice(0, total))
          }
        } else if (status.state === 'fail') {
          pending.delete(jobId)
          failures.push(status.failMsg)
          console.warn(`[KIE Poll] Job ${jobId} failed: ${status.failMsg || ''}`)
        }
      } catch (e) {
        if (e.message === 'CANCELLED') throw e
        console.warn(`[KIE Poll] Error for job ${jobId}:`, e.message)
      }
    }
  }

  if (urls.length > 0) {
    onProgress?.(100)
    return urls.slice(0, total)
  }
  if (jobIds.length === 0) throw new Error('No job IDs to poll')
  // Every job came back failed. This used to fall through to STILL_RUNNING, so
  // a job the generator had rejected was reported as "still generating".
  if (pending.size === 0 && failures.length > 0) throw failedGeneration(failures)
  // Not a failure — just longer than we were willing to stand and watch.
  console.warn('[KIE Poll] Handing off to the queue; task still running.')
  throw new Error(STILL_RUNNING)
}

/**
 * Watch video / motion jobs while the user is looking at them.
 *
 * Same contract as pollAllJobs: run for roughly KIE's suggested ceiling, then
 * throw STILL_RUNNING and let the queue take over. This loop used to end with
 * `throw new Error('Video generation failed')`, which reported every slow-but-
 * healthy job as broken — the single most misleading message in the app.
 */
async function pollVideoJobs(launched, total, onProgress, onPartialResults, isCancelled) {
  const pending = new Set(launched.map(l => l.taskId))
  const urls = []
  const failures = []
  let backoff = 0

  for (let round = 0; round < 450 && pending.size > 0 && urls.length < total; round++) {
    if (isCancelled?.()) throw new Error('CANCELLED')
    if (round > 0) await new Promise(r => setTimeout(r, 2000 + backoff))
    if (isCancelled?.()) throw new Error('CANCELLED')

    for (const job of launched) {
      const jobId = job.taskId
      if (!pending.has(jobId)) continue

      try {
        if (job.isVeo) {
          const res = await kieFetch('/api/v1/veo/record-info', { query: { taskId: jobId } })
          if (!res.ok) continue
          const json = await res.json()
          if (json.code !== 200) continue
          
          const status = json.data?.status ?? json.data?.successFlag
          const resultUrl = json.data?.resultUrl
          
          if (status === 1 && resultUrl) {
            pending.delete(jobId)
            if (!urls.includes(resultUrl)) {
              urls.push(resultUrl)
              onProgress?.(Math.min(35 + (urls.length / total) * 60, 95))
              onPartialResults?.(urls.slice(0, total))
            }
          } else if (status === 2 || status === 3) {
            pending.delete(jobId)
            failures.push(json.data?.errorMessage || null)
            console.warn(`Veo video job ${jobId} failed`)
          }
        } else {
          const status = await fetchTaskStatus(jobId)

          if (status.state === 'ratelimited') {
            backoff = Math.min(backoff ? backoff * 2 : 2000, 20000)
            break
          }
          backoff = 0

          if (status.state === 'success' && status.resultUrls[0]) {
            pending.delete(jobId)
            const resultUrl = status.resultUrls[0]
            if (!urls.includes(resultUrl)) {
              urls.push(resultUrl)
              onProgress?.(Math.min(35 + (urls.length / total) * 60, 95))
              onPartialResults?.(urls.slice(0, total))
            }
          } else if (status.state === 'fail') {
            pending.delete(jobId)
            failures.push(status.failMsg)
            console.warn(`Kling video job ${jobId} failed: ${status.failMsg || ''}`)
          }
        }
      } catch (e) {
        if (e.message === 'CANCELLED') throw e
        console.warn(`Video poll error for job ${jobId}:`, e.message)
      }
    }
  }
  
  if (urls.length > 0) {
    onProgress?.(100)
    return { urls: urls.slice(0, total), shareUrls: [] }
  }
  // Every job failed — see pollAllJobs.
  if (pending.size === 0 && failures.length > 0) throw failedGeneration(failures)
  // Still alive on KIE — the queue holds the taskId and will collect it.
  throw new Error(STILL_RUNNING)
}

export async function resumeVideoJob(jobIds, count, onProgress, onPartialResults, isCancelled) {
  const launched = jobIds.map(id => ({
    taskId: id,
    isVeo: id.startsWith('veo')
  }))
  return pollVideoJobs(launched, count, onProgress, onPartialResults, isCancelled)
}

// ── Recording jobs ───────────────────────────────────────────────────────────
//
// From the moment KIE accepts a task the credits are spent, and the queue row is
// the only way to find the result again — KIE has no endpoint that lists tasks.
// So writing the row is retried instead of given up on the first failure, and a
// failure no longer stops the screen from watching for the result it paid for.

const RECORD_RETRY_DELAYS_MS = [1000, 3000]

/** @returns {Promise<boolean>} whether the queue rows were written */
async function recordJobs(entries) {
  for (let attempt = 0; ; attempt++) {
    try {
      await registerJobs(entries)
      return true
    } catch (e) {
      // Genuinely signed out: our API would refuse the polling as well.
      if (isSessionEnded(e)) throw e
      if (attempt >= RECORD_RETRY_DELAYS_MS.length) {
        console.warn('[KIE] could not record the job; still watching it:', e?.message ?? e)
        return false
      }
      await new Promise(r => setTimeout(r, RECORD_RETRY_DELAYS_MS[attempt]))
    }
  }
}

/**
 * Watch jobs through `poll`. When their rows could not be written, try once
 * more before handing them to the queue — the queue can only recover a job it
 * has a row for — and say so plainly if that still fails, rather than sending
 * the user to a Queue tab that will never show it.
 */
async function watchJobs(recorded, entries, poll) {
  try {
    return await poll()
  } catch (e) {
    if (e?.message !== STILL_RUNNING || recorded) throw e
    if (await recordJobs(entries).catch(() => false)) throw e
    throw new AppError(
      'This is still generating, but the connection dropped before it could be added to your queue, so it will not appear there. Check your connection before generating again.',
      { code: ERROR_CODES.NETWORK },
    )
  }
}

// ── Public Image Generation APIs ────────────────────────────────────
// Launch one image job on KIE's unified createTask endpoint.
// Uses the active image model (IMAGE_MODEL_ID = Nano Banana Pro). Reference images
// are passed as `image_input` (array of URLs, up to 8). Returns the taskId, polled
// by pollAllJobs (jobs/recordInfo).
async function launchImageJob(prompt, imageUrls, aspectRatio) {
  const input = {
    prompt: capPrompt(prompt),
    aspect_ratio: aspectRatio,
    resolution: '2K',
    output_format: 'png',
  }
  const refs = (imageUrls || []).filter(Boolean)
  if (refs.length) input.image_input = refs

  const res = await kieFetch('/api/v1/jobs/createTask', {
      method: 'POST',
    body: JSON.stringify({ model: IMAGE_MODEL_ID, input }),
  })
  if (!res.ok) throw await refusal(res)
  const json = await res.json()
  if (json.code !== 200 || !json.data?.taskId) throw generatorError(json.code, json.msg)
  return json.data.taskId
}

export async function generateSingleImage({ prompt, aspectRatio = '16:9', resolution = '4k', referenceImage = null, outfitImage = null, onProgress, onJobIds = null, isCancelled = null, queueMeta = null }) {
  onProgress?.(5)
  const faceUrl = referenceImage ? await uploadRefImage(referenceImage) : null
  if (referenceImage && !faceUrl) throw referenceError('reference image')
  onProgress?.(15)
  const outfitUrl = outfitImage ? await uploadRefImage(outfitImage) : null
  if (outfitImage && !outfitUrl) throw referenceError('outfit image')
  onProgress?.(25)

  const taskId = await launchImageJob(prompt, [faceUrl, outfitUrl], aspectRatio)
  const jobIds = [taskId]
  onJobIds?.(jobIds)

  // Recorded before polling starts: from here on the task exists on KIE and is
  // costing credits, so it must be recoverable even if the app dies now.
  const entries = [{ taskId, kind: 'image', model: IMAGE_MODEL_ID, ...(queueMeta || {}) }]
  const recorded = await recordJobs(entries)

  const urls = await watchJobs(recorded, entries, () => pollAllJobs(jobIds, 1, onProgress, 16, isCancelled))
  onProgress?.(100)
  return urls[0] ?? null
}

export async function generateThreeImages({ prompts, aspectRatio = '9:16', model = 'gpt_image_2', faceRef = null, styleRef = null, physicalDesc = '', faceRefNote = '', styleRefNote = '', onProgress, onPartialResults, onJobIds = null, queueMeta = null }) {
  onProgress?.(5)
  const faceUrl = faceRef ? await uploadRefImage(faceRef) : null
  if (faceRef && !faceUrl) throw referenceError('reference image')
  console.log('[KIE] faceUrl:', faceUrl ? 'uploaded ✓' : 'none')
  onProgress?.(12)
  const styleUrl = styleRef ? await uploadRefImage(styleRef) : null
  if (styleRef && !styleUrl) throw referenceError('style image')
  console.log('[KIE] styleUrl:', styleUrl ? 'uploaded ✓' : 'none')
  onProgress?.(20)
  
  const launchPromises = prompts.map(prompt => launchImageJob(prompt, [faceUrl, styleUrl], aspectRatio))

  const jobIds = await Promise.all(launchPromises)
  console.log('[KIE] All image taskIds launched:', jobIds)
  // Lets a caller keep watching a job that outlives the foreground poll.
  onJobIds?.(jobIds)
  // Awaited like every other launch path: the tasks are already costing credits,
  // and an unwritten row is a job the Queue can never recover.
  const entries = jobIds.map(taskId => ({ taskId, kind: 'image', model: IMAGE_MODEL_ID, ...(queueMeta || {}) }))
  const recorded = await recordJobs(entries)
  onProgress?.(30)
  
  const urls = await watchJobs(recorded, entries, () =>
    pollAllJobs(jobIds, prompts.length, onProgress, 16, null, onPartialResults))
  onProgress?.(100)
  return urls.slice(0, prompts.length)
}

// ── Public Video Generation API ─────────────────────────────────────
export async function generateVideo({ prompt, aspectRatio = '9:16', duration = 8, count = 1, referenceImages = [], referenceRoles = null, audioRef = null, hasVoice = false, startFrameUrl = null, model = VIDEO_MODEL_KLING, resolution = '1080p', onProgress, onPartialResults, isCancelled, queueMeta = null }) {
  onProgress?.(5)
  const imageUrls = []
  if (referenceImages && referenceImages.length) {
    const urls = await Promise.all(referenceImages.filter(Boolean).map(img => uploadRefImage(img)))
    if (urls.some(u => !u)) throw referenceError('reference images')
    imageUrls.push(...urls)
  }
  onProgress?.(20)

  // Upload audio file if provided (for Kling lip-sync)
  let audioUrl = null
  if (audioRef) {
    console.log('[KIE Video] Uploading audio for lip-sync...')
    audioUrl = await uploadAudioFile(audioRef)
    // A silent clip is not what was asked for, and it would still be charged.
    if (!audioUrl) throw referenceError('audio')
    console.log('[KIE Video] Audio ready:', audioUrl.slice(0, 80))
  }
  onProgress?.(25)
  
  const isVeo = model.toLowerCase().includes('veo')
  // Every vendor caps how many reference images it accepts, and the cap is NOT
  // always 2 — seven of the ten selectable models take exactly one. Hard-coding
  // 2 here meant a product image was dropped without a word whenever the
  // influencer also had reference sheets, so the promo video came back showing
  // an invented object. Trim to what the CHOSEN model actually accepts, and
  // trust the caller to have ordered the list by importance.
  if (!isVeo) {
    const limit = getVideoModel(model).maxImages ?? 2
    if (imageUrls.length > limit) {
      console.warn(`[KIE Video] ${getVideoModel(model).label} accepts ${limit} image(s); dropping ${imageUrls.length - limit}.`)
      imageUrls.splice(limit)
    }
  }
  const jobIds = []
  
  const launchPromises = Array.from({ length: count }, async (_, i) => {
    const promptSuffix = i === 0 ? '' : '​'.repeat(i)
    let finalPrompt = prompt + promptSuffix
    if (!isVeo) {
      // These models take plain text, so tags become words — chosen by what
      // each image is (referenceRoles), not by where it landed in the list.
      finalPrompt = replaceImageTags(finalPrompt, referenceRoles)
    }
    finalPrompt = capVideoPrompt(finalPrompt)
    
    if (isVeo) {
      const body = {
        prompt: finalPrompt,
        aspect_ratio: aspectRatio,
        model: VIDEO_MODEL_VEO,
        imageUrls: imageUrls
      }
      const res = await kieFetch('/api/v1/veo/generate', {
        method: 'POST',
        body: JSON.stringify(body)
      })
      if (!res.ok) throw await refusal(res)
      const json = await res.json()
      if (json.code !== 200 || !json.data?.taskId) throw generatorError(json.code, json.msg)
      return { taskId: json.data.taskId, isVeo: true }
    } else {
      // Each model declares how to map this request onto its own fields —
      // vendors differ (image_urls vs image_url, mode vs resolution), so the
      // model id alone is not enough to swap between them.
      const chosen = getVideoModel(model)
      const body = {
        model: chosen.id,
        input: chosen.buildInput({
          prompt: finalPrompt,
          imageUrls,
          duration,
          aspectRatio,
          hasVoice,
          audioUrl: chosen.supportsSound ? audioUrl : null,
        }),
      }
      if (audioUrl && !chosen.supportsSound) {
        console.warn(`[KIE Video] ${chosen.label} has no audio track — generating silent.`)
      }
      const res = await kieFetch('/api/v1/jobs/createTask', {
      method: 'POST',
        body: JSON.stringify(body)
      })
      if (!res.ok) throw await refusal(res)
      const json = await res.json()
      if (json.code !== 200 || !json.data?.taskId) throw generatorError(json.code, json.msg)
      return { taskId: json.data.taskId, isVeo: false }
    }
  })
  
  const launched = await Promise.all(launchPromises)
  jobIds.push(...launched.map(l => l.taskId))
  const entries = jobIds.map(taskId => ({
    taskId, kind: 'video', label: 'Video', model, ...(queueMeta || {}),
  }))
  const recorded = await recordJobs(entries)
  onProgress?.(30)

  const result = await watchJobs(recorded, entries, () =>
    pollVideoJobs(launched, count, onProgress, onPartialResults, isCancelled))
  onProgress?.(100)
  return result
}

// ── Motion Copy (Kling 3.0 Motion Control) ──────────────────────────
// Character image + a driving/reference video → the character performs that exact
// motion, gestures and expression while keeping its identity.
//
// The upload, job-launch and polling all reuse the proven Kling video flow. The
// exact model id / input field names finalise against the live API (see the
// MOTION_MODEL_KIE note in config/generation.js).

async function uploadRefVideo(base64Data) {
  if (!base64Data) return null
  if (base64Data.startsWith('http')) return urlForGeneration(base64Data)
  // Guard the same trap uploadRefImage fell into: anything that is not already
  // base64 would otherwise be POSTed as video data as a literal string.
  if (!base64Data.startsWith('data:')) {
    console.error('[KIE Upload] video is not base64:', String(base64Data).slice(0, 80))
    return null
  }

  const fp = mediaFingerprint(base64Data)
  if (_mediaCache.has(fp)) {
    const cached = _mediaCache.get(fp)
    if (cached && cached.url && (Date.now() - cached.uploadedAt < 24 * 60 * 60 * 1000)) return cached.url
    _mediaCache.delete(fp); _mediaCacheSave()
  }

  try {
    const res = await kieFetch('/api/file-base64-upload', {
      method: 'POST',
      body: JSON.stringify({ base64Data, uploadPath: 'videos/base64', fileName: `drive_${Date.now()}.mp4` }),
    })
    if (!res.ok) { console.error(`[KIE Upload] video HTTP ${res.status}`); return null }
    const json = await res.json()
    const url = json.data?.downloadUrl || json.downloadUrl || null
    if (!url) { console.error('[KIE Upload] no video downloadUrl:', JSON.stringify(json).slice(0, 200)); return null }
    _mediaCache.set(fp, { url, uploadedAt: Date.now() }); _mediaCacheSave()
    return url
  } catch (e) {
    console.error('[KIE Upload] video exception:', e.message)
    return null
  }
}

export async function generateMotionCopy({ characterImage, drivingVideo, prompt = '', mode = 'pro', model = MOTION_MODEL_KIE, onProgress, onPartialResults, isCancelled, queueMeta = null }) {
  if (!characterImage) throw new Error('A character image is required')
  if (!drivingVideo)  throw new Error('A driving (motion) video is required')

  onProgress?.(5)
  const imageUrl = await uploadRefImage(characterImage)
  if (!imageUrl) throw referenceError('character image')
  onProgress?.(20)
  const videoUrl = await uploadRefVideo(drivingVideo)
  if (!videoUrl) throw referenceError('motion video')
  onProgress?.(30)

  // Kling 3.0 Motion Control schema (KIE docs): input_urls = character image(s),
  // video_urls = driving/motion video(s). mode 'std' = 720p, 'pro' = 1080p. The
  // output orientation/background follow the driving video by default.
  // The chosen model maps this onto its own fields; Wan, for example, takes
  // singular image_url/video_url and no prompt at all.
  const chosenMotion = getMotionModel(model)
  const body = {
    model: chosenMotion.id,
    input: chosenMotion.buildInput({
      prompt: capVideoPrompt(prompt || ''),
      imageUrl,
      videoUrl,
      mode,
    }),
  }
  const res = await kieFetch('/api/v1/jobs/createTask', {
      method: 'POST',
    body: JSON.stringify(body),
  })
  if (!res.ok) throw await refusal(res)
  const json = await res.json()
  if (json.code !== 200 || !json.data?.taskId) throw generatorError(json.code, json.msg)

  const taskId = json.data.taskId
  const entries = [{ taskId, kind: 'video', label: 'Motion Copy', model, ...(queueMeta || {}) }]
  const recorded = await recordJobs(entries)
  onProgress?.(35)

  const result = await watchJobs(recorded, entries, () =>
    pollVideoJobs([{ taskId, isVeo: false }], 1, onProgress, onPartialResults, isCancelled))
  onProgress?.(100)
  return result // { urls, shareUrls }
}
