import { useEffect, useRef, useState } from 'react'
import { initHuman, detect, bestMatch, meanEmbedding } from '../lib/face.js'
import { engineTag, thresholdFor, isBioConfigured } from '../lib/settings.js'
import { saveWorker, listWorkers, deleteWorker, setWorkerRole, hasUsableAdmin, isUsable, listRoster, rosterMeta } from '../lib/db.js'
import { useCamera } from '../lib/useCamera.js'
import { createLightControl, setFrameVars } from '../lib/lightframe.js'
import { faceLuma, saturation } from '../lib/diag.js'
import { useT } from '../lib/i18n.jsx'

// Passos de captura guiada. Cada passo exige uma pose; só o vetor (embedding) é guardado.
const STEPS = [
  { label: 'enrol.step1', ok: (r) => Math.abs(r.yaw) < 0.15 && Math.abs(r.pitch) < 0.15 },
  { label: 'enrol.step2', ok: (r) => Math.abs(r.yaw) > 0.2, side: true },
  { label: 'enrol.step3', ok: (r, st) => Math.abs(r.yaw) > 0.2 && Math.sign(r.yaw) !== st.firstSide, side: true },
  { label: 'enrol.step4', ok: (r) => Math.abs(r.pitch) > 0.12 },
  { label: 'enrol.step5', ok: (r) => Math.abs(r.yaw) < 0.15 && Math.abs(r.pitch) < 0.15 },
]

// Captura adicional com equipamento de proteção (capacete, óculos): acrescenta vetores aos já existentes,
// para o reconhecimento funcionar também com o equipamento posto.
const PPE_STEPS = [
  { label: 'enrol.ppe1', ok: STEPS[0].ok },
  { label: 'enrol.ppe2', ok: STEPS[1].ok, side: true },
  { label: 'enrol.ppe3', ok: STEPS[2].ok, side: true },
]

