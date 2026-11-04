import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import Kiosk from './views/Kiosk.jsx'
import { SETUP_ID } from './views/Setup.jsx'
import ScanClock from './views/ScanClock.jsx'
import { loadSettings, saveSettings, missingFields } from './lib/settings.js'
import { startAutoSync, syncRoster } from './lib/sync.js'
import { listWorkers, hasUsableAdmin, isUsable, pendingPunches, dropWorkersCache } from './lib/db.js'
import { useT, LanguageSwitch } from './lib/i18n.jsx'
import { initHuman } from './lib/face.js'
import { warmCamera, releaseCamera, acquireCamera } from './lib/useCamera.js'
import { WAKE_MS } from './lib/schedule.js'
import { applyOrientation } from './lib/orientation.js'

// Só o Administrador acede a estes separadores. Os ecrãs carregam-se à parte, quando se abrem: quem pica não os usa, e assim o
// arranque não lê nem compila o código deles (o service worker já os tem guardados, por isso abrem sem rede).
const Enrol = lazy(() => import('./views/Enrol.jsx'))
const Punches = lazy(() => import('./views/Punches.jsx'))
const Settings = lazy(() => import('./views/Settings.jsx'))
const ADMIN_TABS = ['enrol', 'punches', 'settings']
const ADMIN_IDLE_MS = 5 * 60 * 1000 // a sessão de administrador termina sem atividade

const routeFromHash = () => (location.hash.replace('#/', '') || 'kiosk').split('?')[0]

// Mantém a câmara ligada a um vídeo minúsculo e quase invisível o tempo todo. Assim, quando o ecrã de leitura mostra a
// imagem, a câmara já estava a "ver" e não recomeça o ajuste de exposição (a imagem começava escura e demorava segundos).
function CameraKeepAlive({ deviceId }) {
  const ref = useRef(null)
  useEffect(() => {
    let cancelled = false
    const attach = async () => {
      try {
        const stream = await acquireCamera(deviceId)
        const v = ref.current
        if (cancelled || !v) return
        if (v.srcObject !== stream) v.srcObject = stream
        if (v.paused) await v.play()
      } catch {
        /* sem câmara ou sem permissão: o ecrã de leitura mostra o erro */
      }
    }
    const t = setTimeout(attach, 400) // depois do arranque rápido (a câmara é aberta por warmCamera)
    const onVisible = () => document.visibilityState === 'visible' && attach()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      clearTimeout(t)
      document.removeEventListener('visibilitychange', onVisible)
      if (ref.current) ref.current.srcObject = null
    }
  }, [deviceId])
  return <video ref={ref} className="camera-keepalive" muted playsInline aria-hidden="true" tabIndex={-1} />
}

// Ecrã de repouso: preto, sem câmara. Um toque ativa o tablet durante uns minutos.
// Só a frase do toque e, no canto inferior esquerdo, a data e a hora (o título e o motivo eram irrelevantes e foram
// retirados a pedido do utilizador).
function SleepScreen({ onWake }) {
  const { t } = useT()
  return (
    <button type="button" className="sleep-screen" onClick={onWake}>
      {t('sleep.touch', { min: Math.round(WAKE_MS / 60000) })}
      <ScanClock />
    </button>
  )
}

