import { useState } from 'react'
import { flushQueue } from '../lib/sync.js'

export default function Settings({ settings, onChange }) {
  const [s, setS] = useState(settings)
  const [msg, setMsg] = useState('')
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
      <h2>Definições do dispositivo</h2>
      <label>Nome do dispositivo<input value={s.deviceName} onChange={set('deviceName')} /></label>
      <label>ID do dispositivo<input value={s.deviceId} onChange={set('deviceId')} /></label>
      <label>
        Direção (fixa)
        <select value={s.direction} onChange={set('direction')}>
          <option value="in">Entrada</option>
          <option value="out">Saída</option>
        </select>
      </label>
      <label>
        Limiar de confiança ({Number(s.threshold).toFixed(2)})
        <input type="range" min="0.3" max="0.9" step="0.01" value={s.threshold} onChange={set('threshold')} />
      </label>
      <label>Frames estáveis antes de picar<input type="number" min="1" max="10" value={s.stableFrames} onChange={set('stableFrames')} /></label>
      <label>Intervalo mínimo entre picagens (s)<input type="number" min="0" value={s.cooldownSec} onChange={set('cooldownSec')} /></label>
      <label className="check">
        <input type="checkbox" checked={s.liveness} onChange={set('liveness')} /> Exigir deteção de vida (piscar / virar a cabeça)
      </label>

      <h2>Cloud (Supabase)</h2>
      <label>URL do projeto<input value={s.supabaseUrl} onChange={set('supabaseUrl')} placeholder="https://xxxx.supabase.co" /></label>
      <label>Chave anon<input value={s.supabaseAnonKey} onChange={set('supabaseAnonKey')} /></label>
      <label>Token do dispositivo<input type="password" value={s.deviceToken} onChange={set('deviceToken')} /></label>

      <button className="btn" onClick={save}>Guardar</button>
      {msg && <p className="msg">{msg}</p>}
    </div>
  )
}
