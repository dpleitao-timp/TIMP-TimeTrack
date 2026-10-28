import { useEffect, useState, useCallback } from 'react'
import { listQueue } from '../lib/db.js'
import { loadStats, resetStats } from '../lib/settings.js'
import { useT } from '../lib/i18n.jsx'
import { fmtDateTime, localIso } from '../lib/date.js'
import DateField from './DateField.jsx'

const today = () => localIso()

// Picagens guardadas neste tablet. O tablet não lê nem escreve no Supabase: o chefe de equipa
// vê as picagens na app de timesheets, alimentada pelo Supabase.
export default function Punches() {
  const { t, locale } = useT()
  const [date, setDate] = useState(today())
  const [rows, setRows] = useState([])
  const [stats, setStats] = useState(loadStats())

  const load = useCallback(async () => {
    setStats(loadStats())
    const all = await listQueue()
    setRows(all.filter((p) => localIso(p.punchedAt) === date))
  }, [date])

  useEffect(() => {
    load()
    const timer = setInterval(load, 10000)
    return () => clearInterval(timer)
  }, [load])

  // Resumo por trabalhador: primeira entrada / última saída e picagens sem par.
  const summary = {}
  for (const p of [...rows].sort((a, b) => a.punchedAt.localeCompare(b.punchedAt))) {
    const sid = p.sageId ?? p.workerId
    const s = (summary[sid] ??= { name: p.workerName || sid, sageId: sid, ins: [], outs: [] })
    ;(p.direction === 'in' ? s.ins : s.outs).push(p.punchedAt)
  }

  const hm = (x) => new Date(x).toLocaleTimeString(locale, { timeStyle: 'short' })

  return (
    <div className="page punches">
      <div className="toolbar">
        <DateField value={date} onChange={setDate} label={t('punches.date')} />
        <button className="btn btn-secondary btn-small" onClick={load}>{t('punches.refresh')}</button>
      </div>

      <h3>{t('punches.daySummary')}</h3>
      {!Object.keys(summary).length && <p className="empty-text">{t('punches.noneDay')}</p>}
      <div className="worker-list">
        {Object.entries(summary).map(([id, s]) => {
          const ok = s.ins.length === s.outs.length && s.ins.length > 0
          return (
            <div key={id} className={`worker-card ${ok ? 'complete' : 'missing'}`}>
              <div className="worker-card-top">
                <h4 className="worker-card-name">{s.name}</h4>
                <span className={`pill ${ok ? 'pill-ok' : 'pill-warn'}`}>
                  {ok ? t('punches.complete') : s.ins.length > s.outs.length ? t('punches.missingOut') : t('punches.missingIn')}
                </span>
              </div>
              <div className="worker-card-sub">
                {t('punches.insOuts', { ins: s.ins.map(hm).join(', ') || '—', outs: s.outs.map(hm).join(', ') || '—' })}
              </div>
            </div>
          )
        })}
      </div>

      <h3>{t('punches.title', { n: rows.length })}</h3>
      <div className="card table-card">
        <table>
          <thead>
            <tr><th>{t('punches.time')}</th><th>{t('punches.sage')}</th><th>{t('punches.name')}</th><th>{t('punches.direction')}</th><th>{t('punches.device')}</th><th>{t('punches.confidence')}</th><th>{t('punches.sync')}</th></tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.eventId}>
                <td>{fmtDateTime(p.punchedAt)}</td>
                <td>{p.sageId ?? p.workerId}</td>
                <td>{p.workerName}</td>
                <td>{p.direction === 'in' ? t('dir.in') : t('dir.out')}</td>
                <td>{p.deviceId}</td>
                <td>{p.confidence}</td>
                <td>{p.synced ? '✔' : `⏳ (${p.attempts})`}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan="7" className="muted">{t('punches.none')}</td></tr>}
          </tbody>
        </table>
      </div>

      <h3>{t('punches.metrics')}</h3>
      <div className="card">
        <p className="muted" style={{ margin: 0 }}>
          {t('punches.metricsText', { punches: stats.punches || 0, ms: stats.msCount ? Math.round(stats.msTotal / stats.msCount) : '—', unknown: stats.unknown || 0, spoof: stats.spoofRejected || 0 })}{' '}
          <button className="link-button" onClick={() => { resetStats(); setStats({}) }}>{t('punches.reset')}</button>
        </p>
      </div>
    </div>
  )
}
