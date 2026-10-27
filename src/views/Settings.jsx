import { useState } from 'react'
import { flushQueue } from '../lib/sync.js'
import { getTheme, setTheme } from '../lib/theme.js'

export default function Settings({ settings, onChange }) {
  const [s, setS] = useState(settings)
  const [msg, setMsg] = useState('')
  const [theme, setThemeState] = useState(getTheme())
  const set = (k) => (e) => setS({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })

  async function save() {
    const next = { ...s, threshold: Number(s.threshold), cooldownSec: Number(s.cooldownSec), stableFrames: Number(s.stableFrames) }
    onChange(next)
    setMsg('Guardado.')
    const r = await flushQueue(next)
    if (r.sent) setMsg(`Guardado. ${r.sent} picagens enviadas.`)
  }

  return (
    <div className="page settings">
      <div className="settings-grid">
        <div className="card">
          <h2>Dispositivo</h2>
          <label className="field">
            Nome do dispositivo
            <input className="field-input" value={s.deviceName} onChange={set('deviceName')} />
          </label>
          <label className="field">
            ID do dispositivo
            <input className="field-input" value={s.deviceId} onChange={set('deviceId')} />
          </label>
          <label className="field">
            Direção atual (também escolhida no ecrã Picar)
            <select className="field-select" value={s.direction} onChange={set('direction')}>
              <option value="in">Entrada</option>
              <option value="out">Saída</option>
            </select>
          </label>
          <label className="field">
            Aspeto
            <select
              className="field-select"
              value={theme}
              onChange={(e) => {
                setTheme(e.target.value)
                setThemeState(e.target.value)
              }}
            >
              <option value="light">Claro</option>
              <option value="dark">Escuro</option>
              <option value="system">Automático</option>
            </select>
          </label>
        </div>

        <div className="card">
          <h2>Reconhecimento</h2>
          <label className="field">
            Limiar de confiança ({Number(s.threshold).toFixed(2)})
            <input type="range" min="0.3" max="0.9" step="0.01" value={s.threshold} onChange={set('threshold')} />
          </label>
          <label className="field">
            Frames estáveis antes de picar
            <input className="field-input" type="number" min="1" max="10" value={s.stableFrames} onChange={set('stableFrames')} />
          </label>
          <label className="field">
            Intervalo mínimo entre picagens (s)
            <input className="field-input" type="number" min="0" value={s.cooldownSec} onChange={set('cooldownSec')} />
          </label>
          <button type="button" className="switch-row" onClick={() => setS({ ...s, liveness: !s.liveness })}>
            <span>
              Deteção de vida
              <small>Exige piscar os olhos ou virar a cabeça</small>
            </span>
            <span className={`switch ${s.liveness ? 'on' : ''}`}>
              <i />
            </span>
          </button>
        </div>

        <div className="card">
          <h2>Cloud (Supabase)</h2>
          <label className="field">
            URL do projeto
            <input className="field-input" value={s.supabaseUrl} onChange={set('supabaseUrl')} placeholder="https://xxxx.supabase.co" />
          </label>
          <label className="field">
            Chave anon
            <input className="field-input" value={s.supabaseAnonKey} onChange={set('supabaseAnonKey')} />
          </label>
          <label className="field">
            Token do dispositivo
            <input className="field-input" type="password" value={s.deviceToken} onChange={set('deviceToken')} />
          </label>
        </div>
      </div>

      {msg && <p className="notice notice-ok" style={{ marginTop: 14 }}>{msg}</p>}
      <button className="btn btn-primary btn-block" onClick={save}>Guardar</button>
    </div>
  )
}
