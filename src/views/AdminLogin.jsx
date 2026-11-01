import { useEffect, useRef, useState } from 'react'
import { initHuman, detect } from '../lib/face.js'
import { createRecognizer } from '../lib/recognizer.js'
import { listWorkers } from '../lib/db.js'
import { useCamera } from '../lib/useCamera.js'
import { faceLuma, saturation } from '../lib/diag.js'
import { createLightControl, setFrameVars } from '../lib/lightframe.js'
import { BAD_SHOW_MS, isAlive } from '../lib/scanrules.js'
import { useT } from '../lib/i18n.jsx'

const TIMEOUT_MS = 45000

// Acesso à administração por reconhecimento facial: só desbloqueia um Administrador. Comporta-se como o ecrã de picar
// (mesmo reconhecedor, avisos vermelhos só se persistirem, pede o piscar logo que sabe quem é, modo rápido de vida e
// moldura de luz adaptativa), só que no fim desbloqueia em vez de registar uma picagem.
export default function AdminLogin({ settings, onUnlock, onCancel }) {
  const { t } = useT()
  const videoRef = useRef(null)
  const kioskRef = useRef(null)
  const { ready, error } = useCamera(videoRef, { deviceId: settings.cameraId })
  const [loading, setLoading] = useState(t('kiosk.loadingModels'))
  const [banner, setBanner] = useState({ kind: 'idle', text: t('kiosk.approach') })
  const show = (b) => setBanner((cur) => (cur.kind === b.kind && cur.text === b.text ? cur : b))
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
    let badSince = 0 // desde quando o estado é spoof/unknown sem interrupção (0 = não está)

    ;(async () => {
      await initHuman()
      if (stop) return
      setLoading('')
      workers = await listWorkers()
      recognizer = createRecognizer(() => settingsRef.current, workers)
      const autoFrame = settingsRef.current.lightFrameAuto !== false
      const light = createLightControl((v) => setFrameVars(kioskRef.current, v, autoFrame), autoFrame)

      const loop = async () => {
        if (stop) return
        if (performance.now() - startedAt > TIMEOUT_MS) return cb.current.onCancel()
        const s = settingsRef.current
        try {
          const { face, gestures } = await detect(videoRef.current)
          if (stop) return
          const r = recognizer.push(face, gestures)
          if (face) light.update(faceLuma(videoRef.current, face.box), { sat: saturation(videoRef.current) ?? 0 })
          if (r.status === 'hold') return requestAnimationFrame(loop) // falha momentânea do detetor: não mexe no ecrã
          if (r.status === 'none') {
            show({ kind: 'idle', text: t('kiosk.approach') })
            return requestAnimationFrame(loop)
          }
          const now = performance.now()
          const alive = isAlive(s, r)
          if (r.status !== 'spoof' && r.status !== 'unknown') badSince = 0
          if (r.status === 'collecting') {
            show({ kind: 'idle', text: t('kiosk.recognizing') })
            return requestAnimationFrame(loop)
          }
          if (r.status === 'confirming') {
            // já se sabe quem é: se for Administrador e faltar a prova de vida, pede logo para piscar
            show(alive || r.worker.role !== 'admin' ? { kind: 'idle', text: t('kiosk.recognizing') } : { kind: 'warn', text: t('kiosk.blink', { name: r.worker.name }) })
            return requestAnimationFrame(loop)
          }
          if (r.status === 'spoof' || r.status === 'unknown') {
            // estes estados tremem de fotograma para fotograma: o aviso vermelho só aparece se persistir
            badSince ||= now
            if (now - badSince < BAD_SHOW_MS) {
              show({ kind: 'idle', text: t('kiosk.recognizing') })
              return requestAnimationFrame(loop)
            }
            show({ kind: 'bad', text: t(r.status === 'spoof' ? 'kiosk.spoof' : 'kiosk.unknown') })
            return requestAnimationFrame(loop)
          }

          // r.status === 'match'
          if (r.worker.role !== 'admin') {
            show({ kind: 'bad', text: t('admin.notAdmin', { name: r.worker.name }) })
            return requestAnimationFrame(loop)
          }
          if (!alive) {
            show({ kind: 'warn', text: t('kiosk.blink', { name: r.worker.name }) })
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
      <div ref={kioskRef} className="kiosk admin">
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