export default function App() {
  const { t } = useT()
  const [route, setRoute] = useState(routeFromHash())
  const [settings, setSettings] = useState(loadSettings)
  const [online, setOnline] = useState(navigator.onLine)
  const [hasAdmin, setHasAdmin] = useState(null) // null = a verificar
  const [admin, setAdmin] = useState(null) // sessão: { id, name }
  const [pending, setPending] = useState(0) // picagens por enviar
  // Repouso: o tablet está sempre em repouso (ecrã preto, câmara fechada) e só fica ativo durante WAKE_MS depois de um
  // toque (ou de a app abrir); cada toque prolonga o tempo ativo. Não depende da hora nem do dia da semana.
  const wakeUntil = useRef(Date.now() + WAKE_MS) // até quando fica ativo
  const [asleep, setAsleep] = useState(false)
  const sleepingNow = () => Date.now() > wakeUntil.current

  // recalcula de 15 em 15 s; qualquer toque prolonga o tempo ativo
  useEffect(() => {
    const check = () => setAsleep(sleepingNow())
    check()
    const timer = setInterval(check, 15000)
    const extend = () => {
      wakeUntil.current = Date.now() + WAKE_MS
    }
    window.addEventListener('pointerdown', extend)
    window.addEventListener('keydown', extend) // quem escreve nas Definições também está a usar o tablet
    return () => {
      clearInterval(timer)
      window.removeEventListener('pointerdown', extend)
      window.removeEventListener('keydown', extend)
    }
  }, [])

  // as definições mudaram fora desta página (o tablet ligou-se ao relay e apagou o código de instalação, ver relay.js)
  useEffect(() => {
    const h = () => setSettings(loadSettings())
    window.addEventListener('settings-changed', h)
    return () => window.removeEventListener('settings-changed', h)
  }, [])

  // orientação do ecrã escolhida nas Definições (onde o aparelho deixar fixá-la; ver orientation.js)
  useEffect(() => {
    applyOrientation(settings.orientation || 'auto')
  }, [settings.orientation])

  const wake = () => {
    wakeUntil.current = Date.now() + WAKE_MS
    setAsleep(false)
  }

  // ao adormecer: fecha a câmara, termina a sessão de Administrador e volta ao ecrã de picagem; ao acordar reabre-a
  useEffect(() => {
    if (asleep) {
      releaseCamera()
      dropWorkersCache() // os vetores decifrados não ficam em memória com o tablet em repouso
      setAdmin(null)
      location.hash = '#/kiosk'
    } else {
      warmCamera(loadSettings().cameraId)
    }
  }, [asleep])

  // enquanto o tablet está ativo o ecrã fica aceso; em repouso solta-se o bloqueio e o sistema pode apagá-lo
  useEffect(() => {
    if (asleep || !('wakeLock' in navigator)) return
    let lock = null
    let cancelled = false
    const request = async () => {
      try {
        lock?.release?.().catch(() => {})
        lock = await navigator.wakeLock.request('screen')
        if (cancelled) lock.release().catch(() => {})
      } catch {
        /* sem permissão ou aparelho sem suporte: o ecrã segue as definições do sistema */
      }
    }
    request()
    const onVisible = () => document.visibilityState === 'visible' && request()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      lock?.release?.().catch(() => {})
    }
  }, [asleep])

  // Modelos de reconhecimento e câmara abertos em segundo plano assim que a app abre (em qualquer ecrã),
  // para estarem prontos quando alguém carregar em Entrada/Saída. O pequeno atraso deixa a interface desenhar primeiro.
  useEffect(() => {
    const timer = setTimeout(() => {
      initHuman().catch(() => {})
      if (!sleepingNow()) warmCamera(loadSettings().cameraId) // câmara ligada enquanto o tablet está ativo
    }, 150)
    return () => clearTimeout(timer)
  }, [])

  const refreshAdmin = useCallback(async () => {
    const workers = await listWorkers()
    setHasAdmin(hasUsableAdmin(workers))
    // se o Administrador com sessão aberta perdeu o perfil (ou foi apagado), a sessão termina (a de instalação não é de um trabalhador)
    setAdmin((a) => (a && a.id !== SETUP_ID && !workers.some((w) => w.id === a.id && w.role === 'admin' && isUsable(w)) ? null : a))
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

  // lista de trabalhadores da obra: ao arrancar, a cada 5 min e quando a rede volta
  useEffect(() => {
    const run = () =>
      syncRoster(loadSettings())
        .then((r) => r.ok && !r.unchanged && window.dispatchEvent(new Event('roster-updated')))
    run()
    const timer = setInterval(run, 5 * 60 * 1000)
    window.addEventListener('online', run)
    return () => {
      clearInterval(timer)
      window.removeEventListener('online', run)
    }
  }, [])

  // contador de picagens por enviar, sempre visível no cabeçalho: lê-se ao arrancar e sempre que a fila muda (db.js avisa)
  useEffect(() => {
    const load = () => pendingPunches().then((p) => setPending(p.length))
    load()
    window.addEventListener('queue-changed', load)
    return () => window.removeEventListener('queue-changed', load)
  }, [])

  // A administração nunca está aberta: só com a sessão de um Administrador (reconhecimento facial) ou, se ainda não há nenhum, com a sessão de
  // instalação, que só se abre com um código de instalação válido (ver Setup.jsx).
  const unlocked = !!admin

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

  if (asleep) return <SleepScreen onWake={wake} />

  return (
    <>
      <CameraKeepAlive deviceId={settings.cameraId} />
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
          {settings.deviceId} · {online ? t('kiosk.online') : t('kiosk.offline')} · {t('kiosk.pendingSend', { n: pending })}
        </span>
      </header>
      {hasAdmin === false && !admin && !missingFields(settings).length && ( // tablet novo (por configurar): sem avisos, só o botão Administração
        <p className="notice notice-warn" style={{ margin: '0 16px 8px' }}>
          {t('app.noAdmin')}
        </p>
      )}
      <div className="app-version" title={`${__APP_VERSION__} · ${__APP_BUILD__} · ${__APP_DATE__}`}>
        v{__APP_VERSION__} · {__APP_BUILD__} · {__APP_DATE__}
      </div>
      {current === 'kiosk' && (
        <Kiosk settings={settings} hasAdmin={hasAdmin} onAdminUnlock={(w, route = '#/punches') => { setAdmin({ id: w.id, name: w.name }); location.hash = route }} />
      )}
      <Suspense fallback={null}>
        {current === 'enrol' && <Enrol settings={settings} onRegistered={onRegistered} />}
        {current === 'punches' && <Punches />}
        {current === 'settings' && <Settings settings={settings} onChange={update} />}
      </Suspense>
    </>
  )
}
