import { useEffect, useState } from 'react'
import { flushQueue } from '../lib/sync.js'
import { getTheme, setTheme } from '../lib/theme.js'
import { useT } from '../lib/i18n.jsx'
import { listCameras } from '../lib/cameras.js'
import { listRoster, rosterMeta } from '../lib/db.js'
import { syncRoster } from '../lib/sync.js'
import { fmtDateTime } from '../lib/date.js'
import { diagCount, diagText } from '../lib/diag.js'

export default function Settings({ settings, onChange }) {
  const { t } = useT()
  const [s, setS] = useState(settings)
  const [msg, setMsg] = useState('')
  const [theme, setThemeState] = useState(getTheme())
  const [cameras, setCameras] = useState([])
  const [roster, setRoster] = useState({ n: 0, at: 0 })
  const [rosterMsg, setRosterMsg] = useState('')
  const loadRoster = async () => setRoster({ n: (await listRoster()).length, at: (await rosterMeta()).at })
  useEffect(() => {
    loadRoster()
  }, [])
  const [camMsg, setCamMsg] = useState('')
  const [diagText_, setDiagText] = useState(null) // null = não pedido; '' = sem registo
  // Copia o registo de diagnóstico (e mostra-o, caso o navegador não deixe copiar)
  async function copyDiag() {
    const text = diagCount() ? diagText() : ''
    setDiagText(text)
    try {
      if (text) await navigator.clipboard.writeText(text)
    } catch {
      /* sem permissão para copiar: o texto fica visível para copiar à mão */
    }
  }
  const set = (k) => (e) => setS({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })

  async function save() {
    const reload = s.backend !== settings.backend || Number(s.detectorConfidence) !== Number(settings.detectorConfidence)
    const next = { ...s, obra: (s.obra || '').trim(), threshold: Number(s.threshold), cooldownSec: Number(s.cooldownSec), stableFrames: Number(s.stableFrames), avgFrames: Number(s.avgFrames), antispoofMin: Number(s.antispoofMin), detectorConfidence: Number(s.detectorConfidence) }
    onChange(next)
    setMsg(t('settings.saved'))
    if (next.obra.toLowerCase() !== (settings.obra || '').trim().toLowerCase()) {
      // mudou a obra: vai buscar já a lista da nova obra
      syncRoster(next).then((r) => {
        loadRoster()
        if (r.ok) window.dispatchEvent(new Event('roster-updated'))
      })
    }
    const r = await flushQueue(next)
    if (r.sent) setMsg(t('settings.savedSent', { n: r.sent }))
    if (reload) setTimeout(() => location.reload(), 600) // o motor e o backend só mudam ao recarregar
  }

  const rosterRefresh = async () => {
    setRosterMsg('')
    const r = await syncRoster({ ...settings, ...s, obra: (s.obra || '').trim() }, { force: true })
    setRosterMsg(r.ok ? t('settings.rosterOk') : t('settings.rosterError', { err: r.error }))
    await loadRoster()
    if (r.ok) window.dispatchEvent(new Event('roster-updated'))
  }

  const detectCameras = async () => {
    setCamMsg('')
    try {
      const list = await listCameras()
      setCameras(list)
      setCamMsg(t('settings.camerasFound', { n: list.length }))
    } catch (e) {
      setCamMsg(String(e?.message || e))
    }
  }

  // Interruptor com título e explicação
  const toggle = (k, label, hint) => (
    <button type="button" className="switch-row" onClick={() => setS({ ...s, [k]: !s[k] })}>
      <span>
        {label}
        <small>{hint}</small>
      </span>
      <span className={`switch ${s[k] ? 'on' : ''}`}>
        <i />
      </span>
    </button>
  )

  return (
    <div className="page settings">
      <div className="settings-grid">
        <div className="settings-col">
          <section className="card">
            <h2>{t('settings.device')}</h2>
            <label className="field">
              {t('settings.deviceName')}
              <input className="field-input" value={s.deviceName} onChange={set('deviceName')} />
            </label>
            <label className="field">
              {t('settings.deviceId')}
              <input className="field-input" value={s.deviceId} onChange={set('deviceId')} />
            </label>
            <label className="field">
              {t('settings.obra')}
              <input className="field-input" value={s.obra} onChange={set('obra')} maxLength={64} />
              <small>{t('settings.obraHint')}</small>
            </label>
            <label className="field">
              {t('settings.mode')}
              <select className="field-select" value={s.mode} onChange={set('mode')}>
                <option value="both">{t('settings.modeBoth')}</option>
                <option value="in">{t('settings.modeIn')}</option>
                <option value="out">{t('settings.modeOut')}</option>
              </select>
              <small>{t('settings.modeHint')}</small>
            </label>
            <label className="field">
              {t('settings.theme')}
              <select
                className="field-select"
                value={theme}
                onChange={(e) => {
                  setTheme(e.target.value)
                  setThemeState(e.target.value)
                }}
              >
                <option value="light">{t('settings.themeLight')}</option>
                <option value="dark">{t('settings.themeDark')}</option>
                <option value="system">{t('settings.themeSystem')}</option>
              </select>
            </label>
          </section>

          <section className="card">
            <h2>{t('settings.sending')}</h2>
            <p className="muted" style={{ marginTop: 0 }}>{t('settings.sendingHint')}</p>
            <label className="field">
              {t('settings.relayUrl')}
              <input className="field-input" value={s.relayUrl} onChange={set('relayUrl')} placeholder="https://punch-relay.exemplo.com" />
            </label>
            <label className="field">
              {t('settings.deviceToken')}
              <input className="field-input" type="password" value={s.deviceToken} onChange={set('deviceToken')} />
            </label>
          </section>

          <section className="card">
            <h2>{t('settings.roster')}</h2>
            <p className="muted" style={{ marginTop: 0 }}>{t('settings.rosterHint')}</p>
            <p className="settings-status">{roster.at ? t('settings.rosterStatus', { n: roster.n, date: fmtDateTime(roster.at) }) : t('settings.rosterNone')}</p>
            <button type="button" className="btn btn-secondary btn-small" onClick={rosterRefresh}>
              {t('settings.rosterRefresh')}
            </button>
            {rosterMsg && <p className="muted">{rosterMsg}</p>}
          </section>
        </div>

        <div className="settings-col">
          <section className="card">
            <h2>{t('settings.recognition')}</h2>
            <label className="field">
              {t('settings.threshold', { v: Number(s.threshold).toFixed(2) })}
              <input type="range" min="0.3" max="0.9" step="0.01" value={s.threshold} onChange={set('threshold')} />
              <small>{t('settings.thresholdHint')}</small>
            </label>
            <label className="field">
              {t('settings.cooldown')}
              <input className="field-input" type="number" min="0" value={s.cooldownSec} onChange={set('cooldownSec')} />
            </label>
            {toggle('liveness', t('settings.liveness'), t('settings.livenessHint'))}
          </section>

          <details className="card settings-adv">
            <summary>
              <h2>{t('settings.advanced')}</h2>
              <small>{t('settings.advancedHint')}</small>
            </summary>
            <label className="field">
              {t('settings.backend')}
              <select className="field-select" value={s.backend} onChange={set('backend')}>
                <option value="webgl">WebGL</option>
                <option value="webgpu">WebGPU ({t('settings.experimental')})</option>
              </select>
              <small>{t('settings.backendHint')}</small>
            </label>
            <label className="field">
              {t('settings.detectorConfidence', { v: Number(s.detectorConfidence).toFixed(2) })}
              <input type="range" min="0.2" max="0.8" step="0.05" value={s.detectorConfidence} onChange={set('detectorConfidence')} />
              <small>{t('settings.detectorConfidenceHint')}</small>
            </label>
            <label className="field">
              {t('settings.antispoofMin', { v: Number(s.antispoofMin).toFixed(2) })}
              <input type="range" min="0" max="0.8" step="0.05" value={s.antispoofMin} onChange={set('antispoofMin')} />
            </label>
            <div className="field-pair">
              <label className="field">
                {t('settings.avgFrames')}
                <input className="field-input" type="number" min="1" max="10" value={s.avgFrames} onChange={set('avgFrames')} />
              </label>
              <label className="field">
                {t('settings.stableFrames')}
                <input className="field-input" type="number" min="1" max="10" value={s.stableFrames} onChange={set('stableFrames')} />
              </label>
            </div>
            {toggle('fastLiveness', t('settings.fastLiveness'), t('settings.fastLivenessHint'))}
          </details>

          <section className="card">
            <h2>{t('settings.camerasTitle')}</h2>
            <label className="field">
              {t('settings.camera')}
              <select className="field-select" value={s.cameraId} onChange={set('cameraId')}>
                <option value="">{t('settings.cameraAuto')}</option>
                {cameras.map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
                {s.cameraId && !cameras.some((c) => c.id === s.cameraId) && <option value={s.cameraId}>{t('settings.cameraSaved')}</option>}
              </select>
            </label>
            <button type="button" className="btn btn-secondary btn-small" onClick={detectCameras}>
              {t('settings.detectCameras')}
            </button>
            {camMsg && <p className="muted">{camMsg}</p>}
          </section>

          <section className="card">
            <h2>{t('settings.diagnostics')}</h2>
            {toggle('debug', t('settings.debug'), t('settings.debugHint'))}
            <button type="button" className="btn btn-secondary btn-small" onClick={copyDiag}>
              {t('settings.diagCopy', { n: diagCount() })}
            </button>
            {diagText_ !== null && (
              <>
                <p className="muted">{diagText_ ? t('settings.diagShown') : t('settings.diagEmpty')}</p>
                {diagText_ && <textarea className="field-input settings-diag" readOnly rows={8} value={diagText_} onFocus={(e) => e.target.select()} />}
              </>
            )}
          </section>
        </div>
      </div>

      <div className="settings-save">
        {msg && <p className="notice notice-ok">{msg}</p>}
        <button className="btn btn-primary btn-block" onClick={save}>{t('settings.save')}</button>
      </div>
    </div>
  )
}
