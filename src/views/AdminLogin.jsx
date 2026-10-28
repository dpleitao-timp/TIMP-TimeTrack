import { useEffect, useRef, useState } from 'react'
import { initHuman, detect, bestMatch, livenessSignals, faceQuality } from '../lib/face.js'
import { listWorkers } from '../lib/db.js'
import { useCamera } from '../lib/useCamera.js'

const TIMEOUT_MS = 45000

// Acesso à administração por reconhecimento facial: só desbloqueia um Administrador.
export default function AdminLogin({ settings, onUnlock, onCancel }) {
  const videoRef = useRef(null)
  const { ready, error } = useCamera(videoRef)
  const [loading, setLoading] = useState('A carregar modelos…')
  const [banner, setBanner] = useState({ kind: 'idle', text: 'Aproxime-se da câmara' })
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const cb = useRef({ onUnlock, onCancel })
  cb.current = { onUnlock, onCancel }

  useEffect(() => {
    if (!ready) return
    let stop = false
    const startedAt = performance.now()
    let track = null
    let workers = []

    ;(async () => {
      await initHuman(setLoading)
      if (stop) return
      setLoading('')
      workers = await listWorkers()

      const loop = async () => {
        if (stop) return
        if (performance.now() - startedAt > TIMEOUT_MS) return cb.current.onCancel()
        const s = settingsRef.current
        try {
          const { face, gestures } = await detect(videoRef.current)
          if (stop) return
          if (!face) {
            track = null
            setBanner({ kind: 'idle', text: 'Aproxime-se da câmara' })
            return requestAnimationFrame(loop)
          }
          if (!faceQuality(face).ok) {
            track = null
            setBanner({ kind: 'bad', text: 'Rosto não validado (foto/ecrã?)' })
            return requestAnimationFrame(loop)
          }
          const { worker, similarity } = bestMatch(face.embedding, workers)
          if (!worker || similarity < s.threshold) {
            track = null
            setBanner({ kind: 'bad', text: 'Não reconhecido' })
            return requestAnimationFrame(loop)
          }
          if (worker.role !== 'admin') {
            track = null
            setBanner({ kind: 'bad', text: `${worker.name} — sem perfil de Administrador` })
            return requestAnimationFrame(loop)
          }
          if (track?.id === worker.id) track.count++
          else track = { id: worker.id, count: 1, blink: false, turn: false }
          const sig = livenessSignals(gestures)
          track.blink ||= sig.blink
          track.turn ||= sig.turn
          if (track.count >= s.stableFrames) {
            if (s.liveness && !track.blink && !track.turn) {
              setBanner({ kind: 'warn', text: `${worker.name} — pisque os olhos ou vire a cabeça` })
            } else {
              stop = true
              return cb.current.onUnlock(worker)
            }
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

  return (
    <div className="kiosk-wrap">
      <div className="kiosk admin">
        <video ref={videoRef} muted playsInline className="mirror" />
        <div className="kiosk-top">
          <span className="dir">🔒 ADMINISTRAÇÃO</span>
        </div>
        <div className={`banner ${banner.kind}`}>
          <div className="banner-main">{error || loading || banner.text}</div>
          {!loading && !error && <div className="banner-sub">Reconhecimento do Administrador</div>}
        </div>
      </div>
      <div className="kiosk-dock">
        <button type="button" className="btn btn-secondary dock-back" onClick={onCancel}>
          ← Voltar (desligar câmara)
        </button>
        <img src="/timp-logo.png" alt="TIMP" className="dock-logo" />
      </div>
    </div>
  )
}
