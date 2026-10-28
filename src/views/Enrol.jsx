import { useEffect, useRef, useState } from 'react'
import { initHuman, detect, bestMatch } from '../lib/face.js'
import { saveWorker, listWorkers, deleteWorker, setWorkerRole, hasUsableAdmin } from '../lib/db.js'
import { useCamera } from '../lib/useCamera.js'

// Passos de captura guiada. Cada passo exige uma pose; só o vetor (embedding) é guardado.
const STEPS = [
  { label: 'Olhe de frente', ok: (r) => Math.abs(r.yaw) < 0.15 && Math.abs(r.pitch) < 0.15 },
  { label: 'Vire a cabeça um pouco para um lado', ok: (r) => Math.abs(r.yaw) > 0.2, side: true },
  { label: 'Agora para o lado oposto', ok: (r, st) => Math.abs(r.yaw) > 0.2 && Math.sign(r.yaw) !== st.firstSide, side: true },
  { label: 'Levante ligeiramente o queixo', ok: (r) => Math.abs(r.pitch) > 0.12 },
  { label: 'Olhe de frente outra vez', ok: (r) => Math.abs(r.yaw) < 0.15 && Math.abs(r.pitch) < 0.15 },
]

export default function Enrol({ settings, onRegistered }) {
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
      .catch((e) => setMsg(`Falha a carregar modelos: ${e?.message || e}`))
    return () => {
      runRef.current.active = false
    }
  }, [ready])

  async function start() {
    const id = sageId.trim()
    if (!id) return setMsg('Indique o SAGE ID.')
    if (!name.trim()) return setMsg('Indique o nome do trabalhador.')
    if (workers.some((w) => w.id === id)) return setMsg(`O SAGE ID ${id} já está registado neste tablet. Apague-o primeiro para registar de novo.`)
    const run = (runRef.current = { active: true })
    setCapturing(true)
    setMsg('')
    setStep(0)
    setLive('A iniciar…')
    try {
      await capture(id, run)
    } catch (e) {
      console.error(e)
      setMsg(`Erro na captura: ${e?.message || e}`)
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
        !face ? 'Rosto não detetado' : !r ? 'Sem pose' : `yaw ${r.yaw.toFixed(2)} · pitch ${r.pitch.toFixed(2)} · score ${face.score.toFixed(2)}`,
      )
      if (face && r && face.score > 0.7 && STEPS[i].ok(r, st)) hold++
      else hold = 0
      if (hold >= 4) {
        const { worker, similarity } = bestMatch(face.embedding, existing.filter((w) => w.id !== id))
        if (worker && similarity > settings.threshold) {
          setMsg(`Este rosto já está registado como "${worker.name}".`)
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
      setMsg(`✔ ${name.trim()} registado${role === 'admin' ? ' como Administrador' : ''} (${embeddings.length} vetores, sem fotografias).`)
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
            <div className="banner-main">{STEPS[Math.min(step, STEPS.length - 1)].label}</div>
            <div className="banner-sub">
              {step}/{STEPS.length} · {live}
            </div>
          </div>
        )}
      </div>
      <div className="enrol-form">
        <div className="card">
          <h2>Registar trabalhador</h2>
          <label className="field">
            SAGE ID
            <input className="field-input" value={sageId} onChange={(e) => setSageId(e.target.value)} disabled={capturing} inputMode="numeric" autoComplete="off" />
          </label>
          <label className="field">
            Nome do trabalhador
            <input className="field-input" value={name} onChange={(e) => setName(e.target.value)} disabled={capturing} autoComplete="off" />
          </label>
          <button type="button" className="switch-row" disabled={capturing || firstRegistration} onClick={() => setMakeAdmin(!makeAdmin)}>
            <span>
              Perfil de Administrador
              <small>{firstRegistration ? 'O primeiro registo é sempre Administrador' : 'Acede a Registar, Picagens e Definições'}</small>
            </span>
            <span className={`switch ${makeAdmin || firstRegistration ? 'on' : ''}`}>
              <i />
            </span>
          </button>
          <p className="notice notice-info">
            O trabalhador deve dar consentimento antes do registo. Só é guardado o vetor do rosto, cifrado neste dispositivo.
          </p>
          {(error || msg) && <p className={`notice ${msg.startsWith('✔') ? 'notice-ok' : 'notice-warn'}`}>{error || msg}</p>}
          <button className="btn btn-primary btn-block" disabled={!ready || loading || capturing} onClick={start}>
            {error ? 'Câmara indisponível' : loading ? 'A carregar modelos…' : capturing ? 'A capturar…' : 'Iniciar captura'}
          </button>
          {capturing && (
            <button className="btn btn-ghost btn-block" onClick={() => (runRef.current.active = false)}>
              Cancelar
            </button>
          )}
        </div>

        <h3>Registados neste tablet ({workers.length})</h3>
        <div className="card">
          <ul className="workers">
            {!workers.length && <li className="muted">Ainda ninguém registado.</li>}
            {workers.map((w) => (
              <li key={w.id}>
                <span>
                  {w.name} {w.role === 'admin' && <span className="pill pill-ok">Administrador</span>}
                  <small>SAGE ID {w.id} · {w.broken ? 'ilegível — apague e registe de novo' : `${w.embeddings.length} vetores`}</small>
                </span>
                {w.role === 'admin' && !w.broken && usableAdmins === 1 && workers.length > 1 ? (
                  <span className="muted">único Administrador</span>
                ) : (
                  <span className="btn-row">
                    {!w.broken && (
                      <button
                        className="link-button"
                        onClick={async () => {
                          await setWorkerRole(w.id, w.role === 'admin' ? 'user' : 'admin')
                          await refresh()
                          onRegistered?.(null)
                        }}
                      >
                        {w.role === 'admin' ? 'remover Administrador' : 'tornar Administrador'}
                      </button>
                    )}
                    <button
                      className="link-button"
                      onClick={async () => {
                        if (confirm(`Apagar ${w.name}?`)) {
                          await deleteWorker(w.id)
                          await refresh()
                          onRegistered?.(null)
                        }
                      }}
                    >
                      apagar
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
