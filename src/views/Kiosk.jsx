import { useEffect, useRef, useState } from 'react'
import { initHuman, detect, bestMatch, livenessSignals, faceQuality } from '../lib/face.js'
import { listWorkers, enqueuePunch, getClockOffset, pendingPunches } from '../lib/db.js'
import { flushQueue } from '../lib/sync.js'
import { bumpStat } from '../lib/settings.js'
import { useCamera } from '../lib/useCamera.js'

const fmtTime = (iso) => new Date(iso).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })

export default function Kiosk({ settings, online }) {
  const videoRef = useRef(null)
  const { ready, error } = useCamera(videoRef)
  const [loading, setLoading] = useState('A carregar modelos…')
  const [banner, setBanner] = useState({ kind: 'idle', text: 'Aproxime-se da câmara' })
  const [pending, setPending] = useState(0)
  const [debug, setDebug] = useState(null)
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const isIn = settings.direction === 'in'

  useEffect(() => {
    if (!ready) return
    let stop = false
    const lastPunch = new Map() // workerId -> timestamp
    let workers = []
    let track = null // { id, count, blink, turn, start }
    let pauseUntil = 0
    let lastReject = 0

    ;(async () => {
      await initHuman(setLoading)
      setLoading('')
      workers = await listWorkers()
      setPending((await pendingPunches()).length)
      if (!workers.length) setBanner({ kind: 'warn', text: 'Sem trabalhadores registados — use "Registar"' })

      const loop = async () => {
        if (stop) return
        const s = settingsRef.current
        if (performance.now() < pauseUntil) return requestAnimationFrame(loop)
        try {
          const { face, gestures } = await detect(videoRef.current)
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
              direction: s.direction,
              workerId: worker.id,
              workerName: worker.name,
              confidence: similarity,
            })
            lastPunch.set(worker.id, Date.now())
            bumpStat('punches', ms)
            setBanner({
              kind: 'ok',
              text: `Olá, ${worker.name}`,
              sub: `${s.direction === 'in' ? 'Entrada' : 'Saída'} ${fmtTime(punch.punchedAt)}`,
            })
            setPending((await pendingPunches()).length)
            flushQueue(s).then((r) => setPending(r.pending))
            track = null
            pauseUntil = performance.now() + 3500
            setTimeout(() => setBanner({ kind: 'idle', text: 'Aproxime-se da câmara' }), 3500)
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
    }
  }, [ready])

  useEffect(() => {
    getClockOffset() // aquece IndexedDB
  }, [])

  return (
    <div className={`kiosk ${isIn ? 'in' : 'out'}`}>
      <video ref={videoRef} muted playsInline className="mirror" />
      <div className="kiosk-top">
        <span className="dir">{isIn ? 'ENTRADA' : 'SAÍDA'}</span>
        <span className="status">
          <i className={online ? 'dot on' : 'dot off'} /> {online ? 'Online' : 'Offline'} · {pending} por enviar
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
  )
}
