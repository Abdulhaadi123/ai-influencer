import { kieFetch } from '../../../platform/kieTransport'
import { IMAGE_MODEL_ID, VIDEO_MODEL_KLING, VIDEO_MODEL_VEO, MOTION_MODEL_KIE } from '../../../config/generation'
import { getVideoModel, getMotionModel } from '../../../config/videoModels'
import * as storage from '../../../platform/storage'
import { compressImage } from '../../../platform/media'
import { registerJobs, applyStatus } from '../../../jobQueue'

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
 * KIE's documented response codes. A bare "generation failed" hides the
 * difference between an empty wallet, a bad model id and a maintenance window
 * — all three need a different reaction from the user.
 */
const CODE_MESSAGES = {
  401: 'The API key was rejected. Check EXPO_PUBLIC_KIE_API_KEY in mobile/.env.',
  402: 'Out of KIE credits — top up the account to keep generating.',
  404: 'KIE could not find that resource.',
  422: 'KIE rejected the request parameters (often an unsupported model id).',
  429: 'Too many requests to KIE right now — wait a moment and try again.',
  433: 'This API subkey has hit its usage limit.',
  455: 'KIE is under maintenance. Try again shortly.',
  500: 'KIE had a server error.',
  501: 'The generation itself failed on KIE.',
  505: 'That feature is disabled on this KIE account.',
}

