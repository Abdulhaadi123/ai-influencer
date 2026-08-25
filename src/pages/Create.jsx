import { useState, useEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import { useNavigate, useLocation } from 'react-router-dom'
import { useInfluencers, generateId } from '../core/store'
import { generateThreeImages } from '../core/services/generation'
import { compressImage } from '../core/platform/media'
import { gColor } from '../core/utils/influencerUtils'
import { COPY_ATTRIBUTES, buildImagePrompts } from '../core/prompts/influencerPrompts'
import { saveCreationParams } from '../core/creationParams'
import { buildNewInfluencer, buildCreationParams } from '../core/newInfluencer'

const STEPS = ['Basics', 'Reference', 'Generate']

// Floating background cards
const ALL_IMGS = ['/inf/i1.png', '/inf/i2.png', '/inf/i3.jpg', '/inf/i4.jpg', '/inf/i5.png', '/inf/i6.jpg', '/inf/i7.png', '/inf/i8.png', '/inf/i9.png', '/inf/i10.png', '/inf/i11.png', '/inf/i12.png', '/inf/i13.png', '/inf/i14.png', '/inf/i15.png', '/inf/i16.png']
const CARD_CONFIG = [
  { left: '1%',  top: '15%', w: 162, rot: '-9deg',  op: 0.48, period: 9,  sway: 12, delay: 0.0 },
  { left: '5%',  top: '58%', w: 140, rot:  '5deg',  op: 0.34, period: 11, sway: 15, delay: 1.9 },
  { right: '1%', top: '10%', w: 170, rot:  '10deg', op: 0.48, period: 10, sway: 13, delay: 0.5 },
  { right: '5%', top: '57%', w: 148, rot: '-6deg',  op: 0.34, period: 12, sway: 16, delay: 1.3 },
]

// Theme tokens
const L = {
  bg: 'var(--bg)',
  surface: 'var(--surface)',
  surfaceAlt: 'var(--bg-tertiary)',
  border: 'var(--border)',
  text: 'var(--text-primary)',
  textSub: 'var(--text-secondary)',
  textFaint: 'var(--text-tertiary)',
  card: 'var(--shadow-md)',
  cardHover: 'var(--shadow-lg)',
}

const inputCls = 'create-input'
const inputStyle = {
  width: '100%', padding: '13px 16px', borderRadius: 12,
  border: `1.5px solid ${L.border}`, background: L.surfaceAlt,
  fontSize: 15, color: L.text, boxSizing: 'border-box',
  outline: 'none', fontFamily: 'inherit',
  transition: 'border-color 0.15s, box-shadow 0.15s',
}
const taStyle = { ...inputStyle, resize: 'vertical', lineHeight: 1.65 }

function Lbl({ children, optional }) {
  return (
    <div style={{ fontSize: 11.5, fontWeight: 700, color: L.textFaint, textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 9, display: 'flex', gap: 7, alignItems: 'center' }}>
      {children}
      {optional && <span style={{ fontSize: 10, fontWeight: 500, color: L.textFaint, textTransform: 'none', letterSpacing: 0 }}>optional</span>}
    </div>
  )
}

// ── Animated floating cards ───────────────────────────────────
function FloatingCards() {
  const [srcs, setSrcs] = useState(() => [ALL_IMGS[0], ALL_IMGS[2], ALL_IMGS[3], ALL_IMGS[5]])
  const [fading, setFading] = useState([false, false, false, false])

  useEffect(() => {
    let alive = true
    function tick() {
      if (!alive) return
      const i = Math.floor(Math.random() * CARD_CONFIG.length)
      setFading(p => { const n = [...p]; n[i] = true; return n })
      setTimeout(() => {
        if (!alive) return
        setSrcs(p => {
          const current = p[i]
          const shown = p.filter((_, idx) => idx !== i)
          const opts = ALL_IMGS.filter(s => !shown.includes(s) && s !== current)
          const next = [...p]; next[i] = opts[Math.floor(Math.random() * opts.length)]; return next
        })
        setFading(p => { const n = [...p]; n[i] = false; return n })
      }, 700)
    }
    const id = setInterval(tick, 3000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  return (
    <>
      {CARD_CONFIG.map((c, i) => (
        <div key={i} className="create-bg-card" style={{
          position: 'absolute', top: c.top,
          ...(c.left ? { left: c.left } : { right: c.right }),
          width: c.w, transform: `rotate(${c.rot})`,
          opacity: 0, '--t-op': c.op,
          animation: `cAppear 0.9s ease ${c.delay + 0.2}s forwards`,
          pointerEvents: 'none', zIndex: 0,
        }}>
          <div style={{
            animation: `cFloat ${c.period}s ease-in-out ${c.delay}s infinite, cSway ${c.sway}s ease-in-out ${c.delay * 0.6}s infinite`,
            borderRadius: 18, overflow: 'hidden',
            boxShadow: '0 24px 64px rgba(0,0,0,0.14), 0 0 0 1px rgba(0,0,0,0.04)',
            opacity: fading[i] ? 0 : 1, transition: 'opacity 0.7s ease',
          }}>
            <img src={srcs[i]} alt="" style={{ width: '100%', aspectRatio: '2/3', objectFit: 'cover', display: 'block' }} />
          </div>
        </div>
      ))}
    </>
  )
}

// ── Step indicator ────────────────────────────────────────────
function StepIndicator({ current }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 52 }}>
      {STEPS.map((label, i) => {
        const n = i + 1; const done = n < current; const active = n === current
        return (
          <div key={n} style={{ display: 'flex', alignItems: 'center', flex: i < STEPS.length - 1 ? 1 : 'none' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
              <div style={{
                width: 30, height: 30, borderRadius: '50%', fontSize: 12, fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                background: done ? 'linear-gradient(135deg,#EC4899,#8B5CF6)' : active ? 'var(--text-primary)' : L.surfaceAlt,
                color: done ? '#fff' : active ? 'var(--bg)' : L.textFaint,
                border: done || active ? 'none' : `1.5px solid ${L.border}`,
                transition: 'all 0.25s',
                boxShadow: active ? '0 0 0 5px rgba(139,92,246,0.12)' : 'none',
              }}>{done ? '✓' : n}</div>
              <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.5px', textTransform: 'uppercase', color: active ? L.text : L.textFaint, whiteSpace: 'nowrap', transition: 'color 0.2s' }}>{label}</span>
            </div>
            {i < STEPS.length - 1 && (
              <div style={{ flex: 1, height: 1.5, background: done ? 'linear-gradient(90deg,#EC4899,#8B5CF6)' : L.border, margin: '0 6px', marginBottom: 22, transition: 'background 0.3s' }} />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Step 1: Basics ────────────────────────────────────────────
function Step1({ data, set, onGenderChange, ageErrorPulse }) {
  return (
    <div>
      <div style={{ marginBottom: 40 }}>
        <h2 style={{ fontSize: 32, fontWeight: 800, letterSpacing: '-1px', color: L.text, marginBottom: 8, lineHeight: 1.1 }}>Name your influencer</h2>
        <p style={{ fontSize: 15, color: L.textSub, lineHeight: 1.55 }}>Just a name and gender to get started.</p>
      </div>

      <div style={{ marginBottom: 22 }}>
        <Lbl>Name</Lbl>
        <input className={inputCls} style={inputStyle} value={data.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Luna Rose" autoFocus />
      </div>

      <div style={{ marginBottom: 22 }}>
        <Lbl>Gender</Lbl>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 10 }}>
          {[
            { g: 'Female', color: '#EC4899', glow: 'rgba(236,72,153,0.10)', icon: '♀' },
            { g: 'Male',   color: '#3B82F6', glow: 'rgba(59,130,246,0.10)', icon: '♂' },
          ].map(({ g, color, glow, icon }) => {
            const on = data.gender === g
            return (
              <button key={g} onClick={() => onGenderChange(g)} style={{
                padding: '15px 10px', borderRadius: 14, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                border: `1.5px solid ${on ? color : L.border}`,
                background: on ? glow : L.surface,
                color: on ? color : L.textSub,
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5,
                boxShadow: on ? L.card : 'none',
                transition: 'all 0.18s',
              }}>
                <span style={{ fontSize: 20, opacity: on ? 1 : 0.3, transition: 'opacity 0.15s' }}>{icon}</span>
                {g}
              </button>
            )
          })}
        </div>
      </div>

      <div style={{ marginBottom: data.age !== '' && Number(data.age) < 18 ? 12 : 0 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 14 }}>
          <div>
            <Lbl optional>Age</Lbl>
            <input className={inputCls} style={inputStyle} type="text" inputMode="numeric" pattern="[0-9]*" value={data.age} onChange={e => set('age', e.target.value.replace(/[^0-9]/g, ''))} placeholder="e.g. 24" />
          </div>
          <div />
        </div>
        {data.age !== '' && Number(data.age) < 18 && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, padding: '9px 13px', borderRadius: 10,
            background: ageErrorPulse ? 'rgba(255,59,48,0.10)' : 'rgba(255,59,48,0.05)',
            border: `1px solid ${ageErrorPulse ? 'rgba(255,59,48,0.35)' : 'rgba(255,59,48,0.14)'}`,
            animation: ageErrorPulse ? 'agePulse 0.4s ease' : 'none',
            transition: 'background 0.2s, border-color 0.2s',
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#FF3B30" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <span style={{ fontSize: 12.5, color: '#FF3B30', fontWeight: 500 }}>Influencer must be 18 or older.</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Step 2: Reference — upload image + select what to copy ────
function Step2({ data, set }) {
  const fileRef = useRef()
  const [dragging, setDragging] = useState(false)
  const dragCounter = useRef(0)

  function processFile(f) {
    if (!f || !f.type.startsWith('image/')) return
    const r = new FileReader()
    r.onload = ev => compressImage(ev.target.result).then(v => set('referenceImage', v)).catch(console.error)
    r.readAsDataURL(f)
  }
  function handleFile(e) { const f = e.target.files[0]; if (!f) return; e.target.value = ''; processFile(f) }
  const dropProps = {
    onDragEnter: e => { e.preventDefault(); dragCounter.current++; setDragging(true) },
    onDragLeave: e => { e.preventDefault(); dragCounter.current--; if (dragCounter.current === 0) setDragging(false) },
    onDragOver: e => e.preventDefault(),
    onDrop: e => { e.preventDefault(); dragCounter.current = 0; setDragging(false); processFile(e.dataTransfer.files[0]) },
  }

  const selected = data.copyAttributes || []
  function toggle(id) {
    set('copyAttributes', selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id])
  }

  return (
    <div>
      <div style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 32, fontWeight: 800, letterSpacing: '-1px', color: L.text, marginBottom: 8, lineHeight: 1.1 }}>Describe or upload</h2>
        <p style={{ fontSize: 15, color: L.textSub, lineHeight: 1.55 }}>Describe your influencer in a prompt, upload a reference to copy from, or do both.</p>
      </div>

      {/* Describe via prompt */}
      <div style={{ background: L.surface, borderRadius: 18, padding: 22, boxShadow: L.card, marginBottom: 18 }}>
        <div style={{ fontSize: 11.5, fontWeight: 700, color: L.textFaint, textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 4 }}>Describe your influencer</div>
        <div style={{ fontSize: 12.5, color: L.textFaint, marginBottom: 12 }}>The AI builds the image from this description. Optional if you upload a reference below.</div>
        <textarea
          className={inputCls}
          value={data.description || ''}
          onChange={e => set('description', e.target.value)}
          placeholder="e.g. 22-year-old woman, olive skin, long dark wavy hair, green eyes, athletic build, wearing a cream linen shirt on a city street…"
          rows={4}
          style={{ ...taStyle, background: L.surfaceAlt }}
        />
      </div>

      {/* and / or divider */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '2px 0 18px' }}>
        <div style={{ flex: 1, height: 1, background: L.border }} />
        <span style={{ fontSize: 11, fontWeight: 700, color: L.textFaint, textTransform: 'uppercase', letterSpacing: '0.6px' }}>and / or</span>
        <div style={{ flex: 1, height: 1, background: L.border }} />
      </div>

      <div style={{ fontSize: 11.5, fontWeight: 700, color: L.textFaint, textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 12 }}>
        Upload a reference <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>— copy a real face or outfit</span>
      </div>

      {/* Upload slot */}
      {data.referenceImage ? (
        <div {...dropProps} style={{ position: 'relative', borderRadius: 16, overflow: 'hidden', maxWidth: 300, margin: '0 auto 26px', boxShadow: L.card, outline: dragging ? '2.5px dashed #8B5CF6' : 'none' }}>
          <img src={data.referenceImage} alt="" style={{ width: '100%', display: 'block', maxHeight: 380, objectFit: 'cover', opacity: dragging ? 0.5 : 1 }} />
          <button onClick={() => set('referenceImage', null)} style={{ position: 'absolute', top: 8, right: 8, width: 28, height: 28, borderRadius: '50%', background: 'rgba(0,0,0,0.60)', color: '#fff', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', cursor: 'pointer' }}>×</button>
        </div>
      ) : (
        <div {...dropProps} onClick={() => fileRef.current.click()} style={{
          aspectRatio: '3/4', maxWidth: 300, margin: '0 auto 26px',
          borderRadius: 16, cursor: 'pointer', transition: 'all 0.18s', padding: 20,
          border: dragging ? '2px dashed #8B5CF6' : '2px dashed var(--border)',
          background: dragging ? 'rgba(139,92,246,0.08)' : L.surfaceAlt,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12,
        }}>
          <div style={{ width: 52, height: 52, borderRadius: 14, background: L.surface, boxShadow: L.card, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, color: dragging ? '#8B5CF6' : L.textFaint }}>{dragging ? '↓' : '+'}</div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: dragging ? '#7C3AED' : L.textSub, marginBottom: 4 }}>{dragging ? 'Drop image' : 'Upload the influencer image'}</div>
            <div style={{ fontSize: 12.5, color: L.textFaint }}>PNG or JPG — a clear photo works best</div>
          </div>
        </div>
      )}
      <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFile} />

      {/* What to copy */}
      <div style={{ background: L.surface, borderRadius: 18, padding: 22, boxShadow: L.card, opacity: data.referenceImage ? 1 : 0.5, pointerEvents: data.referenceImage ? 'auto' : 'none', transition: 'opacity 0.2s' }}>
        <div style={{ fontSize: 11.5, fontWeight: 700, color: L.textFaint, textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 4 }}>What to copy</div>
        <div style={{ fontSize: 12.5, color: L.textFaint, marginBottom: 16 }}>
          {selected.length ? 'The AI keeps these exactly from your image.' : 'Nothing selected — the AI recreates the whole person as-is.'}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
          {COPY_ATTRIBUTES.map(a => {
            const on = selected.includes(a.id)
            return (
              <button key={a.id} onClick={() => toggle(a.id)} style={{
                padding: '11px 13px', borderRadius: 12, cursor: 'pointer', textAlign: 'left',
                background: on ? 'rgba(139,92,246,0.09)' : L.surfaceAlt,
                border: `1.5px solid ${on ? '#8B5CF6' : L.border}`,
                boxShadow: on ? '0 0 0 1px #8B5CF655' : 'none',
                transition: 'all 0.15s', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8,
              }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: on ? '#7C3AED' : L.text, marginBottom: 3 }}>{a.label}</div>
                  <div style={{ fontSize: 11, color: on ? 'rgba(124,58,237,0.6)' : L.textFaint, lineHeight: 1.35 }}>{a.desc}</div>
                </div>
                <div style={{ width: 17, height: 17, borderRadius: 5, flexShrink: 0, marginTop: 1, background: on ? '#8B5CF6' : 'transparent', border: on ? 'none' : `1.5px solid ${L.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {on && <svg width="9" height="7" viewBox="0 0 10 8" fill="none"><path d="M1 4l2.5 2.5L9 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                </div>
              </button>
            )
          })}
        </div>

        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: L.textFaint, textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 6 }}>Anything else to copy <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>optional</span></div>
          <input className={inputCls} value={data.copyNote || ''} onChange={e => set('copyNote', e.target.value)} placeholder="e.g. the tattoo on the left arm, gold necklace…" style={{ ...inputStyle, background: L.surfaceAlt }} />
        </div>
      </div>
    </div>
  )
}

// ── Loading screen ────────────────────────────────────────────
const LOADING_MESSAGES = [
  'sculpting cheekbones to genuinely dangerous levels.',
  'making them objectively better looking than you. nothing personal.',
  'giving them the kind of hot that photographs itself.',
  'adding the natural glow that takes 45 minutes and a ring light to fake.',
  'building a face the camera will not be able to stop looking at.',
  'your influencer will earn more per post than you do per month. congrats.',
  'their first sponsored post will probably cover your rent.',
  'calculating how rich they\'ll make you. the number is motivating.',
  'building someone who will outperform you on every metric. you asked for this.',
  'they have zero imposter syndrome. they ARE the poster. literally.',
  'building the version of you that has their life together.',
  'configuring the \'candid\' smile that is extremely not candid.',
  'making the effortless look. it takes considerable effort.',
  'your influencer will never post from a bad angle because there are none.',
  'this takes a moment. patience is an underrated aesthetic.',
  'still rendering. the GPU is working harder than your influencer ever will.',
  'still going. we are not rushing a face like this.',
  'the face is loading. the face is worth the wait.',
  'they\'re already on someone\'s mood board and they don\'t exist yet.',
  'building someone who will trend before they have a bio.',
  'the algorithm is going to see this person and embarrass itself.',
  'adding the bone structure that gets a table without a reservation.',
  'preserving every detail you told us to keep. exactly.',
  'copying the reference down to the last freckle.',
  'almost there. well. almost almost there.',
  'nearly done. not done. nearly.',
]

const FAKE_WAYPOINTS = [
  [0, 0], [12000, 14], [25000, 27], [38000, 24],
  [52000, 38], [70000, 51], [88000, 49], [105000, 61],
  [122000, 69], [140000, 65], [158000, 74], [180000, 80],
  [205000, 78], [225000, 85], [250000, 89], [300000, 93], [360000, 95],
]

const EST_MS = 120000

function estLabel(aspectRatio, hasRef) {
  const total = EST_MS + (aspectRatio === '16:9' ? 30000 : 0) + (hasRef ? 30000 : 0)
  if (total <= 120000) return '~2 minutes'
  if (total <= 150000) return '~2.5 minutes'
  return '~3 minutes'
}
function estPhrase(aspectRatio, hasRef) {
  const total = EST_MS + (aspectRatio === '16:9' ? 30000 : 0) + (hasRef ? 30000 : 0)
  if (total <= 120000) return 'around 2 minutes'
  if (total <= 150000) return 'around 2.5 minutes'
  return 'around 3 minutes'
}

function GeneratingScreen({ genProgress, aspectRatio, landscape, hasRef = false }) {
  const [fakeProgress, setFakeProgress] = useState(0)
  const [isDipping, setIsDipping] = useState(false)
  const [msgIdx, setMsgIdx] = useState(() => Math.floor(Math.random() * LOADING_MESSAGES.length))
  const [msgVisible, setMsgVisible] = useState(true)
  const msgQueue = useRef([])
  const startRef = useRef(Date.now())
  const prevRef = useRef(0)

  const estimatedMs = EST_MS + (aspectRatio === '16:9' ? 30000 : 0) + (hasRef ? 30000 : 0)
  const scale = estimatedMs / 360000
  const scaledWaypoints = FAKE_WAYPOINTS.map(([t, v]) => [t * scale, v])

  useEffect(() => {
    const id = setInterval(() => {
      if (genProgress >= 100) { setFakeProgress(100); setIsDipping(false); return }
      const elapsed = Date.now() - startRef.current
      let lo = scaledWaypoints[0], hi = scaledWaypoints[scaledWaypoints.length - 1]
      for (let i = 0; i < scaledWaypoints.length - 1; i++) {
        if (elapsed >= scaledWaypoints[i][0] && elapsed < scaledWaypoints[i + 1][0]) {
          lo = scaledWaypoints[i]; hi = scaledWaypoints[i + 1]; break
        }
      }
      const span = hi[0] - lo[0]
      const t = span === 0 ? 1 : Math.min((elapsed - lo[0]) / span, 1)
      const val = Math.round(lo[1] + (hi[1] - lo[1]) * t)
      setIsDipping(val < prevRef.current - 0.5)
      prevRef.current = val
      setFakeProgress(val)
    }, 700)
    return () => clearInterval(id)
  }, [genProgress])

  useEffect(() => {
    const id = setInterval(() => {
      setMsgVisible(false)
      setTimeout(() => {
        setMsgIdx(cur => {
          if (msgQueue.current.length === 0) {
            const all = LOADING_MESSAGES.map((_, i) => i).filter(i => i !== cur)
            for (let i = all.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [all[i], all[j]] = [all[j], all[i]]
            }
            msgQueue.current = all
          }
          return msgQueue.current.shift()
        })
        setMsgVisible(true)
      }, 350)
    }, 6500)
    return () => clearInterval(id)
  }, [])

  const barGradient = isDipping ? 'linear-gradient(90deg,#F59E0B,#EF4444)' : 'linear-gradient(90deg,#EC4899,#8B5CF6)'
  const statusLabel = isDipping ? 'recalibrating...' : fakeProgress >= 88 ? 'almost there...' : 'generating...'

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 28 }}>
        <div style={{
          width: 46, height: 46, borderRadius: 13, flexShrink: 0,
          background: 'linear-gradient(135deg,#EC4899,#8B5CF6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          animation: 'genSpin 4s linear infinite',
          boxShadow: '0 4px 18px rgba(139,92,246,0.45)',
        }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="white"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/></svg>
        </div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: L.text }}>Creating your influencer</div>
          <div style={{ fontSize: 12, color: L.textFaint, marginTop: 2 }}>{estLabel(aspectRatio, hasRef)} — worth every second</div>
        </div>
      </div>

      <div style={{ textAlign: 'center', marginBottom: 16 }}>
        <span style={{ display: 'inline-block', fontSize: 80, fontWeight: 900, lineHeight: 1, letterSpacing: '-4px', color: isDipping ? '#F59E0B' : '#8B5CF6', transition: 'color 0.5s' }}>{fakeProgress}%</span>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase', color: isDipping ? '#F59E0B' : L.textFaint, marginTop: 6, transition: 'color 0.4s' }}>{statusLabel}</div>
      </div>

      <div style={{ marginBottom: 22 }}>
        <div style={{ height: 8, borderRadius: 6, background: 'var(--bg-tertiary)', overflow: 'hidden' }}>
          <div style={{ height: '100%', borderRadius: 6, background: barGradient, width: `${fakeProgress}%`, transition: isDipping ? 'width 1.4s ease, background 0.5s' : 'width 0.9s ease, background 0.5s' }} />
        </div>
      </div>

      <div style={{ textAlign: 'center', marginBottom: 26, minHeight: 20 }}>
        <span style={{ fontSize: 13.5, color: L.textSub, fontStyle: 'italic', opacity: msgVisible ? 1 : 0, transition: 'opacity 0.35s ease' }}>{LOADING_MESSAGES[msgIdx].replace('{est}', estPhrase(aspectRatio, hasRef))}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: landscape ? '1fr' : 'repeat(3,1fr)', gap: 12 }}>
        {(landscape ? [0] : [0, 1, 2]).map(i => (
          <div key={i} style={{
            aspectRatio: landscape ? '16/9' : '2/3', borderRadius: 18,
            background: 'linear-gradient(160deg, #16082e 0%, #1d0c3a 55%, #120820 100%)',
            border: '1.5px solid rgba(139,92,246,0.18)', position: 'relative', overflow: 'hidden',
            boxShadow: '0 8px 32px rgba(139,92,246,0.18)',
          }}>
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(105deg, transparent 30%, rgba(139,92,246,0.13) 50%, transparent 70%)', animation: `shimmerSlide 2.6s ease-in-out ${i * 0.55}s infinite` }} />
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="rgba(139,92,246,0.28)" style={{ animation: `genSpin ${9 + i * 2.5}s linear infinite` }}><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/></svg>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Shared download helper ────────────────────────────────────
async function downloadImage(url, index) {
  try {
    const res = await fetch(url)
    const blob = await res.blob()
    const ext = blob.type.includes('png') ? 'png' : 'jpg'
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `influencer-look-${index + 1}.${ext}`
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    URL.revokeObjectURL(a.href)
  } catch {
    window.open(url, '_blank')
  }
}

// ── Full-size lightbox ────────────────────────────────────────
function Lightbox({ url, index, onClose }) {
  const [downloading, setDownloading] = useState(false)

  useEffect(() => {
    const fn = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [onClose])

  async function dl() { setDownloading(true); await downloadImage(url, index); setDownloading(false) }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 999, background: 'rgba(0,0,0,0.92)', backdropFilter: 'blur(20px)', display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'fadeIn 0.22s ease' }}>
      <div onClick={e => e.stopPropagation()} style={{ position: 'relative', display: 'flex', animation: 'lbIn 0.35s cubic-bezier(0.34,1.42,0.64,1)' }}>
        <img src={url} alt="" style={{ maxHeight: '90vh', maxWidth: '88vw', borderRadius: 20, display: 'block', objectFit: 'contain', boxShadow: '0 40px 120px rgba(0,0,0,0.7)' }} />
        <button onClick={onClose} style={{ position: 'absolute', top: -14, right: -14, width: 36, height: 36, borderRadius: '50%', background: 'rgba(255,255,255,0.14)', border: '1px solid rgba(255,255,255,0.22)', color: '#fff', fontSize: 19, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', backdropFilter: 'blur(12px)' }}>×</button>
        <button onClick={dl} style={{ position: 'absolute', bottom: 14, right: 14, padding: '9px 16px', borderRadius: 10, background: 'rgba(0,0,0,0.68)', border: '1px solid rgba(255,255,255,0.16)', color: '#fff', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', backdropFilter: 'blur(12px)' }}>
          {downloading
            ? <div style={{ width: 13, height: 13, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', animation: 'spin 0.7s linear infinite' }} />
            : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>}
          Download
        </button>
      </div>
    </div>
  )
}

// ── Single variation card ─────────────────────────────────────
function VariationCard({ url, selected, gc, onSelect, index, landscape, onExpand }) {
  const [hovered, setHovered] = useState(false)
  const [downloading, setDownloading] = useState(false)

  async function dl(e) { e.stopPropagation(); if (downloading) return; setDownloading(true); await downloadImage(url, index); setDownloading(false) }
  function expand(e) { e.stopPropagation(); onExpand?.(url) }

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onSelect}
      style={{
        aspectRatio: landscape ? '16/9' : '2/3',
        borderRadius: 18, overflow: 'hidden', cursor: 'pointer',
        border: `2.5px solid ${selected ? gc : hovered ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.06)'}`,
        boxShadow: hovered ? '0 32px 88px rgba(0,0,0,0.46)' : selected ? `0 0 0 3px ${gc}35, 0 16px 48px rgba(0,0,0,0.22)` : L.card,
        position: 'relative', zIndex: hovered ? 20 : selected ? 2 : 1,
        transition: 'transform 0.32s cubic-bezier(0.34,1.32,0.64,1), box-shadow 0.24s, border-color 0.15s',
        transform: hovered ? (landscape ? 'scale(1.04)' : 'scale(1.28)') : selected ? 'scale(1.03)' : 'scale(1)',
        transformOrigin: landscape ? 'center' : 'bottom center',
      }}
    >
      <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      {!selected && (
        <div style={{ position: 'absolute', top: 10, left: 10, width: 24, height: 24, borderRadius: 8, background: 'rgba(0,0,0,0.42)', backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.88)' }}>{index + 1}</div>
      )}
      {hovered && (
        <button onClick={expand} title="Expand" style={{ position: 'absolute', top: 10, right: 10, width: 32, height: 32, borderRadius: 9, background: 'rgba(0,0,0,0.58)', border: '1px solid rgba(255,255,255,0.22)', backdropFilter: 'blur(10px)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', cursor: 'pointer' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 00-2 2v3"/><path d="M21 8V5a2 2 0 00-2-2h-3"/><path d="M3 16v3a2 2 0 002 2h3"/><path d="M16 21h3a2 2 0 002-2v-3"/></svg>
        </button>
      )}
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '50%', background: 'linear-gradient(to top,rgba(0,0,0,0.55) 0%,transparent 100%)', opacity: hovered ? 1 : 0, transition: 'opacity 0.2s', pointerEvents: 'none' }} />
      {hovered && (
        <button onClick={dl} title="Download" style={{ position: 'absolute', bottom: 10, right: 10, width: 34, height: 34, borderRadius: 10, background: 'rgba(0,0,0,0.65)', border: '1px solid rgba(255,255,255,0.18)', backdropFilter: 'blur(10px)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', cursor: 'pointer' }}>
          {downloading
            ? <div style={{ width: 13, height: 13, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', animation: 'spin 0.7s linear infinite' }} />
            : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>}
        </button>
      )}
      {selected && (
        <div style={{ position: 'absolute', top: 10, left: 10, width: 26, height: 26, borderRadius: 8, background: gc, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 2px 12px ${gc}66` }}>
          <svg width="12" height="10" viewBox="0 0 12 10" fill="none"><path d="M1 5l3.5 3.5L11 1" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </div>
      )}
    </div>
  )
}

// ── Step 3: Generate ──────────────────────────────────────────
function Step3({ data, onFinish, onReset }) {
  const [phase, setPhase] = useState('idle')
  const [genProgress, setGenProgress] = useState(0)
  const [genError, setGenError] = useState(null)
  const [variations, setVariations] = useState([])
  const [selected, setSelected] = useState(null)
  const [lightboxUrl, setLightboxUrl] = useState(null)
  const [generatedPrompts, setGeneratedPrompts] = useState([])
  const [aspectRatio, setAspectRatio] = useState('9:16')
  const gc = gColor(data.gender)
  const hasRef = !!data.referenceImage

  async function generate() {
    setPhase('generating'); setGenError(null); setVariations([]); setSelected(null); setGenProgress(5); setLightboxUrl(null)
    try {
      const prompts = buildImagePrompts(data)
      setGeneratedPrompts(prompts)
      const urls = await generateThreeImages({
        prompts, aspectRatio,
        faceRef: data.referenceImage || null,
        onProgress: setGenProgress,
        onPartialResults: partial => setVariations(partial.slice(0, 3)),
      })
      setVariations(urls.slice(0, 3))
      setSelected(0)
      setPhase('done')
    } catch (e) {
      setGenError(e.message); setPhase('error')
    }
  }

  const displayName = data.name?.trim() || 'your influencer'

  return (
    <div>
      {phase !== 'generating' && (
        <div style={{ marginBottom: 36 }}>
          <h2 style={{ fontSize: 32, fontWeight: 800, letterSpacing: '-1px', color: L.text, marginBottom: 8, lineHeight: 1.1 }}>
            {phase === 'done' ? `Which look is ${displayName}?` : 'Generate your influencer'}
          </h2>
          {phase === 'done' && <p style={{ fontSize: 15, color: L.textSub, lineHeight: 1.55 }}>Hover any look to zoom in. Click to pick your favourite.</p>}
        </div>
      )}

      {phase === 'idle' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: L.textFaint }}>Ratio</span>
            {[{ r: '9:16', label: 'Portrait' }, { r: '16:9', label: 'Landscape' }].map(({ r, label }) => {
              const on = aspectRatio === r
              return (
                <button key={r} onClick={() => setAspectRatio(r)} style={{
                  display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 20, cursor: 'pointer',
                  border: `1.5px solid ${on ? '#8B5CF6' : L.border}`, background: on ? 'rgba(139,92,246,0.10)' : 'transparent', transition: 'all 0.12s',
                }}>
                  <div style={{ width: r === '9:16' ? 7 : 12, height: r === '9:16' ? 12 : 7, borderRadius: 1.5, background: on ? '#8B5CF6' : L.textFaint, opacity: on ? 1 : 0.5, flexShrink: 0 }} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: on ? '#8B5CF6' : L.textFaint }}>{label}</span>
                </button>
              )
            })}
          </div>

          <button onClick={generate} style={{
            width: '100%', padding: 22, borderRadius: 16, fontSize: 17, fontWeight: 800,
            background: 'linear-gradient(135deg,#EC4899,#8B5CF6)', color: '#fff', border: 'none', cursor: 'pointer', letterSpacing: '-0.3px',
            boxShadow: '0 6px 36px rgba(139,92,246,0.45)', animation: 'gen-float 3s ease-in-out infinite', transition: 'box-shadow 0.15s',
          }}
            onMouseEnter={e => { e.currentTarget.style.animationPlayState = 'paused'; e.currentTarget.style.transform = 'translateY(-3px)'; e.currentTarget.style.boxShadow = '0 10px 48px rgba(139,92,246,0.60)' }}
            onMouseLeave={e => { e.currentTarget.style.animationPlayState = 'running'; e.currentTarget.style.transform = ''; e.currentTarget.style.boxShadow = '0 6px 36px rgba(139,92,246,0.45)' }}
          >Generate 3 looks →</button>
          <style>{`@keyframes gen-float { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-4px)} }`}</style>
        </div>
      )}

      {phase === 'generating' && variations.length === 0 && (
        <GeneratingScreen genProgress={genProgress} aspectRatio={aspectRatio} landscape={aspectRatio === '16:9'} hasRef={hasRef} />
      )}

      {phase === 'generating' && variations.length > 0 && (() => {
        const isLandscape = aspectRatio === '16:9'
        const total = 3
        return (
          <div>
            <div style={{ fontSize: 13, color: L.textFaint, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'linear-gradient(135deg,#EC4899,#8B5CF6)', animation: 'genSpin 1.2s linear infinite' }} />
              <style>{`@keyframes genSpin{to{transform:rotate(360deg)}}`}</style>
              {variations.length} of {total} ready…
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: isLandscape ? '1fr' : `repeat(${total},1fr)`, gap: 16, marginBottom: 20 }}>
              {Array.from({ length: total }, (_, i) => {
                const url = variations[i]
                return url ? (
                  <VariationCard key={i} url={url} selected={false} gc={gc} onSelect={() => {}} index={i} landscape={isLandscape} onExpand={u => setLightboxUrl(u)} />
                ) : (
                  <div key={i} style={{ borderRadius: 14, overflow: 'hidden', background: 'var(--bg-tertiary)', aspectRatio: isLandscape ? '16/9' : '9/16', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{ width: 22, height: 22, borderRadius: '50%', border: '2.5px solid rgba(139,92,246,0.3)', borderTopColor: '#8B5CF6', animation: 'genSpin 0.8s linear infinite' }} />
                  </div>
                )
              })}
            </div>
          </div>
        )
      })()}

      {phase === 'error' && (
        <div>
          <div style={{ padding: '16px 20px', borderRadius: 14, background: 'rgba(255,59,48,0.06)', border: '1.5px solid rgba(255,59,48,0.18)', marginBottom: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#FF3B30', marginBottom: 5 }}>Generation failed</div>
            <div style={{ fontSize: 13, color: '#FF6B6B', lineHeight: 1.5 }}>{genError}</div>
          </div>
          <button onClick={generate} style={{ width: '100%', padding: 14, borderRadius: 12, fontSize: 14, fontWeight: 700, background: L.surfaceAlt, color: L.text, border: `1.5px solid ${L.border}`, cursor: 'pointer' }}>Try again →</button>
        </div>
      )}

      {phase === 'done' && variations.length > 0 && (
        <div>
          {(() => {
            const isLandscape = aspectRatio === '16:9'
            const n = variations.length
            const outerStyle = isLandscape
              ? { marginBottom: 28 }
              : n === 1 ? { width: 230, margin: '0 auto 28px', paddingTop: 0 }
              : n === 2 ? { marginBottom: 28, paddingTop: 36 }
              : { margin: '0 -155px 28px', paddingTop: 36 }
            return (
              <div style={{ ...outerStyle, overflow: 'visible' }}>
                <div style={{ display: 'grid', gridTemplateColumns: isLandscape ? '1fr' : `repeat(${n},1fr)`, gap: 16, overflow: 'visible' }}>
                  {variations.map((url, i) => (
                    <VariationCard key={i} url={url} selected={selected === i} gc={gc} onSelect={() => setSelected(i)} index={i} landscape={isLandscape} onExpand={u => setLightboxUrl(u)} />
                  ))}
                </div>
              </div>
            )
          })()}

          <button
            onClick={selected !== null ? () => onFinish(variations, selected, aspectRatio, generatedPrompts) : undefined}
            style={{
              width: '100%', padding: 17, borderRadius: 14, fontSize: 15, fontWeight: 700, border: 'none',
              cursor: selected !== null ? 'pointer' : 'default', marginBottom: 10,
              background: selected !== null ? `linear-gradient(135deg,${gc},${gc}bb)` : 'var(--bg-tertiary)',
              color: selected !== null ? '#fff' : L.textFaint,
              boxShadow: selected !== null ? `0 4px 28px ${gc}45` : 'none', transition: 'all 0.25s ease',
            }}
            onMouseEnter={e => { if (selected !== null) { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = `0 8px 38px ${gc}65` } }}
            onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = selected !== null ? `0 4px 28px ${gc}45` : 'none' }}
          >
            {selected !== null ? `Create ${displayName}'s profile →` : 'Select a look to continue'}
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={onReset} style={{ flex: 1, padding: 11, borderRadius: 11, fontSize: 13, fontWeight: 600, background: 'transparent', color: L.textFaint, border: `1.5px solid ${L.border}`, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.96"/></svg>
              Start over
            </button>
            <button onClick={generate} style={{ flex: 1, padding: 11, borderRadius: 11, fontSize: 13, fontWeight: 600, background: 'rgba(139,92,246,0.07)', color: '#7C3AED', border: '1.5px solid rgba(139,92,246,0.20)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/></svg>
              Regenerate
            </button>
          </div>
        </div>
      )}

      {lightboxUrl && <Lightbox url={lightboxUrl} index={0} onClose={() => setLightboxUrl(null)} />}
    </div>
  )
}

// ── Main wizard ───────────────────────────────────────────────
export default function Create() {
  const navigate = useNavigate()
  const location = useLocation()
  const [, setInfluencers] = useInfluencers()
  const [step, setStep] = useState(1)
  const prefill = location.state || {}
  const [data, setData] = useState({
    name: prefill.prefillName || '', gender: prefill.prefillGender || '', age: '',
    description: '', referenceImage: null, copyAttributes: [], copyNote: '',
  })

  const [shakeContinue, setShakeContinue] = useState(false)
  const [ageErrorPulse, setAgeErrorPulse] = useState(false)

  function set(k, v) { setData(prev => ({ ...prev, [k]: v })) }
  function handleGenderChange(g) { setData(prev => ({ ...prev, gender: g })) }

  function canAdvance() {
    if (step === 1) return !!data.name.trim() && !!data.gender
    if (step === 2) return !!data.referenceImage || !!data.description?.trim()
    return true
  }

  function handleContinue() {
    if (step === 1 && data.age !== '' && Number(data.age) < 18) {
      setShakeContinue(true); setAgeErrorPulse(true)
      setTimeout(() => setShakeContinue(false), 500)
      setTimeout(() => setAgeErrorPulse(false), 600)
      return
    }
    setStep(s => s + 1)
  }

  function resetAll() {
    setStep(1)
    setData({ name: '', gender: '', age: '', description: '', referenceImage: null, copyAttributes: [], copyNote: '' })
  }

  function finish(variations, selectedIdx, genAspectRatio, genPrompts = []) {
    try {
      const prompts = Array.isArray(genPrompts) ? genPrompts : [genPrompts]
      const replaceId = prefill.replaceId || null

      const newInf = buildNewInfluencer({
        data, variations, selectedIdx, prompts, replaceId,
      })
      saveCreationParams(newInf.id, buildCreationParams({ data, aspectRatio: genAspectRatio }))
      flushSync(() => {
        if (replaceId) {
          setInfluencers(prev => prev.map(inf => inf.id === replaceId ? { ...inf, ...newInf } : inf))
        } else {
          setInfluencers(prev => [...prev, newInf])
        }
      })

      navigate('/influencers', { state: { selectId: newInf.id } })
    } catch (e) {
      console.error('finish() failed:', e)
      alert('Something went wrong saving your influencer: ' + e.message)
    }
  }

  const isLastStep = step === STEPS.length

  return (
    <div style={{ paddingTop: 'var(--nav-h)', minHeight: '100vh', background: L.bg, position: 'relative', overflow: 'hidden', display: 'flex', alignItems: 'flex-start', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', width: 700, height: 700, top: '-20%', left: '-14%', borderRadius: '50%', background: 'radial-gradient(circle, rgba(236,72,153,0.08) 0%, transparent 65%)', pointerEvents: 'none', animation: 'orbA 18s ease-in-out infinite' }} />
      <div style={{ position: 'absolute', width: 600, height: 600, top: '-14%', right: '-12%', borderRadius: '50%', background: 'radial-gradient(circle, rgba(139,92,246,0.08) 0%, transparent 65%)', pointerEvents: 'none', animation: 'orbB 22s ease-in-out infinite' }} />
      <div style={{ position: 'absolute', width: 500, height: 500, bottom: '-20%', left: '22%', borderRadius: '50%', background: 'radial-gradient(circle, rgba(96,165,250,0.06) 0%, transparent 65%)', pointerEvents: 'none', animation: 'orbC 26s ease-in-out infinite' }} />

      <FloatingCards />

      <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at 50% 42%, transparent 28%, var(--bg) 100%)', pointerEvents: 'none', zIndex: 1 }} />

      <div style={{ width: '100%', maxWidth: 548, padding: '40px 24px 100px', position: 'relative', zIndex: 2 }}>
        <StepIndicator current={step} />

        {step === 1 && <Step1 data={data} set={set} onGenderChange={handleGenderChange} ageErrorPulse={ageErrorPulse} />}
        {step === 2 && <Step2 data={data} set={set} />}
        {step === 3 && <Step3 data={data} onFinish={finish} onReset={resetAll} />}

        {!isLastStep && (
          <div style={{ display: 'flex', gap: 10, marginTop: 36 }}>
            {step > 1 && (
              <button onClick={() => setStep(s => s - 1)} style={{ flexShrink: 0, padding: '13px 22px', borderRadius: 12, border: `1.5px solid ${L.border}`, fontSize: 14, fontWeight: 600, color: L.textSub, background: L.surface, cursor: 'pointer', transition: 'all 0.15s', boxShadow: L.card }}
                onMouseEnter={e => { e.currentTarget.style.color = L.text; e.currentTarget.style.boxShadow = L.cardHover }}
                onMouseLeave={e => { e.currentTarget.style.color = L.textSub; e.currentTarget.style.boxShadow = L.card }}
              >← Back</button>
            )}
            <button onClick={handleContinue} disabled={!canAdvance()} style={{
              flex: 1, padding: '13px 22px', borderRadius: 12, fontSize: 14, fontWeight: 700, border: 'none',
              background: canAdvance() ? 'linear-gradient(135deg,#EC4899,#8B5CF6)' : L.surfaceAlt,
              color: canAdvance() ? '#fff' : L.textFaint,
              boxShadow: canAdvance() ? '0 4px 22px rgba(139,92,246,0.35)' : 'none',
              transition: 'all 0.2s', cursor: canAdvance() ? 'pointer' : 'default',
              animation: shakeContinue ? 'shake 0.45s ease' : 'none',
            }}
              onMouseEnter={e => { if (canAdvance()) { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 6px 30px rgba(139,92,246,0.50)' } }}
              onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = canAdvance() ? '0 4px 22px rgba(139,92,246,0.35)' : 'none' }}
            >{step === 2 ? 'Continue to Generate →' : 'Continue →'}</button>
          </div>
        )}

        {isLastStep && step > 1 && (
          <div style={{ display: 'flex', justifyContent: 'flex-start', marginTop: 14 }}>
            <button onClick={() => setStep(s => s - 1)} style={{ padding: '11px 18px', borderRadius: 10, fontSize: 13, fontWeight: 600, color: L.textSub, background: 'transparent', border: `1.5px solid ${L.border}`, cursor: 'pointer', transition: 'all 0.15s' }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(139,92,246,0.35)'; e.currentTarget.style.color = 'var(--text-primary)' }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = L.border; e.currentTarget.style.color = L.textSub }}
            >← Back</button>
          </div>
        )}
      </div>

      <style>{`
        @media (max-width: 980px) { .create-bg-card { display: none !important; } }
        @keyframes orbA { 0%,100%{transform:translate(0,0)scale(1)} 40%{transform:translate(50px,-40px)scale(1.05)} 70%{transform:translate(-30px,28px)scale(0.96)} }
        @keyframes orbB { 0%,100%{transform:translate(0,0)scale(1)} 50%{transform:translate(-38px,48px)scale(1.08)} }
        @keyframes orbC { 0%,100%{transform:translate(0,0)scale(1)} 35%{transform:translate(28px,-48px)scale(0.93)} 70%{transform:translate(-38px,18px)scale(1.06)} }
        @keyframes cFloat { 0%,100%{transform:translateY(0px)} 50%{transform:translateY(-16px)} }
        @keyframes cSway  { 0%,100%{transform:translateX(0px)} 25%{transform:translateX(5px)} 75%{transform:translateX(-4px)} }
        @keyframes cAppear { from{opacity:0} to{opacity:var(--t-op,0.45)} }
        @keyframes genSpin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
        @keyframes spin { to{transform:rotate(360deg)} }
        @keyframes fadeIn { from{opacity:0} to{opacity:1} }
        @keyframes lbIn { from{opacity:0;transform:scale(0.86)} to{opacity:1;transform:scale(1)} }
        @keyframes shimmerSlide { 0%{transform:translateX(-100%)} 100%{transform:translateX(250%)} }
        @keyframes shake { 0%,100%{transform:translateX(0)} 18%{transform:translateX(-7px)} 36%{transform:translateX(7px)} 54%{transform:translateX(-5px)} 72%{transform:translateX(5px)} 88%{transform:translateX(-2px)} }
        @keyframes agePulse { 0%{transform:scale(1)} 40%{transform:scale(1.015)} 100%{transform:scale(1)} }
        .create-input:focus { border-color: #8B5CF6 !important; box-shadow: 0 0 0 3px rgba(139,92,246,0.12) !important; background: var(--surface) !important; }
        .create-input::placeholder { color: var(--text-tertiary) !important; }
      `}</style>
    </div>
  )
}
