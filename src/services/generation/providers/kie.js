import { getApiUrl } from '../../../utils/apiUrl'
import { IMAGE_MODEL_ID, VIDEO_MODEL_KLING, VIDEO_MODEL_VEO, MOTION_MODEL_KIE } from '../../../config/generation'
import * as storage from '../../../lib/storage'

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
async function uploadRefImage(base64Data) {
  if (!base64Data) return null
  if (base64Data.startsWith('http')) return base64Data
  
  const fp = mediaFingerprint(base64Data)
  if (_mediaCache.has(fp)) {
    const cached = _mediaCache.get(fp)
    if (cached && cached.url && (Date.now() - cached.uploadedAt < 24 * 60 * 60 * 1000)) {
      return cached.url
    } else {
      _mediaCache.delete(fp)
      _mediaCacheSave()
    }
  }

  try {
    const res = await fetch(getApiUrl('/api/kie/api/file-base64-upload?__kiepath=/api/file-base64-upload'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

    const res = await fetch(getApiUrl('/api/kie/api/file-base64-upload?__kiepath=/api/file-base64-upload'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
export async function pollAllJobs(jobIds, total, onProgress, _staleTolerance = 8, isCancelled = null, onPartialResults = null) {
  const pending = new Set(jobIds)
  const urls = []
  
  for (let round = 0; round < 60 && pending.size > 0 && urls.length < total; round++) {
    if (isCancelled?.()) throw new Error('CANCELLED')
    if (round > 0) await new Promise(r => setTimeout(r, 3000))
    if (isCancelled?.()) throw new Error('CANCELLED')
    
    for (const jobId of [...pending]) {
      if (isCancelled?.()) throw new Error('CANCELLED')
      try {
        const res = await fetch(getApiUrl(`/api/kie/api/v1/jobs/recordInfo?__kiepath=/api/v1/jobs/recordInfo&taskId=${jobId}`))
        if (!res.ok) continue

        const json = await res.json()
        if (json.code !== 200) continue

        const state = json.data?.state
        const resultJsonStr = json.data?.resultJson
        if (round === 0 || state) {
          console.log(`[KIE Poll] round=${round} jobId=${String(jobId).slice(-8)} state=${state} hasResult=${!!resultJsonStr}`)
        }

        if (state === 'success' && resultJsonStr) {
          let resultUrl = null
          try { resultUrl = JSON.parse(resultJsonStr).resultUrls?.[0] } catch {}
          if (resultUrl) {
            pending.delete(jobId)
            if (!urls.includes(resultUrl)) {
              urls.push(resultUrl)
              onProgress?.(Math.min(22 + (urls.length / total) * 73, 95))
              onPartialResults?.(urls.slice(0, total))
            }
          }
        } else if (state === 'fail') {
          pending.delete(jobId)
          console.warn(`[KIE Poll] Job ${jobId} failed: ${json.data?.failMsg || ''}`)
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
  console.error('[KIE Poll] Timed out. Last known status check failed to detect completion.')
  throw new Error('Image generation timed out')
}

async function pollVideoJobs(launched, total, onProgress, onPartialResults, isCancelled) {
  const pending = new Set(launched.map(l => l.taskId))
  const urls = []
  
  for (let round = 0; round < 270 && pending.size > 0 && urls.length < total; round++) {
    if (isCancelled?.()) throw new Error('CANCELLED')
    if (round > 0) await new Promise(r => setTimeout(r, 2000))
    if (isCancelled?.()) throw new Error('CANCELLED')
    
    for (const job of launched) {
      const jobId = job.taskId
      if (!pending.has(jobId)) continue
      
      try {
        if (job.isVeo) {
          const res = await fetch(getApiUrl(`/api/kie/api/v1/veo/record-info?__kiepath=/api/v1/veo/record-info&taskId=${jobId}`))
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
          const res = await fetch(getApiUrl(`/api/kie/api/v1/jobs/recordInfo?__kiepath=/api/v1/jobs/recordInfo&taskId=${jobId}`))
          if (!res.ok) continue
          const json = await res.json()
          if (json.code !== 200) continue
          
          const state = json.data?.state
          const resultJsonStr = json.data?.resultJson
          
          if (state === 'success' && resultJsonStr) {
            const resultObj = JSON.parse(resultJsonStr)
            const resultUrl = resultObj.resultUrls?.[0]
            if (resultUrl) {
              pending.delete(jobId)
              if (!urls.includes(resultUrl)) {
                urls.push(resultUrl)
                onProgress?.(Math.min(35 + (urls.length / total) * 60, 95))
                onPartialResults?.(urls.slice(0, total))
              }
            }
          } else if (state === 'fail') {
            pending.delete(jobId)
            console.warn(`Kling video job ${jobId} failed: ${json.data?.failMsg || ''}`)
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
  throw new Error('Video generation failed')
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

  const res = await fetch(getApiUrl('/api/kie/api/v1/jobs/createTask?__kiepath=/api/v1/jobs/createTask'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: IMAGE_MODEL_ID, input }),
  })
  if (!res.ok) throw new Error(`Image generate failed: status ${res.status}`)
  const json = await res.json()
  if (json.code !== 200 || !json.data?.taskId) throw new Error(json.msg || 'Failed to start image generation')
  return json.data.taskId
}

export async function generateSingleImage({ prompt, aspectRatio = '16:9', resolution = '4k', referenceImage = null, outfitImage = null, onProgress, pendingKey = null, onJobIds = null, isCancelled = null }) {
  onProgress?.(5)
  const faceUrl = referenceImage ? await uploadRefImage(referenceImage) : null
  onProgress?.(15)
  const outfitUrl = outfitImage ? await uploadRefImage(outfitImage) : null
  onProgress?.(25)

  const taskId = await launchImageJob(prompt, [faceUrl, outfitUrl], aspectRatio)
  const jobIds = [taskId]
  onJobIds?.(jobIds)
  
  if (pendingKey) savePendingGen(pendingKey.influencerId, pendingKey.slot, jobIds)
  
  try {
    const urls = await pollAllJobs(jobIds, 1, onProgress, 16, isCancelled)
    onProgress?.(100)
    return urls[0] ?? null
  } finally {
    if (pendingKey) clearPendingGen(pendingKey.influencerId, pendingKey.slot)
  }
}

export async function generateThreeImages({ prompts, aspectRatio = '9:16', model = 'gpt_image_2', faceRef = null, styleRef = null, physicalDesc = '', faceRefNote = '', styleRefNote = '', onProgress, onPartialResults }) {
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
  onProgress?.(30)
  
  const urls = await pollAllJobs(jobIds, prompts.length, onProgress, 16, null, onPartialResults)
  onProgress?.(100)
  return urls.slice(0, prompts.length)
}

// ── Public Video Generation API ─────────────────────────────────────
export async function generateVideo({ prompt, aspectRatio = '9:16', duration = 8, count = 1, referenceImages = [], audioRef = null, hasVoice = false, startFrameUrl = null, model = VIDEO_MODEL_KLING, resolution = '1080p', onProgress, onPartialResults, isCancelled, pendingKey = null }) {
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
  if (!isVeo && imageUrls.length > 2) {
    console.warn(`[KIE Video] Kling only supports at most 2 image_urls, slicing from ${imageUrls.length} to 2.`)
    imageUrls.splice(2)
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
      const res = await fetch(getApiUrl('/api/kie/api/v1/veo/generate?__kiepath=/api/v1/veo/generate'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      if (!res.ok) throw new Error(`Veo generate failed: status ${res.status}`)
      const json = await res.json()
      if (json.code !== 200 || !json.data?.taskId) throw new Error(json.msg || 'Failed to start Veo video')
      return { taskId: json.data.taskId, isVeo: true }
    } else {
      const klingInput = {
        prompt: finalPrompt,
        aspect_ratio: aspectRatio,
        duration: duration,
        image_urls: imageUrls,
        mode: 'std',
        multi_shots: false,
        // sound: true when user uploaded audio (lip-sync) OR selected a voice preset/custom (Kling AI voice)
        sound: !!(audioUrl || hasVoice),
      }
      // If an audio URL was uploaded, attach it for lip-sync / audio generation
      if (audioUrl) {
        klingInput.audio_url = audioUrl
        console.log('[KIE Video] Audio attached for lip-sync:', audioUrl.slice(0, 80))
      }
      const body = {
        model: VIDEO_MODEL_KLING,
        input: klingInput
      }
      const res = await fetch(getApiUrl('/api/kie/api/v1/jobs/createTask?__kiepath=/api/v1/jobs/createTask'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      if (!res.ok) throw new Error(`Kling generate failed: status ${res.status}`)
      const json = await res.json()
      if (json.code !== 200 || !json.data?.taskId) throw new Error(json.msg || 'Failed to start Kling video')
      return { taskId: json.data.taskId, isVeo: false }
    }
  })
  
  const launched = await Promise.all(launchPromises)
  jobIds.push(...launched.map(l => l.taskId))
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

  const fp = mediaFingerprint(base64Data)
  if (_mediaCache.has(fp)) {
    const cached = _mediaCache.get(fp)
    if (cached && cached.url && (Date.now() - cached.uploadedAt < 24 * 60 * 60 * 1000)) return cached.url
    _mediaCache.delete(fp); _mediaCacheSave()
  }

  try {
    const res = await fetch(getApiUrl('/api/kie/api/file-base64-upload?__kiepath=/api/file-base64-upload'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

export async function generateMotionCopy({ characterImage, drivingVideo, prompt = '', mode = 'pro', onProgress, onPartialResults, isCancelled, pendingKey = null }) {
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
  const body = {
    model: MOTION_MODEL_KIE,
    input: {
      prompt: capVideoPrompt(prompt || ''),
      input_urls: [imageUrl],
      video_urls: [videoUrl],
      mode: mode === 'std' ? 'std' : 'pro',
      character_orientation: 'video',
      background_source: 'input_video',
    },
  }
  const res = await fetch(getApiUrl('/api/kie/api/v1/jobs/createTask?__kiepath=/api/v1/jobs/createTask'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Motion Control failed: status ${res.status}`)
  const json = await res.json()
  if (json.code !== 200 || !json.data?.taskId) throw new Error(json.msg || 'Failed to start Motion Control')

  const taskId = json.data.taskId
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
