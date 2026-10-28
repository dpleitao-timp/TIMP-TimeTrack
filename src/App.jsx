import { useCallback, useEffect, useState } from 'react'
import Kiosk from './views/Kiosk.jsx'
import Enrol from './views/Enrol.jsx'
import Punches from './views/Punches.jsx'
import Settings from './views/Settings.jsx'
import { loadSettings, saveSettings } from './lib/settings.js'
import { startAutoSync } from './lib/sync.js'
import { listWorkers, hasUsableAdmin } from './lib/db.js'

// Só o Administrador acede a estes separadores.
const ADMIN_TABS = [
  ['enrol', 'Registar'],
  ['punches', 'Picagens'],
  ['settings', 'Definições'],
]
const ADMIN_ROUTES = ADMIN_TABS.map(([id]) => id)
const ADMIN_IDLE_MS = 5 * 60 * 1000 // a sessão de administrador termina sem atividade

const routeFromHash = () => (location.hash.replace('#/', '') || 'kiosk').split('?')[0]

export default function App() {
  const [route, setRoute] = useState(routeFromHash())
  const [settings, setSettings] = useState(loadSettings)
  const [online, setOnline] = useState(navigator.onLine)
  const [hasAdmin, setHasAdmin] = useState(null) // null = a verificar
  const [admin, setAdmin] = useState(null) // sessão: { id, name }

  const refreshAdmin = useCallback(async () => {
    const workers = await listWorkers()
    setHasAdmin(hasUsableAdmin(workers))
    // se o Administrador com sessão aberta perdeu o perfil (ou foi apagado), a sessão termina
    setAdmin((a) => (a && !workers.some((w) => w.id === a.id && w.role === 'admin' && !w.broken) && hasUsableAdmin(workers) ? null : a))
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
  useEffect(() => startAutoSync(() => loadSettings()), [])

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
  const blocked = ADMIN_ROUTES.includes(route) && hasAdmin !== null && !unlocked
  useEffect(() => {
    if (blocked) location.hash = '#/kiosk'
  }, [blocked])

  const update = (s) => {
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
        <img src="/timp-logo.png" alt="TIMP" className="app-logo" />
        <nav className="tabs">
          <a href="#/kiosk" className={current === 'kiosk' ? 'tab on' : 'tab'}>
            Picar
          </a>
          {unlocked &&
            ADMIN_TABS.map(([id, label]) => (
              <a key={id} href={`#/${id}`} className={current === id ? 'tab on' : 'tab'}>
                {label}
              </a>
            ))}
        </nav>
        {admin && (
          <button type="button" className="header-chip button" onClick={logout}>
            🔓 {admin.name} · Terminar sessão
          </button>
        )}
        <span className="header-chip">
          <i className={online ? 'dot dot-on' : 'dot dot-off'} />
          {settings.deviceName}
        </span>
      </header>
      {hasAdmin === false && !admin && (
        <p className="notice notice-warn" style={{ margin: '0 16px 8px' }}>
          Ainda não há Administrador. O primeiro trabalhador registado em "Registar" fica Administrador e só ele acede depois a Registar, Picagens e Definições.
        </p>
      )}
      {current === 'kiosk' && (
        <Kiosk settings={settings} online={online} hasAdmin={!!hasAdmin} onAdminUnlock={(w) => { setAdmin({ id: w.id, name: w.name }); location.hash = '#/punches' }} />
      )}
      {current === 'enrol' && <Enrol settings={settings} onRegistered={onRegistered} />}
      {current === 'punches' && <Punches settings={settings} />}
      {current === 'settings' && <Settings settings={settings} onChange={update} />}
    </>
  )
}
