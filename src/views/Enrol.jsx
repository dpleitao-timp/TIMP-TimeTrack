import { useEffect, useRef, useState } from 'react'
import { initHuman, detect, bestMatch } from '../lib/face.js'
import { saveWorker, listWorkers, deleteWorker, setWorkerRole, hasUsableAdmin } from '../lib/db.js'
import { useCamera } from '../lib/useCamera.js'
import { useT } from '../lib/i18n.jsx'

// Passos de captura guiada. Cada passo exige uma pose; só o vetor (embedding) é guardado.
const STEPS = [
  { label: 'enrol.step1', ok: (r) => Math.abs(r.yaw) < 0.15 && Math.abs(r.pitch) < 0.15 },
  { label: 'enrol.step2', ok: (r) => Math.abs(r.yaw) > 0.2, side: true },
  { label: 'enrol.step3', ok: (r, st) => Math.abs(r.yaw) > 0.2 && Math.sign(r.yaw) !== st.firstSide, side: true },
  { label: 'enrol.step4', ok: (r) => Math.abs(r.pitch) > 0.12 },
  { label: 'enrol.step5', ok: (r) => Math.abs(r.yaw) < 0.15 && Math.abs(r.pitch) < 0.15 },
]

export default function Enrol({ settings, onRegistered }) {
  const { t } = useT()
  const videoRef = useRef(null)
  const { ready, error } = useCamera(videoRef)
  const [name, setName] = useState('')
  const [sageId, setSageId] = useState('')
  const [makeAdmin, setMakeAdmin] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [step, setStep] = useState(0)
  const [msg, setMsg] = useState('')
  const [loading, setLoading] = useState(true)
  const [live, setLive] = useState('')
  const [workers, setWorkers] = useState([])
  const runRef = useRef({ active: false })

  const refresh = async () => setWorkers(await listWorkers())
  const usableAdmins = workers.filter((w) => w.role === 'admin' && !w.broken).length
  const firstRegistration = usableAdmins === 0

  useEffect(() => {
    refresh()
    if (!ready) return
    initHuman()
      .then(() => setLoading(false))
      .catch((e) => setMsg(t('enrol.errModels', { err: e?.message || e })))
    return () => {
      runRef.current.active = false
    }
  }, [ready])

  async function start() {
    const id = sageId.trim()
    if (!id) return setMsg(t('enrol.errSage'))
    if (!name.trim()) return setMsg(t('enrol.errName'))
    if (workers.some((w) => w.id === id)) return setMsg(t('enrol.errDup', { id }))
    const run = (runRef.current = { active: true })
    setCapturing(true)
    setMsg('')
    setStep(0)
    setLive(t('enrol.starting'))
    try {
      await capture(id, run)
    } catch (e) {
      console.error(e)
      setMsg(t('enrol.errCapture', { err: e?.message || e }))
    } finally {
      setCapturing(false)
    }
  }

  async function capture(id, run) {
    const existing = await listWorkers()
    const embeddings = []
    const st = { firstSide: 0 }

    let i = 0
    let hold = 0
    while (run.active && i < STEPS.length) {
      const { face } = await detect(videoRef.current)
      const r = face?.rotation?.angle
      setLive(
        !face ? t('enrol.noFace') : !r ? t('enrol.noPose') : `yaw ${r.yaw.toFixed(2)} · pitch ${r.pitch.toFixed(2)} · score ${face.score.toFixed(2)}`,
      )
      if (face && r && face.score > 0.7 && STEPS[i].ok(r, st)) hold++
      else hold = 0
      if (hold >= 4) {
        const { worker, similarity } = bestMatch(face.embedding, existing.filter((w) => w.id !== id))
        if (worker && similarity > settings.threshold) {
          setMsg(t('enrol.faceExists', { name: worker.name }))
          return
        }
        if (STEPS[i].side && !st.firstSide) st.firstSide = Math.sign(r.yaw)
        embeddings.push(Array.from(face.embedding))
        i++
        hold = 0
        setStep(i)
        await new Promise((res) => setTimeout(res, 600))
      }
    }
    if (run.active && embeddings.length === STEPS.length) {
      // o primeiro registo é sempre Administrador; depois, um Administrador pode registar outros
      const role = !hasUsableAdmin(existing) || makeAdmin ? 'admin' : 'user'
      await saveWorker({ id, name: name.trim(), role, embeddings })
      setMsg(t(role === 'admin' ? 'enrol.doneAdmin' : 'enrol.done', { name: name.trim(), n: embeddings.length }))
      onRegistered?.({ id, name: name.trim(), role })
      setName('')
      setSageId('')
      setMakeAdmin(false)
      refresh()
    }
  }

  return (
    <div className="page enrol">
      <div className="enrol-cam">
        <video ref={videoRef} muted playsInline className="mirror" />
        {capturing && (
          <div className="banner warn">
            <div className="banner-main">{t(STEPS[Math.min(step, STEPS.length - 1)].label)}</div>
            <div className="banner-sub">
              {step}/{STEPS.length} · {live}
            </div>
          </div>
        )}
      </div>
      <div className="enrol-form">
        <div className="card">
          <h2>{t('enrol.title')}</h2>
          <label className="field">
            {t('enrol.sage')}
            <input className="field-input" value={sageId} onChange={(e) => setSageId(e.target.value)} disabled={capturing} inputMode="numeric" autoComplete="off" />
          </label>
          <label className="field">
            {t('enrol.name')}
            <input className="field-input" value={name} onChange={(e) => setName(e.target.value)} disabled={capturing} autoComplete="off" />
          </label>
          <button type="button" className="switch-row" disabled={capturing || firstRegistration} onClick={() => setMakeAdmin(!makeAdmin)}>
            <span>
              {t('enrol.adminProfile')}
              <small>{firstRegistration ? t('enrol.adminFirst') : t('enrol.adminHint')}</small>
            </span>
            <span className={`switch ${makeAdmin || firstRegistration ? 'on' : ''}`}>
              <i />
            </span>
          </button>
          <p className="notice notice-info">
            {t('enrol.consent')}
          </p>
          {(error || msg) && <p className={`notice ${msg.startsWith('✔') ? 'notice-ok' : 'notice-warn'}`}>{error || msg}</p>}
          <button className="btn btn-primary btn-block" disabled={!ready || loading || capturing} onClick={start}>
            {error ? t('enrol.cameraUnavailable') : loading ? t('enrol.loadingModels') : capturing ? t('enrol.capturing') : t('enrol.start')}
          </button>
          {capturing && (
            <button className="btn btn-ghost btn-block" onClick={() => (runRef.current.active = false)}>
              {t('enrol.cancel')}
            </button>
          )}
        </div>

        <h3>{t('enrol.registered', { n: workers.length })}</h3>
        <div className="card">
          <ul className="workers">
            {!workers.length && <li className="muted">{t('enrol.none')}</li>}
            {workers.map((w) => (
              <li key={w.id}>
                <span>
                  {w.name} {w.role === 'admin' && <span className="pill pill-ok">{t('enrol.adminBadge')}</span>}
                  <small>{t('enrol.sage')} {w.id} · {w.broken ? t('enrol.unreadable') : t('enrol.vectors', { n: w.embeddings.length })}</small>
                </span>
                {w.role === 'admin' && !w.broken && usableAdmins === 1 ? (
                  <span className="muted">{t('enrol.onlyAdmin')}</span>
                ) : (
                  <span className="btn-row">
                    {!w.broken && (
                      <button
                        className="link-button"
                        onClick={async () => {
                          try {
                            await setWorkerRole(w.id, w.role === 'admin' ? 'user' : 'admin')
                          } catch (e) {
                            return setMsg(e.code === 'LAST_ADMIN' ? t('err.lastAdmin') : String(e.message || e))
                          }
                          await refresh()
                          onRegistered?.(null)
                        }}
                      >
                        {w.role === 'admin' ? t('enrol.removeAdmin') : t('enrol.makeAdmin')}
                      </button>
                    )}
                    <button
                      className="link-button"
                      onClick={async () => {
                        if (confirm(t('enrol.confirmDelete', { name: w.name }))) {
                          try {
                            await deleteWorker(w.id)
                          } catch (e) {
                            return setMsg(e.code === 'LAST_ADMIN' ? t('err.lastAdmin') : String(e.message || e))
                          }
                          await refresh()
                          onRegistered?.(null)
                        }
                      }}
                    >
                      {t('enrol.delete')}
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
