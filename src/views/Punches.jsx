import { useEffect, useState, useCallback } from 'react'
import { listQueue, deletePunch } from '../lib/db.js'
import { loadStats, resetStats, loadSettings } from '../lib/settings.js'
import { flushQueue } from '../lib/sync.js'
import { buildExport, deliverFile, confirmHanded, importPunchFile } from '../lib/transfer.js'
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
  const [msg, setMsg] = useState('')
  const [info, setInfo] = useState('')

  const load = useCallback(async () => {
    setStats(loadStats())
    const all = await listQueue()
    setRows(all.filter((p) => localIso(p.punchedAt) === date))
  }, [date])

  // lê ao abrir e sempre que a fila muda (nova picagem, enviada, recusada ou apagada): sem consultas periódicas
  useEffect(() => {
    load()
    window.addEventListener('queue-changed', load)
    return () => window.removeEventListener('queue-changed', load)
  }, [load])

  async function remove(p) {
    const who = p.workerName || p.sageId
    if (!confirm(t(p.synced ? 'punches.confirmDeleteSent' : 'punches.confirmDelete', { name: who, time: fmtDateTime(p.punchedAt) }))) return
    setMsg('')
    try {
      await deletePunch(p.eventId)
      // o trabalhador pode voltar a picar já: sem a picagem na fila, deixa de haver intervalo a respeitar
      if (p.synced) {
        setInfo(t('punches.voidQueued'))
        flushQueue(loadSettings()).then(load) // o pedido de apagar segue já para o relay
      } else setInfo('')
    } catch (e) {
      setInfo('')
      setMsg(e.code === 'SENDING' ? t('punches.busy') : e.code === 'HANDED' ? t('punches.errHanded') : String(e.message || e))
    }
    load()
  }

  // Transferir picagens para outro aparelho (obras sem internet): exportar daqui, importar no outro.
  const [includeHanded, setIncludeHanded] = useState(false)
  const [busy, setBusy] = useState(false)
  async function exportPunches() {
    setMsg('')
    setInfo('')
    setBusy(true)
    try {
      const exp = await buildExport(loadSettings(), { includeHanded })
      if (!exp) return setInfo(t('transfer.nothing'))
      if (!(await deliverFile(exp.file))) return setInfo(t('transfer.kept'))
      // só se sabe que o outro aparelho recebeu o ficheiro se o utilizador o disser
      if (confirm(t('transfer.confirmHanded', { n: exp.count }))) {
        await confirmHanded(exp.eventIds)
        setInfo(t('transfer.handedDone', { n: exp.count }))
      } else setInfo(t('transfer.kept'))
    } catch (e) {
      setMsg(String(e.message || e))
    } finally {
      setBusy(false)
    }
  }
  async function importPunches(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // permite escolher o mesmo ficheiro outra vez
    if (!file) return
    setMsg('')
    setInfo('')
    setBusy(true)
    try {
      const r = await importPunchFile(loadSettings(), await file.text())
      setInfo(t('transfer.imported', { n: r.added, dup: r.duplicates }))
      flushQueue(loadSettings()).then(load) // se já há rede, seguem já para o relay
    } catch (err) {
      setMsg(
        err.code === 'obra' ? t('transfer.errObra', { file: err.file, own: err.own })
        : err.code === 'noObra' ? t('transfer.errNoObra')
        : err.code === 'same' ? t('transfer.errSame')
        : err.code === 'file' ? t('transfer.errFile')
        : String(err.message || err),
      )
    } finally {
      setBusy(false)
    }
  }

  // Resumo por trabalhador: primeira entrada / última saída e picagens sem par.
  const summary = {}
  for (const p of [...rows].sort((a, b) => a.punchedAt.localeCompare(b.punchedAt))) {
    if (p.direction === 'meal_out' || p.direction === 'meal_in') continue // almoço/jantar não entra na contagem de entradas e saídas
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

      {msg && <p className="notice notice-warn">{msg}</p>}
      {info && <p className="notice notice-ok">{info}</p>}

      <h3>{t('transfer.title')}</h3>
      <div className="card">
        <p className="muted" style={{ marginTop: 0 }}>{t('transfer.help')}</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <button type="button" className="btn btn-secondary btn-small" onClick={exportPunches} disabled={busy}>{t('transfer.export')}</button>
          <label className="btn btn-secondary btn-small" style={{ display: 'inline-flex', alignItems: 'center', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1 }}>
            {t('transfer.import')}
            <input type="file" accept=".json,application/json" onChange={importPunches} disabled={busy} hidden />
          </label>
        </div>
        <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={includeHanded} onChange={(e) => setIncludeHanded(e.target.checked)} /> {t('transfer.includeHanded')}
        </label>
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
            <tr><th>{t('punches.time')}</th><th>{t('punches.obra')}</th><th>{t('punches.sage')}</th><th>{t('punches.name')}</th><th>{t('punches.direction')}</th><th>{t('punches.device')}</th><th>{t('punches.confidence')}</th><th>{t('punches.sync')}</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.eventId}>
                <td>{fmtDateTime(p.punchedAt)}</td>
                <td>{p.obra}</td>
                <td>{p.sageId ?? p.workerId}</td>
                <td>{p.workerName}</td>
                <td>{t({ in: 'dir.in', out: 'dir.out', meal_out: 'dir.mealOut', meal_in: 'dir.mealIn' }[p.direction] ?? 'dir.out')}</td>
                <td>{p.deviceId}</td>
                <td>{p.confidence}</td>
                <td>{p.synced ? '✔' : p.rejected ? <span title={t('punches.rejected')}>❌</span> : p.handed ? <span title={t('punches.handed')}>📱</span> : p.hold ? <span title={t('punches.held')}>🕒</span> : `⏳ (${p.attempts})`}</td>
                <td><button className="link-button" onClick={() => remove(p)}>{t('punches.delete')}</button></td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan="9" className="muted">{t('punches.none')}</td></tr>}
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
