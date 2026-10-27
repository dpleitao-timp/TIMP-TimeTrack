import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@supabase/supabase-js'
import { listQueue } from '../lib/db.js'
import { loadStats, resetStats } from '../lib/settings.js'

const fmt = (iso) => new Date(iso).toLocaleString('pt-PT', { dateStyle: 'short', timeStyle: 'medium' })
const today = () => new Date().toISOString().slice(0, 10)

export default function Punches({ settings }) {
  const [source, setSource] = useState('local')
  const [date, setDate] = useState(today())
  const [rows, setRows] = useState([])
  const [stats, setStats] = useState(loadStats())
  const [client, setClient] = useState(null)
  const [session, setSession] = useState(null)
  const [login, setLogin] = useState({ email: '', password: '' })
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!settings.supabaseUrl || !settings.supabaseAnonKey) return setClient(null)
    const c = createClient(settings.supabaseUrl, settings.supabaseAnonKey)
    setClient(c)
    c.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = c.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [settings.supabaseUrl, settings.supabaseAnonKey])

  const load = useCallback(async () => {
    setErr('')
    setStats(loadStats())
    if (source === 'local') {
      const all = await listQueue()
      return setRows(all.filter((p) => p.punchedAt.slice(0, 10) === date || date === ''))
    }
    if (!client || !session) return setRows([])
    const start = new Date(`${date}T00:00:00`).toISOString()
    const end = new Date(new Date(`${date}T00:00:00`).getTime() + 864e5).toISOString()
    const { data, error } = await client
      .from('punches')
      .select('*')
      .gte('punched_at', start)
      .lt('punched_at', end)
      .order('punched_at', { ascending: false })
      .limit(500)
    if (error) return setErr(error.message)
    setRows(
      data.map((r) => ({
        eventId: r.event_id,
        workerId: r.worker_id,
        workerName: r.worker_name,
        direction: r.direction,
        punchedAt: r.punched_at,
        deviceId: r.device_id,
        confidence: r.confidence,
        synced: 1,
      })),
    )
  }, [source, date, client, session])

  useEffect(() => {
    load()
    const t = setInterval(load, 10000)
    return () => clearInterval(t)
  }, [load])

  // Resumo por trabalhador: primeira entrada / última saída e picagens sem par.
  const summary = {}
  for (const p of [...rows].sort((a, b) => a.punchedAt.localeCompare(b.punchedAt))) {
    const s = (summary[p.workerId] ??= { name: p.workerName || p.workerId, ins: [], outs: [] })
    ;(p.direction === 'in' ? s.ins : s.outs).push(p.punchedAt)
  }

  const hm = (t) => new Date(t).toLocaleTimeString('pt-PT', { timeStyle: 'short' })

  return (
    <div className="page punches">
      <div className="toolbar">
        <div className="seg">
          <button className={source === 'local' ? 'on' : ''} onClick={() => setSource('local')}>
            Este tablet
          </button>
          <button className={source === 'cloud' ? 'on' : ''} onClick={() => setSource('cloud')}>
            Cloud (chefe de equipa)
          </button>
        </div>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <button className="btn btn-secondary btn-small" onClick={load}>Atualizar</button>
      </div>

      {source === 'cloud' && !client && <p className="notice notice-warn">Configure URL e chave Supabase em Definições.</p>}
      {source === 'cloud' && client && !session && (
        <form
          className="login"
          onSubmit={async (e) => {
            e.preventDefault()
            const { error } = await client.auth.signInWithPassword(login)
            if (error) setErr(error.message)
          }}
        >
          <input placeholder="email" value={login.email} onChange={(e) => setLogin({ ...login, email: e.target.value })} />
          <input type="password" placeholder="palavra-passe" value={login.password} onChange={(e) => setLogin({ ...login, password: e.target.value })} />
          <button className="btn btn-primary btn-small">Entrar</button>
        </form>
      )}
      {err && <p className="notice notice-error">{err}</p>}

      <h3>Resumo do dia</h3>
      {!Object.keys(summary).length && <p className="empty-text">Sem picagens neste dia.</p>}
      <div className="worker-list">
        {Object.entries(summary).map(([id, s]) => {
          const ok = s.ins.length === s.outs.length && s.ins.length > 0
          return (
            <div key={id} className={`worker-card ${ok ? 'complete' : 'missing'}`}>
              <div className="worker-card-top">
                <h4 className="worker-card-name">{s.name}</h4>
                <span className={`pill ${ok ? 'pill-ok' : 'pill-warn'}`}>
                  {ok ? 'Completo' : s.ins.length > s.outs.length ? 'Falta saída' : 'Falta entrada'}
                </span>
              </div>
              <div className="worker-card-sub">
                Entradas: {s.ins.map(hm).join(', ') || '—'} · Saídas: {s.outs.map(hm).join(', ') || '—'}
              </div>
            </div>
          )
        })}
      </div>

      <h3>Picagens ({rows.length})</h3>
      <div className="card table-card">
        <table>
          <thead>
            <tr><th>Hora</th><th>Trabalhador</th><th>Direção</th><th>Dispositivo</th><th>Confiança</th>{source === 'local' && <th>Sync</th>}</tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.eventId}>
                <td>{fmt(p.punchedAt)}</td>
                <td>{p.workerName || p.workerId}</td>
                <td>{p.direction === 'in' ? 'Entrada' : 'Saída'}</td>
                <td>{p.deviceId}</td>
                <td>{p.confidence}</td>
                {source === 'local' && <td>{p.synced ? '✔' : `⏳ (${p.attempts})`}</td>}
              </tr>
            ))}
            {!rows.length && <tr><td colSpan="6" className="muted">Sem picagens.</td></tr>}
          </tbody>
        </table>
      </div>

      <h3>Métricas do piloto (neste tablet)</h3>
      <div className="card">
        <p className="muted" style={{ margin: 0 }}>
          Picagens: {stats.punches || 0} · tempo médio até picar: {stats.msCount ? Math.round(stats.msTotal / stats.msCount) : '—'} ms · não reconhecidos:{' '}
          {stats.unknown || 0} · rejeitados (vida/foto): {stats.spoofRejected || 0}{' '}
          <button className="link-button" onClick={() => { resetStats(); setStats({}) }}>repor</button>
        </p>
      </div>
    </div>
  )
}
