import { useCallback, useEffect, useState } from 'react'
import Kiosk from './views/Kiosk.jsx'
import Enrol from './views/Enrol.jsx'
import Punches from './views/Punches.jsx'
import Settings from './views/Settings.jsx'
import { loadSettings, saveSettings } from './lib/settings.js'
import { startAutoSync } from './lib/sync.js'
import { listWorkers, hasUsableAdmin, isUsable, pendingPunches } from './lib/db.js'
import { useT, LanguageSwitch } from './lib/i18n.jsx'
import { initHuman } from './lib/face.js'
import { warmCamera, releaseCamera } from './lib/useCamera.js'

// Só o Administrador acede a estes separadores.
const ADMIN_TABS = ['enrol', 'punches', 'settings']
const ADMIN_IDLE_MS = 5 * 60 * 1000 // a sessão de administrador termina sem atividade

const routeFromHash = () => (location.hash.replace('#/', '') || 'kiosk').split('?')[0]

export default function App() {
  const { t } = useT()
  const [route, setRoute] = useState(routeFromHash())
  const [settings, setSettings] = useState(loadSettings)
  const [online, setOnline] = useState(navigator.onLine)
  const [hasAdmin, setHasAdmin] = useState(null) // null = a verificar
  const [admin, setAdmin] = useState(null) // sessão: { id, name }
  const [pending, setPending] = useState(0) // picagens por enviar

  // Modelos de reconhecimento e câmara abertos em segundo plano assim que a app abre (em qualquer ecrã),
  // para estarem prontos quando alguém carregar em Entrada/Saída. O pequeno atraso deixa a interface desenhar primeiro.
  useEffect(() => {
    const timer = setTimeout(() => {
      initHuman().catch(() => {})
      warmCamera(loadSettings().cameraId) // câmara sempre ligada: já aberta quando se escolhe Entrada/Saída
    }, 150)
    return () => clearTimeout(timer)
  }, [])

  const refreshAdmin = useCallback(async () => {
    const workers = await listWorkers()
    setHasAdmin(hasUsableAdmin(workers))
    // se o Administrador com sessão aberta perdeu o perfil (ou foi apagado), a sessão termina
    setAdmin((a) => (a && !workers.some((w) => w.id === a.id && w.role === 'admin' && isUsable(w)) ? null : a))
  }, [])

  useEffect(() => {
    refreshAdmin()
  }, [refreshAdmin])

  useEffect(() => {
    const h = () => setRoute(routeFromHash())
    window.addEventListener('hashchange', h)
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('hashchange', h)
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  // reenvio automático da fila (lê sempre as definições mais recentes)
  useEffect(() => startAutoSync(() => loadSettings(), (r) => setPending(r.pending)), [])

  // contador de picagens por enviar, sempre visível no cabeçalho
  useEffect(() => {
    const load = () => pendingPunches().then((p) => setPending(p.length))
    load()
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [])

  // Sem Administrador registado (primeiro arranque) a administração está aberta, para registar o primeiro.
  const unlocked = hasAdmin === false || !!admin

  const logout = useCallback(() => {
    setAdmin(null)
    location.hash = '#/kiosk'
  }, [])

  // termina a sessão de administrador após inatividade
  useEffect(() => {
    if (!admin) return
    let t
    const arm = () => {
      clearTimeout(t)
      t = setTimeout(logout, ADMIN_IDLE_MS)
    }
    arm()
    const events = ['pointerdown', 'keydown']
    events.forEach((e) => window.addEventListener(e, arm))
    return () => {
      clearTimeout(t)
      events.forEach((e) => window.removeEventListener(e, arm))
    }
  }, [admin, logout])

  // acesso direto por endereço a uma área protegida volta ao ecrã de picagem
  const blocked = ADMIN_TABS.includes(route) && hasAdmin !== null && !unlocked
  useEffect(() => {
    if (blocked) location.hash = '#/kiosk'
  }, [blocked])

  const update = (s) => {
    if (s.cameraId !== settings.cameraId) {
      releaseCamera() // mudou a câmara escolhida: fecha a antiga e abre a nova
      warmCamera(s.cameraId)
    }
    saveSettings(s)
    setSettings(s)
  }

  const onRegistered = (worker) => {
    refreshAdmin()
    // só o primeiro Administrador (registado presencialmente) fica com a sessão aberta;
    // um Administrador adicional tem de se identificar pelo rosto quando precisar
    if (worker?.role === 'admin' && !hasAdmin) setAdmin({ id: worker.id, name: worker.name })
  }

  const current = blocked || hasAdmin === null ? 'kiosk' : route

  return (
    <>
      <header className="app-header">
        <nav className="tabs">
          <a href="#/kiosk" className={current === 'kiosk' ? 'tab on' : 'tab'}>
            {t('nav.kiosk')}
          </a>
          {unlocked &&
            ADMIN_TABS.map((id) => (
              <a key={id} href={`#/${id}`} className={current === id ? 'tab on' : 'tab'}>
                {t(`nav.${id}`)}
              </a>
            ))}
        </nav>
        {admin && (
          <button type="button" className="header-chip button" onClick={logout}>
            🔓 {admin.name} · {t('app.endSession')}
          </button>
        )}
        <LanguageSwitch />
        <span className="header-chip">
          <i className={online ? 'dot dot-on' : 'dot dot-off'} />
          {settings.deviceName} · {online ? t('kiosk.online') : t('kiosk.offline')} · {t('kiosk.pendingSend', { n: pending })}
        </span>
      </header>
      {hasAdmin === false && !admin && (
        <p className="notice notice-warn" style={{ margin: '0 16px 8px' }}>
          {t('app.noAdmin')}
        </p>
      )}
      {current === 'kiosk' && (
        <Kiosk settings={settings} setPending={setPending} hasAdmin={!!hasAdmin} onAdminUnlock={(w) => { setAdmin({ id: w.id, name: w.name }); location.hash = '#/punches' }} />
      )}
      {current === 'enrol' && <Enrol settings={settings} onRegistered={onRegistered} />}
      {current === 'punches' && <Punches />}
      {current === 'settings' && <Settings settings={settings} onChange={update} />}
    </>
  )
}