export default function Enrol({ settings, onRegistered }) {
  const { t } = useT()
  const videoRef = useRef(null)
  const camBoxRef = useRef(null)
  const lightRef = useRef(null) // moldura de luz, a mesma do ecrã de leitura
  const { ready, error } = useCamera(videoRef, { deviceId: settings.cameraId })
  const [name, setName] = useState('')
  const [sageId, setSageId] = useState('')
  const [makeAdmin, setMakeAdmin] = useState(false)
  const [replacing, setReplacing] = useState(null) // trabalhador cuja biometria está a ser refeita
  const [adding, setAdding] = useState(null) // trabalhador a quem se acrescenta uma captura com equipamento de proteção
  const [capturing, setCapturing] = useState(false)
  const [step, setStep] = useState(0)
  const [msg, setMsg] = useState('')
  const [loading, setLoading] = useState(true)
  const [live, setLive] = useState('')
  const [workers, setWorkers] = useState([])
  const [roster, setRoster] = useState([]) // lista de trabalhadores da obra (vem do relay)
  const [rosterAt, setRosterAt] = useState(0) // quando foi sincronizada (0 = nunca)
  const runRef = useRef({ active: false })

  // Moldura branca à volta da câmara, como no ecrã de leitura, para os vetores serem tirados com a luz que o ecrã dá
  // depois na leitura (sem isto, em pouca luz o registo e a leitura têm luzes diferentes). Mais pequena, porque a caixa é menor.
  useEffect(() => {
    const auto = settings.lightFrameAuto !== false
    lightRef.current = createLightControl((v) => setFrameVars(camBoxRef.current, v, auto, 1, true), auto)
    return () => {
      lightRef.current = null
    }
  }, [settings.lightFrameAuto])

  const refresh = async () => {
    setWorkers(await listWorkers())
    setRoster(await listRoster())
    setRosterAt((await rosterMeta()).at)
  }
  const pickWorker = (w) => {
    setSageId(w.sageId)
    setName(w.name)
    setMsg('')
  }
  const enrolledIds = new Set(workers.map((w) => w.id))
  // Registado neste tablet mas já fora da lista da obra (saiu da obra, ou ainda não entrou). Só é um aviso:
  // não bloqueia nada; serve para o Administrador ver quem apagar. Sem lista sincronizada não se avisa.
  const outOfRoster = (w) => rosterAt > 0 && !roster.some((r) => r.sageId === w.id)
  const outCount = workers.filter(outOfRoster).length
  const toEnrol = roster.filter((w) => !enrolledIds.has(w.sageId))
  const notInRoster = roster.length > 0 && !replacing && !adding && sageId.trim() !== '' && !roster.some((w) => w.sageId === sageId.trim())
  const usableAdmins = workers.filter((w) => w.role === 'admin' && isUsable(w)).length
  const firstRegistration = usableAdmins === 0
  const steps = adding ? PPE_STEPS : STEPS

  useEffect(() => {
    window.addEventListener('roster-updated', refresh)
    return () => window.removeEventListener('roster-updated', refresh)
  }, [])

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
    if (!replacing && !adding && workers.some((w) => w.id === id)) return setMsg(t('enrol.errDup', { id }))
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
    while (run.active && i < steps.length) {
      const { face } = await detect(videoRef.current)
      if (face) lightRef.current?.update(faceLuma(videoRef.current, face.box), { sat: saturation(videoRef.current) ?? 0 }) // a luz da cara decide a moldura
      const r = face?.rotation?.angle
      setLive(
        !face ? t('enrol.noFace') : !r ? t('enrol.noPose') : `yaw ${r.yaw.toFixed(2)} · pitch ${r.pitch.toFixed(2)} · score ${face.score.toFixed(2)} · ${frames.length}/${FRAMES}`,
      )
      if (face && r && face.score > 0.7 && steps[i].ok(r, st)) frames.push(Array.from(face.embedding))
      else frames = []
      if (frames.length >= FRAMES) {
        const avg = meanEmbedding(frames)
        const { worker, similarity } = bestMatch(avg, existing.filter((w) => w.id !== id))
        if (worker && similarity > thresholdFor(settings)) {
          setMsg(t('enrol.faceExists', { name: worker.name }))
          return
        }
        if (steps[i].side && !st.firstSide) st.firstSide = Math.sign(r.yaw)
        embeddings.push(avg)
        i++
        frames = []
        setStep(i)
        await new Promise((res) => setTimeout(res, 600))
      }
    }
    if (run.active && embeddings.length === steps.length) {
      if (adding) {
        // acrescenta as novas capturas às existentes (mantém SAGE ID, perfil e data de criação)
        const all = [...adding.embeddings, ...embeddings]
        await saveWorker({ id, name: name.trim(), role: adding.role, embeddings: all, createdAt: adding.createdAt, engine: engineTag() })
        setMsg(t('enrol.donePpe', { name: name.trim(), n: all.length }))
        onRegistered?.(null)
      } else if (replacing) {
        // atualizar a biometria: troca os vetores e mantém SAGE ID, perfil e data de criação
        await saveWorker({ id, name: name.trim(), role: replacing.role, embeddings, createdAt: replacing.createdAt, engine: engineTag() })
        setMsg(t('enrol.doneUpdated', { name: name.trim(), n: embeddings.length }))
        onRegistered?.(null)
      } else {
        // o primeiro registo é sempre Administrador; depois, um Administrador pode registar outros
        const role = !hasUsableAdmin(existing) || makeAdmin ? 'admin' : 'user'
        await saveWorker({ id, name: name.trim(), role, embeddings, engine: engineTag() })
        setMsg(t(role === 'admin' ? 'enrol.doneAdmin' : 'enrol.done', { name: name.trim(), n: embeddings.length }))
        onRegistered?.({ id, name: name.trim(), role })
      }
      setReplacing(null)
      setAdding(null)
      setName('')
      setSageId('')
      setMakeAdmin(false)
      refresh()
    }
  }


  // ações da lista de trabalhadores
  const startReplace = (w) => {
    setReplacing(w)
    setAdding(null)
    setSageId(w.id)
    setName(w.name)
    setMakeAdmin(w.role === 'admin')
    setMsg('')
    window.scrollTo?.({ top: 0 })
  }
  const startAdd = (w) => {
    setAdding(w)
    setReplacing(null)
    setSageId(w.id)
    setName(w.name)
    setMakeAdmin(w.role === 'admin')
    setMsg('')
    window.scrollTo?.({ top: 0 })
  }
  const toggleRole = async (w) => {
    try {
      await setWorkerRole(w.id, w.role === 'admin' ? 'user' : 'admin')
    } catch (e) {
      return setMsg(e.code === 'LAST_ADMIN' ? t('err.lastAdmin') : String(e.message || e))
    }
    await refresh()
    onRegistered?.(null)
  }
  // strong: único trabalhador e único Administrador, com confirmação reforçada (escrever o SAGE ID)
  const removeWorker = async (w, strong) => {
    if (strong) {
      const typed = prompt(t('enrol.confirmDeleteAdmin', { name: w.name, id: w.id }))
      if (typed === null || typed.trim() !== w.id) return
    } else if (!confirm(t(isBioConfigured(settings) ? 'enrol.confirmDeleteAll' : 'enrol.confirmDelete', { name: w.name }))) {
      return
    }
    try {
      await deleteWorker(w.id)
    } catch (e) {
      return setMsg(e.code === 'LAST_ADMIN' ? t('err.lastAdmin') : String(e.message || e))
    }
    await refresh()
    onRegistered?.(null)
  }

  return (
    <div className="page enrol">
      <div className="enrol-cam" ref={camBoxRef}>
        <video ref={videoRef} muted playsInline className="mirror" />
        {capturing && (
          <div className="banner warn">
            <div className="banner-main">{t(steps[Math.min(step, steps.length - 1)].label)}</div>
            <div className="banner-sub">
              {step}/{steps.length} · {live}
            </div>
          </div>
        )}
      </div>
      <div className="enrol-form">
        <div className="card">
          <h2>{adding ? t('enrol.addPpeTitle', { name: adding.name }) : replacing ? t('enrol.updateTitle', { name: replacing.name }) : t('enrol.title')}</h2>
          {roster.length > 0 && !replacing && !adding && toEnrol.length > 0 && (
            <div className="roster-chips">
              <span className="muted">{t('enrol.toEnrol', { n: toEnrol.length })}</span>
              <div>
                {toEnrol.map((w) => (
                  <button
                    key={w.sageId}
                    type="button"
                    className={`chip ${w.sageId === sageId.trim() ? 'on' : ''}`}
                    disabled={capturing}
                    onClick={() => pickWorker(w)}
                  >
                    {w.name}
                    <small>{w.sageId}</small>
                  </button>
                ))}
              </div>
            </div>
          )}
          <label className="field">
            {t('enrol.sage')}
            <input className="field-input" value={sageId} onChange={(e) => setSageId(e.target.value)} disabled={capturing || !!replacing || !!adding} inputMode="numeric" autoComplete="off" />
          </label>
          <label className="field">
            {t('enrol.name')}
            <input className="field-input" value={name} onChange={(e) => setName(e.target.value)} disabled={capturing} autoComplete="off" />
          </label>
          {notInRoster && <p className="notice notice-warn">{t('enrol.notInRoster')}</p>}
          <button type="button" className="switch-row" disabled={capturing || firstRegistration || !!replacing || !!adding} onClick={() => setMakeAdmin(!makeAdmin)}>
            <span>
              {t('enrol.adminProfile')}
              <small>{firstRegistration ? t('enrol.adminFirst') : t('enrol.adminHint')}</small>
            </span>
            <span className={`switch ${makeAdmin || firstRegistration || replacing?.role === 'admin' || adding?.role === 'admin' ? 'on' : ''}`}>
              <i />
            </span>
          </button>
          <p className="notice notice-info">
            {t('enrol.consent')}
          </p>
          {(error || msg) && <p className={`notice ${msg.startsWith('✔') ? 'notice-ok' : 'notice-warn'}`}>{error || msg}</p>}
          <button className="btn btn-primary btn-block" disabled={!ready || loading || capturing} onClick={start}>
            {error ? t('enrol.cameraUnavailable') : loading ? t('enrol.loadingModels') : capturing ? t('enrol.capturing') : adding ? t('enrol.startPpe') : replacing ? t('enrol.startUpdate') : t('enrol.start')}
          </button>
          {capturing && (
            <button className="btn btn-ghost btn-block" onClick={() => (runRef.current.active = false)}>
              {t('enrol.cancel')}
            </button>
          )}
          {(replacing || adding) && !capturing && (
            <button
              className="btn btn-ghost btn-block"
              onClick={() => {
                setReplacing(null)
                setAdding(null)
                setName('')
                setSageId('')
                setMsg('')
              }}
            >
              {t('enrol.cancel')}
            </button>
          )}
        </div>

      </div>
      <div className="enrol-registered">
          <h3>{t('enrol.registered', { n: workers.length })}</h3>
          {outCount > 0 && <p className="notice notice-warn">{t('enrol.outOfRosterSummary', { n: outCount })}</p>}
          <div className="card">
            <ul className="workers">
              {!workers.length && <li className="muted">{t('enrol.none')}</li>}
              {workers.map((w) => (
                <li key={w.id}>
                  <span>
                    {w.name} {w.role === 'admin' && <span className="pill pill-ok">{t('enrol.adminBadge')}</span>}{' '}
                    {outOfRoster(w) && <span className="pill pill-warn">{t('enrol.outOfRoster')}</span>}
                    <small>{t('enrol.sage')} {w.id} · {w.broken ? t('enrol.unreadable') : w.stale ? <span className="stale-flag" role="img" title={t('enrol.updateBiometrics')} aria-label={t('enrol.updateBiometrics')}><IconAlert /></span> : t('enrol.vectors', { n: w.embeddings.length })}</small>
                  </span>
                  <span className="row-actions">
                    {/* Ordem fixa, com o Administrador primeiro e um espaço vazio quando falta um botão, para os ícones ficarem alinhados em todas as linhas */}
                    {w.broken ? (
                      <span className="icon-slot" />
                    ) : w.role === 'admin' && isUsable(w) && usableAdmins === 1 ? (
                      // único Administrador ativo: não pode perder o perfil
                      <IconButton label={t('enrol.adminBadge')} disabled on>
                        <IconShield checked />
                      </IconButton>
                    ) : (
                      <IconButton label={w.role === 'admin' ? t('enrol.removeAdmin') : t('enrol.makeAdmin')} on={w.role === 'admin'} onClick={() => toggleRole(w)}>
                        <IconShield checked={w.role === 'admin'} />
                      </IconButton>
                    )}
                    <IconButton label={t('enrol.updateBiometrics')} disabled={capturing} onClick={() => startReplace(w)}>
                      <IconFace />
                    </IconButton>
                    {isUsable(w) ? (
                      <IconButton label={t('enrol.addPpe')} disabled={capturing} onClick={() => startAdd(w)}>
                        <IconCameraPlus />
                      </IconButton>
                    ) : (
                      <span className="icon-slot" />
                    )}
                    {/* o único Administrador só se apaga se for também o único trabalhador, com confirmação reforçada (escrever o SAGE ID) */}
                    <IconButton
                      label={t('enrol.delete')}
                      danger
                      disabled={w.role === 'admin' && isUsable(w) && usableAdmins === 1 && workers.length > 1}
                      onClick={() => removeWorker(w, w.role === 'admin' && isUsable(w) && usableAdmins === 1)}
                    >
                      <IconTrash />
                    </IconButton>
                  </span>
                </li>
              ))}
            </ul>
          </div>
      </div>
    </div>
  )
}

