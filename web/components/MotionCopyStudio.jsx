import { useState, useRef, useEffect } from 'react'
import { generateMotionCopy } from '../../core/services/generation'
import { compressImage, downloadImage } from '../../core/platform/media'

// Motion Copy studio — upload a driving (motion) video and the influencer performs
// that exact motion while keeping their identity (Kling 3.0 Motion Control).
export default function MotionCopyStudio({ influencer, onGenerated }) {
  const characterOptions = [
    influencer?.mainImage && { key: 'main', label: 'Main image', url: influencer.mainImage },
    influencer?.characterSheetImage && { key: 'sheet', label: 'Character sheet', url: influencer.characterSheetImage },
    influencer?.closeUpImage1 && { key: 'close', label: 'Close-up', url: influencer.closeUpImage1 },
  ].filter(Boolean)

  const [characterImage, setCharacterImage] = useState(() => characterOptions[0]?.url || null)
  const [drivingVideo, setDrivingVideo] = useState(null)      // data URL
  const [videoName, setVideoName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState('pro') // 'std' = 720p, 'pro' = 1080p

  const [generating, setGenerating] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)                 // result video URL
  const cancelRef = useRef(false)
  const imgFileRef = useRef()
  const vidFileRef = useRef()
  const [dragging, setDragging] = useState(false)

  useEffect(() => () => { cancelRef.current = true }, [])

  function pickCharacterFile(f) {
    if (!f || !f.type.startsWith('image/')) return
    const r = new FileReader()
    r.onload = e => compressImage(e.target.result).then(setCharacterImage).catch(console.error)
    r.readAsDataURL(f)
  }

  function pickVideoFile(f) {
    if (!f || !f.type.startsWith('video/')) { setError('Please choose a video file (mp4, mov, webm).'); return }
    if (f.size > 60 * 1024 * 1024) { setError('Video is over 60 MB — please trim or compress it first.'); return }
    setError(null)
    setVideoName(f.name)
    const r = new FileReader()
    r.onload = e => setDrivingVideo(e.target.result)
    r.readAsDataURL(f)
  }

  const canGenerate = !!characterImage && !!drivingVideo && !generating

  async function generate() {
    if (!canGenerate) return
    cancelRef.current = false
    setGenerating(true); setProgress(0); setError(null); setResult(null)
    try {
      const { urls } = await generateMotionCopy({
        characterImage,
        drivingVideo,
        prompt,
        mode,
        onProgress: setProgress,
        isCancelled: () => cancelRef.current,
        pendingKey: influencer?.id,
      })
      const url = urls?.[0]
      if (!cancelRef.current && url) {
        setResult(url)
        onGenerated?.(url)
      } else if (!url) {
        setError('No video was returned — please try again.')
      }
    } catch (e) {
      if (e.message !== 'CANCELLED') setError(e.message)
    } finally {
      if (!cancelRef.current) { setGenerating(false); setProgress(0) }
    }
  }

  function cancel() { cancelRef.current = true; setGenerating(false); setProgress(0) }

  const lbl = { fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8, display: 'block' }
  const card = { background: 'var(--surface)', border: '1px solid var(--border-subtle)', borderRadius: 16, padding: 20 }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 720 }}>
      <div>
        <h2 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.4px', margin: '0 0 4px' }}>Motion Copy</h2>
        <p style={{ fontSize: 14, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.55 }}>
          Upload a motion video and {influencer?.name || 'your influencer'} performs the exact same movement, gestures and expression — identity kept intact.
        </p>
      </div>

      {/* Character source */}
      <div style={card}>
        <span style={lbl}>Character — who moves</span>
        {characterImage ? (
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
            <img src={characterImage} alt="" style={{ width: 96, height: 128, objectFit: 'cover', borderRadius: 10, border: '1px solid var(--border)', flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              {characterOptions.length > 1 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                  {characterOptions.map(o => {
                    const on = characterImage === o.url
                    return (
                      <button key={o.key} onClick={() => setCharacterImage(o.url)} style={{
                        padding: '5px 11px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                        border: `1.5px solid ${on ? '#8B5CF6' : 'var(--border)'}`,
                        background: on ? 'rgba(139,92,246,0.09)' : 'var(--bg-tertiary)',
                        color: on ? '#7C3AED' : 'var(--text-secondary)',
                      }}>{o.label}</button>
                    )
                  })}
                </div>
              )}
              <button onClick={() => imgFileRef.current.click()} style={{ padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600, border: '1.5px solid var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', cursor: 'pointer' }}>Upload a different image</button>
            </div>
          </div>
        ) : (
          <button onClick={() => imgFileRef.current.click()} style={{ width: '100%', padding: 24, borderRadius: 12, border: '2px dashed var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)', fontSize: 13, cursor: 'pointer' }}>
            + Upload a character image
          </button>
        )}
        <input ref={imgFileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => { pickCharacterFile(e.target.files[0]); e.target.value = '' }} />
      </div>

      {/* Driving video */}
      <div style={card}>
        <span style={lbl}>Motion video — what to copy</span>
        {drivingVideo ? (
          <div>
            <video src={drivingVideo} controls style={{ width: '100%', maxHeight: 320, borderRadius: 10, background: '#000', display: 'block', marginBottom: 10 }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 12.5, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{videoName}</span>
              <button onClick={() => { setDrivingVideo(null); setVideoName('') }} style={{ padding: '5px 11px', borderRadius: 8, fontSize: 12, fontWeight: 600, border: '1px solid var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)', cursor: 'pointer' }}>Remove</button>
            </div>
          </div>
        ) : (
          <div
            onClick={() => vidFileRef.current.click()}
            onDragEnter={e => { e.preventDefault(); setDragging(true) }}
            onDragLeave={e => { e.preventDefault(); setDragging(false) }}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); setDragging(false); pickVideoFile(e.dataTransfer.files[0]) }}
            style={{
              width: '100%', padding: 32, borderRadius: 12, cursor: 'pointer', textAlign: 'center',
              border: `2px dashed ${dragging ? '#8B5CF6' : 'var(--border)'}`,
              background: dragging ? 'rgba(139,92,246,0.06)' : 'var(--bg-tertiary)',
            }}
          >
            <div style={{ fontSize: 22, opacity: 0.3, marginBottom: 8 }}>🎬</div>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 3 }}>{dragging ? 'Drop the video' : 'Upload a motion video'}</div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>mp4, mov, webm — one clear subject, 3–30s works best</div>
          </div>
        )}
        <input ref={vidFileRef} type="file" accept="video/*" style={{ display: 'none' }} onChange={e => { pickVideoFile(e.target.files[0]); e.target.value = '' }} />
      </div>

      {/* Options */}
      <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <span style={lbl}>Scene direction <span style={{ textTransform: 'none', fontWeight: 500 }}>optional</span></span>
          <input value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="e.g. bright studio background, soft lighting"
            style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1.5px solid var(--border)', background: 'var(--bg)', fontSize: 13.5, color: 'var(--text-primary)', boxSizing: 'border-box', fontFamily: 'inherit', outline: 'none' }} />
        </div>
        <div>
          <span style={lbl}>Quality <span style={{ textTransform: 'none', fontWeight: 500 }}>— output follows the motion video's shape</span></span>
          <div style={{ display: 'flex', gap: 8 }}>
            {[{ m: 'std', label: 'Standard · 720p' }, { m: 'pro', label: 'Pro · 1080p' }].map(({ m, label }) => {
              const on = mode === m
              return (
                <button key={m} onClick={() => setMode(m)} style={{
                  padding: '7px 14px', borderRadius: 9, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
                  border: `1.5px solid ${on ? '#8B5CF6' : 'var(--border)'}`,
                  background: on ? 'rgba(139,92,246,0.09)' : 'var(--bg-tertiary)',
                  color: on ? '#7C3AED' : 'var(--text-secondary)',
                }}>{label}</button>
              )
            })}
          </div>
        </div>
      </div>

      {error && <div style={{ fontSize: 13, color: '#FF3B30', background: 'rgba(255,59,48,0.06)', border: '1px solid rgba(255,59,48,0.18)', borderRadius: 10, padding: '10px 14px' }}>{error}</div>}

      {/* Generate / progress */}
      {generating ? (
        <div style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Copying motion onto {influencer?.name || 'influencer'}…</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>{progress > 0 ? `${Math.round(progress)}%` : 'Starting…'}</span>
              <button onClick={cancel} style={{ padding: '3px 10px', borderRadius: 980, fontSize: 11, fontWeight: 600, background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)', border: '1px solid var(--border)', cursor: 'pointer' }}>Cancel</button>
            </div>
          </div>
          <div style={{ height: 6, borderRadius: 980, background: 'var(--bg-tertiary)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.max(3, progress)}%`, background: 'linear-gradient(90deg,#EC4899,#8B5CF6)', borderRadius: 980, transition: 'width 0.5s ease' }} />
          </div>
        </div>
      ) : (
        <button onClick={generate} disabled={!canGenerate} style={{
          padding: '15px', borderRadius: 14, fontSize: 15, fontWeight: 800, border: 'none',
          cursor: canGenerate ? 'pointer' : 'not-allowed',
          background: canGenerate ? 'linear-gradient(135deg,#EC4899,#8B5CF6)' : 'var(--bg-tertiary)',
          color: canGenerate ? '#fff' : 'var(--text-tertiary)',
          boxShadow: canGenerate ? '0 4px 22px rgba(139,92,246,0.35)' : 'none',
        }}>Copy motion →</button>
      )}

      {/* Result */}
      {result && !generating && (
        <div style={card}>
          <span style={lbl}>Result</span>
          <video src={result} controls autoPlay loop style={{ width: '100%', maxHeight: 420, borderRadius: 10, background: '#000', display: 'block', marginBottom: 12 }} />
          <button onClick={() => downloadImage(result, `${(influencer?.name || 'motion').toLowerCase()}-motion.mp4`)} style={{ padding: '9px 16px', borderRadius: 10, fontSize: 13, fontWeight: 600, background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', border: '1px solid var(--border)', cursor: 'pointer' }}>↓ Download</button>
        </div>
      )}
    </div>
  )
}
