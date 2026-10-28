import { useState } from 'react'
import { flushQueue } from '../lib/sync.js'
import { getTheme, setTheme } from '../lib/theme.js'
import { useT } from '../lib/i18n.jsx'

export default function Settings({ settings, onChange }) {
  const { t } = useT()
  const [s, setS] = useState(settings)
  const [msg, setMsg] = useState('')
  const [theme, setThemeState] = useState(getTheme())
  const set = (k) => (e) => setS({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })

  async function save() {
    const next = { ...s, threshold: Number(s.threshold), cooldownSec: Number(s.cooldownSec), stableFrames: Number(s.stableFrames) }
    onChange(next)
    setMsg(t('settings.saved'))
    const r = await flushQueue(next)
    if (r.sent) setMsg(t('settings.savedSent', { n: r.sent }))
  }

  return (
    <div className="page settings">
      <div className="settings-grid">
        <div className="card">
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
        </div>

        <div className="card">
          <h2>{t('settings.recognition')}</h2>
          <label className="field">
            {t('settings.threshold', { v: Number(s.threshold).toFixed(2) })}
            <input type="range" min="0.3" max="0.9" step="0.01" value={s.threshold} onChange={set('threshold')} />
          </label>
          <label className="field">
            {t('settings.stableFrames')}
            <input className="field-input" type="number" min="1" max="10" value={s.stableFrames} onChange={set('stableFrames')} />
          </label>
          <label className="field">
            {t('settings.cooldown')}
            <input className="field-input" type="number" min="0" value={s.cooldownSec} onChange={set('cooldownSec')} />
          </label>
          <button type="button" className="switch-row" onClick={() => setS({ ...s, liveness: !s.liveness })}>
            <span>
              {t('settings.liveness')}
              <small>{t('settings.livenessHint')}</small>
            </span>
            <span className={`switch ${s.liveness ? 'on' : ''}`}>
              <i />
            </span>
          </button>
        </div>

        <div className="card">
          <h2>{t('settings.sending')}</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            {t('settings.sendingHint')}
          </p>
          <label className="field">
            {t('settings.relayUrl')}
            <input className="field-input" value={s.relayUrl} onChange={set('relayUrl')} placeholder="https://timp-punch-relay.xxx.workers.dev" />
          </label>
          <label className="field">
            {t('settings.deviceToken')}
            <input className="field-input" type="password" value={s.deviceToken} onChange={set('deviceToken')} />
          </label>
        </div>

        <div className="card">
          <h2>{t('settings.manager')}</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            {t('settings.managerHint')}
          </p>
          <label className="field">
            {t('settings.supabaseUrl')}
            <input className="field-input" value={s.supabaseUrl} onChange={set('supabaseUrl')} placeholder="https://xxxx.supabase.co" />
          </label>
          <label className="field">
            {t('settings.anonKey')}
            <input className="field-input" value={s.supabaseAnonKey} onChange={set('supabaseAnonKey')} />
          </label>
        </div>
      </div>

      {msg && <p className="notice notice-ok" style={{ marginTop: 14 }}>{msg}</p>}
      <button className="btn btn-primary btn-block" onClick={save}>{t('settings.save')}</button>
    </div>
  )
}