function messageForCode(code, fallback) {
  return CODE_MESSAGES[code] || fallback || `KIE returned code ${code}.`
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
  const res = await kieFetch('/api/v1/jobs/recordInfo', { query: { taskId } })

  if (res.status === 429) return { state: 'ratelimited', resultUrls: [], failMsg: null }
  if (!res.ok) return { state: 'unknown', resultUrls: [], failMsg: `HTTP ${res.status}` }

  const json = await res.json().catch(() => null)
  if (!json) return { state: 'unknown', resultUrls: [], failMsg: 'Unreadable response' }
  if (json.code === 429) return { state: 'ratelimited', resultUrls: [], failMsg: null }
  if (json.code !== 200) {
    return { state: 'unknown', resultUrls: [], failMsg: messageForCode(json.code, json.msg) }
  }

  const d = json.data || {}
  let resultUrls = []
  if (d.resultJson) {
    try { resultUrls = JSON.parse(d.resultJson).resultUrls || [] } catch {}
  }

  return {
    state: d.state || 'unknown',
    resultUrls,
    failMsg: d.failMsg || null,
    completeTime: d.completeTime || null,
    creditsConsumed: d.creditsConsumed ?? null,
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
      // Nothing is known about the task, so leave the stored row untouched.
      if (status.state === 'ratelimited' || status.state === 'unknown') {
        await new Promise(r => setTimeout(r, 1200))
        continue
      }
      const job = applyStatus(taskId, status)
      if (job) updated.push(job)
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

const PENDING_KEY = 'kie_pending_gens'
const PENDING_VIDEO_KEY = 'kie_pending_videos'

// ── Media caching to avoid double uploading ────────────────────────
const MEDIA_CACHE_KEY = 'kie_media_cache'
const _mediaCache = (() => {
  try {
    const raw = JSON.parse(storage.getItem(MEDIA_CACHE_KEY) || '{}')
    const map = new Map()
    const now = Date.now()
    const expiry = 24 * 60 * 60 * 1000 // 24 hours
    let hasLegacy = false
    for (const [k, v] of Object.entries(raw)) {
      // Ignore legacy string values or expired entries
      if (v && typeof v === 'object' && v.url && (now - v.uploadedAt < expiry)) {
        map.set(k, v)
      } else {
        hasLegacy = true
      }
    }
    if (hasLegacy) {
      try { storage.setItem(MEDIA_CACHE_KEY, JSON.stringify(Object.fromEntries(map))) } catch {}
    }
    return map
  }
  catch { return new Map() }
})()

function _mediaCacheSave() {
  try { storage.setItem(MEDIA_CACHE_KEY, JSON.stringify(Object.fromEntries(_mediaCache))) }
  catch { /* cache in memory only */ }
}

function mediaFingerprint(dataUrl) {
  return `${dataUrl.length}:${dataUrl.slice(0, 48)}:${dataUrl.slice(-24)}`
}

// ── Pending generation helpers ──────────────────────────────────────
export function savePendingGen(influencerId, slot, jobIds) {
  const list = JSON.parse(storage.getItem(PENDING_KEY) || '[]')
  const filtered = list.filter(j => !(j.influencerId === influencerId && j.slot === slot))
  filtered.push({ influencerId, slot, jobIds, startedAt: Date.now() })
  storage.setItem(PENDING_KEY, JSON.stringify(filtered))
}

export function clearPendingGen(influencerId, slot) {
  const list = JSON.parse(storage.getItem(PENDING_KEY) || '[]')
  storage.setItem(PENDING_KEY, JSON.stringify(
    list.filter(j => !(j.influencerId === influencerId && j.slot === slot))
  ))
}

export function getPendingGens() {
  return JSON.parse(storage.getItem(PENDING_KEY) || '[]')
}

export function savePendingVideo(influencerId, jobIds, count) {
  const list = JSON.parse(storage.getItem(PENDING_VIDEO_KEY) || '[]')
  const next = list.filter(j => j.influencerId !== influencerId)
  next.push({ influencerId, jobIds, count, startedAt: Date.now() })
  storage.setItem(PENDING_VIDEO_KEY, JSON.stringify(next))
}

export function clearPendingVideo(influencerId) {
  const list = JSON.parse(storage.getItem(PENDING_VIDEO_KEY) || '[]')
  storage.setItem(PENDING_VIDEO_KEY, JSON.stringify(
    list.filter(j => j.influencerId !== influencerId)
  ))
}

export function getPendingVideo(influencerId) {
  const list = JSON.parse(storage.getItem(PENDING_VIDEO_KEY) || '[]')
  return list.find(j => j.influencerId === influencerId) || null
}

export const initSession = async () => {} // No MCP session to initialize

// ── Base64 Reference Image Upload ───────────────────────────────────
/**
 * Resolve whatever an influencer record holds into base64 the uploader accepts.
 *
 * Stored results are LOCAL FILE PATHS, not URLs: persistMedia copies each
 * generated file onto the device because KIE deletes its result URLs within a
 * day. So `mainImage` and friends look like "file:///data/.../image_123.jpg".
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
  if (source.startsWith('http')) return source

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
  if (base64Data.startsWith('http')) return base64Data
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

        // Keep the stored row current so the Queue tab is accurate even while
        // this foreground loop is the thing doing the watching.
        applyStatus(jobId, status)

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
            console.warn(`Veo video job ${jobId} failed`)
          }
        } else {
          const status = await fetchTaskStatus(jobId)

          if (status.state === 'ratelimited') {
            backoff = Math.min(backoff ? backoff * 2 : 2000, 20000)
            break
          }
          backoff = 0

          applyStatus(jobId, status)

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
  if (!res.ok) throw new Error(messageForCode(res.status, `Image generate failed (HTTP ${res.status})`))
  const json = await res.json()
  if (json.code !== 200 || !json.data?.taskId) throw new Error(messageForCode(json.code, json.msg))
  return json.data.taskId
}

export async function generateSingleImage({ prompt, aspectRatio = '16:9', resolution = '4k', referenceImage = null, outfitImage = null, onProgress, pendingKey = null, onJobIds = null, isCancelled = null, queueMeta = null }) {
  onProgress?.(5)
  const faceUrl = referenceImage ? await uploadRefImage(referenceImage) : null
  onProgress?.(15)
  const outfitUrl = outfitImage ? await uploadRefImage(outfitImage) : null
  onProgress?.(25)

  const taskId = await launchImageJob(prompt, [faceUrl, outfitUrl], aspectRatio)
  const jobIds = [taskId]
  onJobIds?.(jobIds)

  // Recorded before polling starts: from here on the task exists on KIE and is
  // costing credits, so it must be recoverable even if the app dies now.
  registerJobs([{ taskId, kind: 'image', model: IMAGE_MODEL_ID, ...(queueMeta || {}) }])

  if (pendingKey) savePendingGen(pendingKey.influencerId, pendingKey.slot, jobIds)
  
  try {
    const urls = await pollAllJobs(jobIds, 1, onProgress, 16, isCancelled)
    onProgress?.(100)
    return urls[0] ?? null
  } finally {
    if (pendingKey) clearPendingGen(pendingKey.influencerId, pendingKey.slot)
  }
}

export async function generateThreeImages({ prompts, aspectRatio = '9:16', model = 'gpt_image_2', faceRef = null, styleRef = null, physicalDesc = '', faceRefNote = '', styleRefNote = '', onProgress, onPartialResults, queueMeta = null }) {
  onProgress?.(5)
  const faceUrl = faceRef ? await uploadRefImage(faceRef) : null
  console.log('[KIE] faceUrl:', faceUrl ? 'uploaded ✓' : 'none')
  onProgress?.(12)
  const styleUrl = styleRef ? await uploadRefImage(styleRef) : null
  console.log('[KIE] styleUrl:', styleUrl ? 'uploaded ✓' : 'none')
  onProgress?.(20)
  
  const launchPromises = prompts.map(prompt => launchImageJob(prompt, [faceUrl, styleUrl], aspectRatio))

  const jobIds = await Promise.all(launchPromises)
  console.log('[KIE] All image taskIds launched:', jobIds)
  registerJobs(jobIds.map(taskId => ({ taskId, kind: 'image', model: IMAGE_MODEL_ID, ...(queueMeta || {}) })))
  onProgress?.(30)
  
  const urls = await pollAllJobs(jobIds, prompts.length, onProgress, 16, null, onPartialResults)
  onProgress?.(100)
  return urls.slice(0, prompts.length)
}

// ── Public Video Generation API ─────────────────────────────────────
export async function generateVideo({ prompt, aspectRatio = '9:16', duration = 8, count = 1, referenceImages = [], audioRef = null, hasVoice = false, startFrameUrl = null, model = VIDEO_MODEL_KLING, resolution = '1080p', onProgress, onPartialResults, isCancelled, pendingKey = null, queueMeta = null }) {
  onProgress?.(5)
  const imageUrls = []
  if (referenceImages && referenceImages.length) {
    const urls = await Promise.all(referenceImages.filter(Boolean).map(img => uploadRefImage(img)))
    imageUrls.push(...urls.filter(Boolean))
  }
  onProgress?.(20)

  // Upload audio file if provided (for Kling lip-sync)
  let audioUrl = null
  if (audioRef) {
    console.log('[KIE Video] Uploading audio for lip-sync...')
    audioUrl = await uploadAudioFile(audioRef)
    if (audioUrl) console.log('[KIE Video] Audio ready:', audioUrl.slice(0, 80))
    else console.warn('[KIE Video] Audio upload failed — video will be silent')
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
      finalPrompt = finalPrompt
        .replace(/@image_1/g, 'the presenter')
        .replace(/@image_2/g, 'the wardrobe')
        .replace(/@image_3/g, 'the face details')
        .replace(/@image_4/g, 'the features')
        .replace(/@image_[5-8]/g, 'the product')
        .replace(/@audio_1/g, 'the audio')
        .replace(/@/g, '');
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
      if (!res.ok) throw new Error(messageForCode(res.status, `Veo generate failed (HTTP ${res.status})`))
      const json = await res.json()
      if (json.code !== 200 || !json.data?.taskId) throw new Error(messageForCode(json.code, json.msg))
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
      if (!res.ok) throw new Error(messageForCode(res.status, `Video generate failed (HTTP ${res.status})`))
      const json = await res.json()
      if (json.code !== 200 || !json.data?.taskId) throw new Error(messageForCode(json.code, json.msg))
      return { taskId: json.data.taskId, isVeo: false }
    }
  })
  
  const launched = await Promise.all(launchPromises)
  jobIds.push(...launched.map(l => l.taskId))
  registerJobs(jobIds.map(taskId => ({
    taskId, kind: 'video', label: 'Video', model, ...(queueMeta || {}),
  })))
  onProgress?.(30)

  if (pendingKey) savePendingVideo(pendingKey, jobIds, count)
  
  try {
    const result = await pollVideoJobs(launched, count, onProgress, onPartialResults, isCancelled)
    onProgress?.(100)
    if (pendingKey) clearPendingVideo(pendingKey)
    return result
  } catch (e) {
    if (pendingKey && e.message !== 'CANCELLED') clearPendingVideo(pendingKey)
    throw e
  }
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
  if (base64Data.startsWith('http')) return base64Data
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

export async function generateMotionCopy({ characterImage, drivingVideo, prompt = '', mode = 'pro', model = MOTION_MODEL_KIE, onProgress, onPartialResults, isCancelled, pendingKey = null, queueMeta = null }) {
  if (!characterImage) throw new Error('A character image is required')
  if (!drivingVideo)  throw new Error('A driving (motion) video is required')

  onProgress?.(5)
  const imageUrl = await uploadRefImage(characterImage)
  if (!imageUrl) throw new Error('Failed to upload the character image')
  onProgress?.(20)
  const videoUrl = await uploadRefVideo(drivingVideo)
  if (!videoUrl) throw new Error('Failed to upload the driving video')
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
  if (!res.ok) throw new Error(`Motion Control failed: status ${res.status}`)
  const json = await res.json()
  if (json.code !== 200 || !json.data?.taskId) throw new Error(messageForCode(json.code, json.msg))

  const taskId = json.data.taskId
  registerJobs([{ taskId, kind: 'motion', label: 'Motion Copy', model, ...(queueMeta || {}) }])
  if (pendingKey) savePendingVideo(pendingKey, [taskId], 1)
  onProgress?.(35)

  try {
    const result = await pollVideoJobs([{ taskId, isVeo: false }], 1, onProgress, onPartialResults, isCancelled)
    onProgress?.(100)
    if (pendingKey) clearPendingVideo(pendingKey)
    return result // { urls, shareUrls }
  } catch (e) {
    if (pendingKey && e.message !== 'CANCELLED') clearPendingVideo(pendingKey)
    throw e
  }
}
