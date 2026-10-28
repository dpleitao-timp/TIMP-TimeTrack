import { useEffect, useRef, useState } from 'react'
import { initHuman, detect } from '../lib/face.js'
import { createRecognizer } from '../lib/recognizer.js'
import { listWorkers } from '../lib/db.js'
import { useCamera } from '../lib/useCamera.js'
import { useT } from '../lib/i18n.jsx'

const TIMEOUT_MS = 45000

// Acesso à administração por reconhecimento facial: só desbloqueia um Administrador.
export default function AdminLogin({ settings, onUnlock, onCancel }) {
  const { t } = useT()
  const videoRef = useRef(null)
  const { ready, error } = useCamera(videoRef)
  const [loading, setLoading] = useState(t('kiosk.loadingModels'))
  const [banner, setBanner] = useState({ kind: 'idle', text: t('kiosk.approach') })
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const cb = useRef({ onUnlock, onCancel })
  cb.current = { onUnlock, onCancel }

  useEffect(() => {
    if (!ready) return
    let stop = false
    const startedAt = performance.now()
    let recognizer = null
    let workers = []

    ;(async () => {
      await initHuman()
      if (stop) return
      setLoading('')
      workers = await listWorkers()
      recognizer = createRecognizer(() => settingsRef.current, workers)

      const loop = async () => {
        if (stop) return
        if (performance.now() - startedAt > TIMEOUT_MS) return cb.current.onCancel()
        const s = settingsRef.current
        try {
          const { face, gestures } = await detect(videoRef.current)
          if (stop) return
          const r = recognizer.push(face, gestures)
          if (r.status === 'none') {
            setBanner({ kind: 'idle', text: t('kiosk.approach') })
            return requestAnimationFrame(loop)
          }
          if (r.status === 'collecting' || r.status === 'confirming') {
            setBanner({ kind: 'idle', text: t('kiosk.recognizing') })
            return requestAnimationFrame(loop)
          }
          if (r.status === 'spoof') {
            setBanner({ kind: 'bad', text: t('kiosk.spoof') })
            return requestAnimationFrame(loop)
          }
          if (r.status === 'unknown') {
            setBanner({ kind: 'bad', text: t('kiosk.unknown') })
            return requestAnimationFrame(loop)
          }
          if (r.worker.role !== 'admin') {
            setBanner({ kind: 'bad', text: t('admin.notAdmin', { name: r.worker.name }) })
            return requestAnimationFrame(loop)
          }
          if (s.liveness && !r.blink && !r.turn) {
            setBanner({ kind: 'warn', text: t('kiosk.blink', { name: r.worker.name }) })
          } else {
            stop = true
            return cb.current.onUnlock(r.worker)
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
          <span className="dir">🔒 {t('admin.title')}</span>
        </div>
        <div className={`banner ${banner.kind}`}>
          <div className="banner-main">{error || loading || banner.text}</div>
          {!loading && !error && <div className="banner-sub">{t('admin.sub')}</div>}
        </div>
      </div>
      <div className="kiosk-dock">
        <button type="button" className="btn btn-secondary dock-back" onClick={onCancel}>
          {t('kiosk.back')}
        </button>
      </div>
    </div>
  )
}
