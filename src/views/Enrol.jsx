import { useEffect, useRef, useState } from 'react'
import { initHuman, detect, bestMatch, meanEmbedding } from '../lib/face.js'
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
  const [replacing, setReplacing] = useState(null) // trabalhador cuja biometria está a ser refeita
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
    if (!replacing && workers.some((w) => w.id === id)) return setMsg(t('enrol.errDup', { id }))
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

    // Cada pose guarda a MÉDIA de vários fotogramas seguidos (menos ruído do que um só)
    const FRAMES = 5
    let i = 0
    let frames = []
    while (run.active && i < STEPS.length) {
      const { face } = await detect(videoRef.current)
      const r = face?.rotation?.angle
      setLive(
        !face ? t('enrol.noFace') : !r ? t('enrol.noPose') : `yaw ${r.yaw.toFixed(2)} · pitch ${r.pitch.toFixed(2)} · score ${face.score.toFixed(2)} · ${frames.length}/${FRAMES}`,
      )
      if (face && r && face.score > 0.7 && STEPS[i].ok(r, st)) frames.push(Array.from(face.embedding))
      else frames = []
      if (frames.length >= FRAMES) {
        const avg = meanEmbedding(frames)
        const { worker, similarity } = bestMatch(avg, existing.filter((w) => w.id !== id))
        if (worker && similarity > settings.threshold) {
          setMsg(t('enrol.faceExists', { name: worker.name }))
          return
        }
        if (STEPS[i].side && !st.firstSide) st.firstSide = Math.sign(r.yaw)
        embeddings.push(avg)
        i++
        frames = []
        setStep(i)
        await new Promise((res) => setTimeout(res, 600))
      }
    }
    if (run.active && embeddings.length === STEPS.length) {
      if (replacing) {
        // atualizar a biometria: troca os vetores e mantém SAGE ID, perfil e data de criação
        await saveWorker({ id, name: name.trim(), role: replacing.role, embeddings, createdAt: replacing.createdAt })
        setMsg(t('enrol.doneUpdated', { name: name.trim(), n: embeddings.length }))
        onRegistered?.(null)
      } else {
        // o primeiro registo é sempre Administrador; depois, um Administrador pode registar outros
        const role = !hasUsableAdmin(existing) || makeAdmin ? 'admin' : 'user'
        await saveWorker({ id, name: name.trim(), role, embeddings })
        setMsg(t(role === 'admin' ? 'enrol.doneAdmin' : 'enrol.done', { name: name.trim(), n: embeddings.length }))
        onRegistered?.({ id, name: name.trim(), role })
      }
      setReplacing(null)
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
          <h2>{replacing ? t('enrol.updateTitle', { name: replacing.name }) : t('enrol.title')}</h2>
          <label className="field">
            {t('enrol.sage')}
            <input className="field-input" value={sageId} onChange={(e) => setSageId(e.target.value)} disabled={capturing || !!replacing} inputMode="numeric" autoComplete="off" />
          </label>
          <label className="field">
            {t('enrol.name')}
            <input className="field-input" value={name} onChange={(e) => setName(e.target.value)} disabled={capturing} autoComplete="off" />
          </label>
          <button type="button" className="switch-row" disabled={capturing || firstRegistration || !!replacing} onClick={() => setMakeAdmin(!makeAdmin)}>
            <span>
              {t('enrol.adminProfile')}
              <small>{firstRegistration ? t('enrol.adminFirst') : t('enrol.adminHint')}</small>
            </span>
            <span className={`switch ${makeAdmin || firstRegistration || replacing?.role === 'admin' ? 'on' : ''}`}>
              <i />
            </span>
          </button>
          <p className="notice notice-info">
            {t('enrol.consent')}
          </p>
          {(error || msg) && <p className={`notice ${msg.startsWith('✔') ? 'notice-ok' : 'notice-warn'}`}>{error || msg}</p>}
          <button className="btn btn-primary btn-block" disabled={!ready || loading || capturing} onClick={start}>
            {error ? t('enrol.cameraUnavailable') : loading ? t('enrol.loadingModels') : capturing ? t('enrol.capturing') : replacing ? t('enrol.startUpdate') : t('enrol.start')}
          </button>
          {capturing && (
            <button className="btn btn-ghost btn-block" onClick={() => (runRef.current.active = false)}>
              {t('enrol.cancel')}
            </button>
          )}
          {replacing && !capturing && (
            <button
              className="btn btn-ghost btn-block"
              onClick={() => {
                setReplacing(null)
                setName('')
                setSageId('')
                setMsg('')
              }}
            >
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
                <span className="btn-row">
                  <button
                    className="link-button"
                    disabled={capturing}
                    onClick={() => {
                      setReplacing(w)
                      setSageId(w.id)
                      setName(w.name)
                      setMakeAdmin(w.role === 'admin')
                      setMsg('')
                      window.scrollTo?.({ top: 0 })
                    }}
                  >
                    {t('enrol.updateBiometrics')}
                  </button>
                  {w.role === 'admin' && !w.broken && usableAdmins === 1 && workers.length > 1 ? (
                    <span className="muted">{t('enrol.onlyAdmin')}</span>
                  ) : w.role === 'admin' && !w.broken && usableAdmins === 1 ? (
                    // único trabalhador e único Administrador: pode apagar-se, com confirmação reforçada (escrever o SAGE ID)
                    <button
                      className="link-button"
                      onClick={async () => {
                        const typed = prompt(t('enrol.confirmDeleteAdmin', { name: w.name, id: w.id }))
                        if (typed === null || typed.trim() !== w.id) return
                        try {
                          await deleteWorker(w.id)
                        } catch (e) {
                          return setMsg(e.code === 'LAST_ADMIN' ? t('err.lastAdmin') : String(e.message || e))
                        }
                        await refresh()
                        onRegistered?.(null)
                      }}
                    >
                      {t('enrol.delete')}
                    </button>
                  ) : (
                    <>
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
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