// Botão quadrado só com ícone (a etiqueta fica no tooltip e para leitores de ecrã).
function IconButton({ label, children, danger, on, ...rest }) {
  return (
    <button type="button" className={`icon-btn${danger ? ' danger' : ''}${on ? ' on' : ''}`} title={label} aria-label={label} {...rest}>
      {children}
    </button>
  )
}

const svgProps = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }

// Rosto dentro de uma moldura de leitura: atualizar a biometria
const IconFace = () => (
  <svg {...svgProps}>
    <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
    <circle cx="9.2" cy="10.2" r="0.6" fill="currentColor" />
    <circle cx="14.8" cy="10.2" r="0.6" fill="currentColor" />
    <path d="M9 14.5c.8.9 1.8 1.3 3 1.3s2.2-.4 3-1.3" />
  </svg>
)
// Câmara com um mais: adicionar capturas
const IconCameraPlus = () => (
  <svg {...svgProps}>
    <path d="M4 8h3l1.5-2h5L15 8h5v11H4z" />
    <path d="M12 11.2v4.6M9.7 13.5h4.6" />
  </svg>
)
// Escudo (com visto quando já é Administrador): perfil de Administrador
const IconShield = ({ checked }) => (
  <svg {...svgProps}>
    <path d="M12 3l7 3v5.5c0 4.2-2.8 7.6-7 9.5-4.2-1.9-7-5.3-7-9.5V6z" />
    {checked ? <path d="M8.7 12.2l2.4 2.4 4.2-4.6" /> : <path d="M12 9v5M9.5 11.5h5" />}
  </svg>
)
// Círculo com ponto de exclamação: a biometria é de um motor antigo e tem de ser atualizada
const IconAlert = () => (
  <svg {...svgProps}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5.5" />
    <circle cx="12" cy="16.4" r="0.7" fill="currentColor" />
  </svg>
)
// Caixote do lixo: apagar
const IconTrash = () => (
  <svg {...svgProps}>
    <path d="M4 7h16M9 7V4.5h6V7M6.5 7l.8 12.5h9.4L17.5 7M10 11v5M14 11v5" />
  </svg>
)
