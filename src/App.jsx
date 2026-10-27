import { useEffect, useState } from 'react'
import Kiosk from './views/Kiosk.jsx'
import Enrol from './views/Enrol.jsx'
import Punches from './views/Punches.jsx'
import Settings from './views/Settings.jsx'
import { loadSettings, saveSettings } from './lib/settings.js'
import { startAutoSync } from './lib/sync.js'

const TABS = [
  ['kiosk', 'Picar'],
  ['enrol', 'Registar'],
  ['punches', 'Picagens'],
  ['settings', 'Definições'],
]

const routeFromHash = () => (location.hash.replace('#/', '') || 'kiosk').split('?')[0]

export default function App() {
  const [route, setRoute] = useState(routeFromHash())
  const [settings, setSettings] = useState(loadSettings)
  const [online, setOnline] = useState(navigator.onLine)

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

  const update = (s) => {
    saveSettings(s)
    setSettings(s)
  }

  return (
    <>
      <nav className="tabs">
        {TABS.map(([id, label]) => (
          <a key={id} href={`#/${id}`} className={route === id ? 'on' : ''}>
            {label}
          </a>
        ))}
        <span className="dev">{settings.deviceName} · {settings.direction === 'in' ? 'Entrada' : 'Saída'}</span>
      </nav>
      {route === 'kiosk' && <Kiosk settings={settings} online={online} />}
      {route === 'enrol' && <Enrol settings={settings} />}
      {route === 'punches' && <Punches settings={settings} />}
      {route === 'settings' && <Settings settings={settings} onChange={update} />}
    </>
  )
}
