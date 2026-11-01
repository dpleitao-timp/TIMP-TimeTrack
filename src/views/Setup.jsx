import { useState } from 'react'
import { loadSettings, saveSettings, isSecureUrl } from '../lib/settings.js'
import { enrollWithCode, markEnrolled } from '../lib/relay.js'
import { useT } from '../lib/i18n.jsx'

// Identificador da sessão de instalação (não é um trabalhador): ver App.jsx.
export const SETUP_ID = 'setup'

// Abrir a configuração de um tablet SEM Administrador. A administração nunca fica aberta: sem Administrador só se entra com um código de
// instalação válido, que o relay verifica (uso único, dado por add-device.mjs a quem controla o relay). Tablet novo: pede também o endereço
// do relay e o ID do dispositivo. Tablet já ligado (sem Administrador por troca de motor, base de dados apagada...): só o código, que o relay
// também tem de aceitar, por isso quem não o tem não entra. O código gasta-se aqui e não fica guardado.
export default function Setup({ onUnlock, onCancel }) {
  const { t } = useT()
  const stored = loadSettings()
  const fixed = stored.enrolled === true && !!stored.relayUrl && !!stored.deviceId // já ligado: relay e ID não se mudam aqui
  const [relayUrl, setRelayUrl] = useState(stored.relayUrl || '')
  const [deviceId, setDeviceId] = useState(stored.deviceId || '')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function go() {
    const url = relayUrl.trim()
    const id = deviceId.trim()
    const c = code.trim()
    const missing = [!url && 'settings.relayUrl', !id && 'settings.deviceId', !c && 'settings.deviceToken'].filter(Boolean)
    if (missing.length) return setErr(t('settings.required', { list: missing.map((k) => t(k)).join(', ') }))
    if (!isSecureUrl(url)) return setErr(t('settings.relayUrlBad'))
    setBusy(true)
    setErr('')
    try {
      await enrollWithCode({ ...stored, relayUrl: url, deviceId: id }, c) // o relay confirma o código e regista a chave deste tablet
      saveSettings({ ...loadSettings(), relayUrl: url, deviceId: id })
      markEnrolled() // guarda "ligado", apaga o código e avisa a interface
      onUnlock()
    } catch (e) {
      setErr(e.code === 'invalid_enrollment' ? t('settings.enrollBad') : t('settings.enrollError', { err: e.message || String(e) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="kiosk-wrap">
      <div className="card setup-card">
        <h2>{t('setup.title')}</h2>
        <p className="muted" style={{ marginTop: 0 }}>{t('setup.intro')}</p>
        {!fixed && (
          <>
            <label className="field">
              {t('settings.relayUrl')} *
              <input className="field-input" value={relayUrl} onChange={(e) => setRelayUrl(e.target.value)} placeholder="https://punch-relay.exemplo.com" autoComplete="off" spellCheck={false} />
            </label>
            <label className="field">
              {t('settings.deviceId')} *
              <input className="field-input" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} autoComplete="off" spellCheck={false} />
            </label>
          </>
        )}
        <label className="field">
          {t('settings.deviceToken')} *
          <input className="field-input" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} onKeyDown={(e) => e.key === 'Enter' && !busy && go()} />
        </label>
        {err && <p className="notice notice-warn">{err}</p>}
        <button type="button" className="btn btn-primary btn-block" disabled={busy} onClick={go}>
          {busy ? t('settings.enrolling') : t('setup.go')}
        </button>
        <button type="button" className="btn btn-ghost btn-block" disabled={busy} onClick={onCancel}>
          {t('kiosk.back')}
        </button>
        {import.meta.env.DEV && (
          // só existe no servidor de desenvolvimento (npm run dev): a compilação de produção elimina este botão
          <button type="button" className="btn btn-ghost btn-block" onClick={onUnlock}>
            Saltar (só em desenvolvimento)
          </button>
        )}
      </div>
    </div>
  )
}
