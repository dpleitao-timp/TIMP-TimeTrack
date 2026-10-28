import { useEffect, useRef, useState } from 'react'
import { initHuman, detect, bestMatch, livenessSignals, faceQuality } from '../lib/face.js'
import { listWorkers, enqueuePunch, pendingPunches } from '../lib/db.js'
import { flushQueue } from '../lib/sync.js'
import { bumpStat } from '../lib/settings.js'
import { useCamera } from '../lib/useCamera.js'
import AdminLogin from './AdminLogin.jsx'

const fmtTime = (iso) => new Date(iso).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })
const SCAN_TIMEOUT_MS = 45000 // sem picar, a câmara desliga e volta à escolha
const lastPunch = new Map() // sageId -> timestamp; fica entre leituras para o intervalo mínimo valer

// Ecrã de escolha: a câmara só liga depois de escolher Entrada ou Saída.
export default function Kiosk({ settings, online, hasAdmin, onAdminUnlock }) {
  const [direction, setDirection] = useState(null) // null | 'in' | 'out'
  const [adminLogin, setAdminLogin] = useState(false)
  const [pending, setPending] = useState(0)
  const [modelsError, setModelsError] = useState('')

  useEffect(() => {
    pendingPunches().then((p) => setPending(p.length))
    // modelos pré-carregados para a câmara reconhecer logo ao ligar (a câmara não é ligada aqui)
    initHuman().catch((e) => setModelsError(e?.message || String(e)))
  }, [])

  if (adminLogin) {
    return (
      <AdminLogin
        settings={settings}
        onCancel={() => setAdminLogin(false)}
        onUnlock={(worker) => {
          setAdminLogin(false)
          onAdminUnlock(worker)
        }}
      />
    )
  }

  if (direction) {
    return (
      <Scan
        key={direction}
        settings={settings}
        online={online}
        direction={direction}
        pending={pending}
        setPending={setPending}
        onDone={() => setDirection(null)}
      />
    )
  }

  return (
    <div className="kiosk-wrap">
      <div className="choice">
        <div className="choice-top">
          <span className="header-chip">
            <i className={online ? 'dot dot-on' : 'dot dot-off'} /> {online ? 'Online' : 'Offline'} · {pending} por enviar
          </span>
        </div>
        <h2 className="choice-title">O que vai registar?</h2>
        <p className="muted">Escolha para ligar a câmara.</p>
        <div className="choice-buttons">
          <button type="button" className="choice-btn in" onClick={() => setDirection('in')}>
            <IconIn size={72} />
            <span>Entrada</span>
          </button>
          <button type="button" className="choice-btn out" onClick={() => setDirection('out')}>
            <IconOut size={72} />
            <span>Saída</span>
          </button>
        </div>
        {modelsError && <p className="notice notice-error">Falha a carregar modelos: {modelsError}</p>}
        {hasAdmin && (
          <button type="button" className="btn btn-secondary choice-admin" onClick={() => setAdminLogin(true)}>
            🔒 Administração
          </button>
        )}
        <img src="/timp-logo.png" alt="TIMP" className="choice-logo" />
      </div>
    </div>
  )
}

