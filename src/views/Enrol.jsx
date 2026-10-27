import { useEffect, useRef, useState } from 'react'
import { initHuman, detect, bestMatch } from '../lib/face.js'
import { saveWorker, listWorkers, deleteWorker } from '../lib/db.js'
import { useCamera } from '../lib/useCamera.js'

// Passos de captura guiada. Cada passo exige uma pose; só o vetor (embedding) é guardado.
const STEPS = [
  { label: 'Olhe de frente', ok: (r) => Math.abs(r.yaw) < 0.15 && Math.abs(r.pitch) < 0.15 },
  { label: 'Vire a cabeça um pouco para um lado', ok: (r) => Math.abs(r.yaw) > 0.2, side: true },
  { label: 'Agora para o lado oposto', ok: (r, st) => Math.abs(r.yaw) > 0.2 && Math.sign(r.yaw) !== st.firstSide, side: true },
  { label: 'Levante ligeiramente o queixo', ok: (r) => Math.abs(r.pitch) > 0.12 },
  { label: 'Olhe de frente outra vez', ok: (r) => Math.abs(r.yaw) < 0.15 && Math.abs(r.pitch) < 0.15 },
]

export default function Enrol({ settings }) {
  const videoRef = useRef(null)
  const { ready, error } = useCamera(videoRef)
  const [name, setName] = useState('')
  const [workerId, setWorkerId] = useState('')
  const [capturing, setCapturing] = useState(false)
  const [step, setStep] = useState(0)
  const [msg, setMsg] = useState('')
  const [loading, setLoading] = useState(true)
  const [workers, setWorkers] = useState([])
  const runRef = useRef({ active: false })

  const refresh = async () => setWorkers(await listWorkers())

  useEffect(() => {
    refresh()
    if (!ready) return
    initHuman().then(() => setLoading(false))
    return () => {
      runRef.current.active = false
    }
  }, [ready])

  async function start() {
    if (!name.trim()) return setMsg('Indique o nome.')
    const id = workerId.trim() || name.trim().toLowerCase().replace(/\s+/g, '-')
    const existing = await listWorkers()
    const embeddings = []
    const st = { firstSide: 0 }
    const run = (runRef.current = { active: true })
    setCapturing(true)
    setMsg('')
    setStep(0)

    let i = 0
    let hold = 0
    while (run.active && i < STEPS.length) {
      const { face } = await detect(videoRef.current)
      const r = face?.rotation?.angle
      if (face && r && face.score > 0.7 && STEPS[i].ok(r, st)) hold++
      else hold = 0
      if (hold >= 4) {
        const { worker, similarity } = bestMatch(face.embedding, existing.filter((w) => w.id !== id))
        if (worker && similarity > settings.threshold) {
          setMsg(`Este rosto já está registado como "${worker.name}".`)
          setCapturing(false)
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
      await saveWorker({ id, name: name.trim(), embeddings })
      setMsg(`✔ ${name.trim()} registado (${embeddings.length} vetores, sem fotografias).`)
      setName('')
      setWorkerId('')
      refresh()
    }
    setCapturing(false)
  }

  return (
    <div className="page enrol">
      <div className="enrol-cam">
        <video ref={videoRef} muted playsInline className="mirror" />
        {capturing && (
          <div className="banner warn">
            <div className="banner-main">{STEPS[Math.min(step, STEPS.length - 1)].label}</div>
            <div className="banner-sub">
              {step}/{STEPS.length}
            </div>
          </div>
        )}
      </div>
      <div className="enrol-form">
        <h2>Registar trabalhador</h2>
        <label>
          Nome
          <input value={name} onChange={(e) => setName(e.target.value)} disabled={capturing} />
        </label>
        <label>
          ID (nº mecanográfico / intranet)
          <input value={workerId} onChange={(e) => setWorkerId(e.target.value)} disabled={capturing} placeholder="opcional" />
        </label>
        <p className="muted">
          O trabalhador deve dar consentimento antes do registo. Só é guardado o vetor do rosto, cifrado neste dispositivo.
        </p>
        <button className="btn" disabled={!ready || loading || capturing} onClick={start}>
          {loading ? 'A carregar modelos…' : capturing ? 'A capturar…' : 'Iniciar captura'}
        </button>
        {capturing && (
          <button className="btn ghost" onClick={() => (runRef.current.active = false)}>
            Cancelar
          </button>
        )}
        {(error || msg) && <p className="msg">{error || msg}</p>}

        <h3>Registados neste tablet ({workers.length})</h3>
        <ul className="workers">
          {workers.map((w) => (
            <li key={w.id}>
              <span>
                {w.name} <small className="muted">{w.id} · {w.embeddings.length} vetores</small>
              </span>
              <button
                className="link"
                onClick={async () => {
                  if (confirm(`Apagar ${w.name}?`)) {
                    await deleteWorker(w.id)
                    refresh()
                  }
                }}
              >
                apagar
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