function Scan({ settings, online, direction, pending, setPending, onDone }) {
  const videoRef = useRef(null)
  const { ready, error } = useCamera(videoRef)
  const [loading, setLoading] = useState('A carregar modelos…')
  const [banner, setBanner] = useState({ kind: 'idle', text: 'Aproxime-se da câmara' })
  const [debug, setDebug] = useState(null)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  const isIn = direction === 'in'

  useEffect(() => {
    if (!ready) return
    let stop = false
    const timers = []
    const startedAt = performance.now()
    let workers = []
    let track = null // { id, count, blink, turn, start }
    let pauseUntil = 0
    let lastReject = 0

    ;(async () => {
      await initHuman(setLoading)
      if (stop) return
      setLoading('')
      workers = await listWorkers()
      if (!workers.length) setBanner({ kind: 'warn', text: 'Sem trabalhadores registados — use "Registar"' })

      const loop = async () => {
        if (stop) return
        const s = settingsRef.current
        if (performance.now() - startedAt > SCAN_TIMEOUT_MS && performance.now() >= pauseUntil) return onDoneRef.current()
        if (performance.now() < pauseUntil) return requestAnimationFrame(loop)
        try {
          const { face, gestures } = await detect(videoRef.current)
          if (stop) return
          if (!face) {
            track = null
            setBanner((b) => (b.kind === 'ok' ? b : { kind: 'idle', text: 'Aproxime-se da câmara' }))
            return requestAnimationFrame(loop)
          }
          const q = faceQuality(face)
          const { worker, similarity } = bestMatch(face.embedding, workers)
          setDebug({ similarity: similarity.toFixed(2), real: q.real?.toFixed?.(2), live: q.live?.toFixed?.(2) })

          if (!q.ok) {
            track = null
            if (performance.now() - lastReject > 2000) bumpStat('spoofRejected')
            lastReject = performance.now()
            setBanner({ kind: 'bad', text: 'Rosto não validado (foto/ecrã?)' })
            return requestAnimationFrame(loop)
          }
          if (!worker || similarity < s.threshold) {
            if (track || performance.now() - lastReject > 2000) bumpStat('unknown')
            lastReject = performance.now()
            track = null
            setBanner({ kind: 'bad', text: 'Não reconhecido' })
            return requestAnimationFrame(loop)
          }

          if (track?.id === worker.id) track.count++
          else track = { id: worker.id, count: 1, blink: false, turn: false, start: performance.now() }
          const sig = livenessSignals(gestures)
          track.blink ||= sig.blink
          track.turn ||= sig.turn

          if (track.count >= s.stableFrames) {
            const alive = !s.liveness || track.blink || track.turn
            if (!alive) {
              setBanner({ kind: 'warn', text: `${worker.name} — pisque os olhos ou vire a cabeça` })
              return requestAnimationFrame(loop)
            }
            const last = lastPunch.get(worker.id) || 0
            if (Date.now() - last < s.cooldownSec * 1000) {
              setBanner({ kind: 'warn', text: `${worker.name} — já picou há instantes` })
              pauseUntil = performance.now() + 2500
              track = null
              return requestAnimationFrame(loop)
            }
            const ms = Math.round(performance.now() - track.start)
            const punch = await enqueuePunch({
              deviceId: s.deviceId,
              direction,
              sageId: worker.id,
              workerName: worker.name,
              confidence: similarity,
            })
            lastPunch.set(worker.id, Date.now())
            bumpStat('punches', ms)
            setBanner({
              kind: 'ok',
              text: `Olá, ${worker.name}`,
              sub: `${isIn ? 'Entrada' : 'Saída'} ${fmtTime(punch.punchedAt)}`,
            })
            setPending((await pendingPunches()).length)
            flushQueue(s).then((r) => setPending(r.pending))
            track = null
            pauseUntil = performance.now() + 3500
            // registado: a câmara desliga e volta ao ecrã de escolha
            timers.push(setTimeout(() => onDoneRef.current(), 3500))
          }
        } catch (e) {
          console.error(e)
        }
        requestAnimationFrame(loop)
      }
      requestAnimationFrame(loop)
    })()

    return () => {
      stop = true
      timers.forEach(clearTimeout)
    }
  }, [ready, direction, setPending])

  return (
    <div className="kiosk-wrap">
      <div className={`kiosk ${isIn ? 'in' : 'out'}`}>
        <video ref={videoRef} muted playsInline className="mirror" />
        <div className="kiosk-top">
          <span className="dir">
            {isIn ? <IconIn size={26} /> : <IconOut size={26} />}
            {isIn ? 'ENTRADA' : 'SAÍDA'}
          </span>
          <span className="header-chip">
            <i className={online ? 'dot dot-on' : 'dot dot-off'} /> {online ? 'Online' : 'Offline'} · {pending} por enviar
          </span>
        </div>
        <div className={`banner ${banner.kind}`}>
          <div className="banner-main">{error || loading || banner.text}</div>
          {banner.sub && !loading && <div className="banner-sub">{banner.sub}</div>}
        </div>
        {debug && (
          <div className="debug" onClick={() => setDebug(null)}>
            sim {debug.similarity} · real {debug.real} · live {debug.live}
          </div>
        )}
      </div>

      <div className="kiosk-dock">
        <button type="button" className="btn btn-secondary dock-back" onClick={onDone}>
          ← Voltar (desligar câmara)
        </button>
        <img src="/timp-logo.png" alt="TIMP" className="dock-logo" />
      </div>
    </div>
  )
}

// Seta a entrar numa porta / seta a sair de uma porta.
function IconIn({ size = 30 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3" />
      <path d="M10 17l5-5-5-5" />
      <path d="M15 12H3" />
    </svg>
  )
}

function IconOut({ size = 30 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  )
}
