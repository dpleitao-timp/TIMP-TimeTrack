import { useEffect, useRef, useState } from 'react'
import { initHuman, detect, backendName } from '../lib/face.js'
import { createRecognizer } from '../lib/recognizer.js'
import { useModelsReady } from '../lib/useModels.js'
import { listWorkers, enqueuePunch, pendingPunches, msSinceLastPunch, getClockOffset } from '../lib/db.js'
import { fmtDateTime } from '../lib/date.js'
import { flushQueue } from '../lib/sync.js'
import { bumpStat } from '../lib/settings.js'
import { useCamera } from '../lib/useCamera.js'
import { diagStart, diagPush, videoInfo, faceLuma } from '../lib/diag.js'
import { createLightControl } from '../lib/lightframe.js'
import { useT } from '../lib/i18n.jsx'
import AdminLogin from './AdminLogin.jsx'

const fmtTime = (iso, locale) => new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
const FAST_REAL = 0.8 // confiança mínima do anti-foto para dispensar o piscar no modo rápido
const SIDE_FACTOR = 2.5 // as laterais da moldura são tantas vezes mais largas do que o topo e a base
const BAD_SHOW_MS = 1500 // "foto" / "não reconhecido" só aparecem se durarem isto sem interrupção
const SCAN_TIMEOUT_MS = 45000 // sem picar, a câmara desliga e volta à escolha

// Ecrã de escolha: a câmara só liga depois de escolher Entrada ou Saída.
export default function Kiosk({ settings, hasAdmin, onAdminUnlock, setPending }) {
  const { t } = useT()
  const [direction, setDirection] = useState(null) // null | 'in' | 'out'
  const [adminLogin, setAdminLogin] = useState(false)
  const [modelsError, setModelsError] = useState('')
  const modelsState = useModelsReady()

  useEffect(() => {
    // modelos pré-carregados para a câmara reconhecer logo ao ligar (a câmara não é ligada aqui)
    initHuman().catch((e) => setModelsError(e?.message || String(e)))
  }, [])

  if (adminLogin) {
    return (
      <AdminLogin
        settings={settings}
        onCancel={() => setAdminLogin(false)}
        onUnlock={(worker) => {
          setAdminLogin(false)
          onAdminUnlock(worker)
        }}
      />
    )
  }

  if (direction) {
    return (
      <Scan
        key={direction}
        settings={settings}
        direction={direction}
        setPending={setPending}
        onDone={() => setDirection(null)}
      />
    )
  }

  return (
    <div className="kiosk-wrap">
      <div className="choice">
        <h2 className="choice-title">{t('kiosk.whatToRegister')}</h2>
        <p className="muted">{t('kiosk.chooseToStart')}</p>
        {modelsState === 'loading' && <p className="muted preparing">⏳ {t('kiosk.preparing')}</p>}
        {!settings.obra?.trim() && <p className="notice notice-warn">{t('kiosk.noObra')}</p>}
        <div className="choice-buttons">
          {settings.mode !== 'out' && (
            <button type="button" className="choice-btn in" disabled={!settings.obra?.trim()} onClick={() => setDirection('in')}>
              <IconIn size={72} />
              <span>{t('dir.in')}</span>
            </button>
          )}
          {settings.mode !== 'in' && (
            <button type="button" className="choice-btn out" disabled={!settings.obra?.trim()} onClick={() => setDirection('out')}>
              <IconOut size={72} />
              <span>{t('dir.out')}</span>
            </button>
          )}
        </div>
        {modelsError && <p className="notice notice-error">{t('kiosk.modelsFail', { err: modelsError })}</p>}
        {hasAdmin && (
          <button type="button" className="btn btn-secondary choice-admin" onClick={() => setAdminLogin(true)}>
            {t('kiosk.admin')}
          </button>
        )}
      </div>
    </div>
  )
}

// Data e hora no canto do ecrã de leitura. Usa a hora corrigida pelo servidor (a mesma que se grava na picagem).
function ScanClock() {
  const [now, setNow] = useState(() => Date.now())
  const offset = useRef(0)
  useEffect(() => {
    let alive = true
    getClockOffset().then((o) => {
      if (alive) offset.current = o
    })
    const timer = setInterval(() => setNow(Date.now() + offset.current), 1000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])
  return <div className="scan-clock">{fmtDateTime(now)}</div>
}

function Scan({ settings, direction, setPending, onDone }) {
  const { t, locale } = useT()
  const videoRef = useRef(null)
  const kioskRef = useRef(null)
  const { ready, error } = useCamera(videoRef, { deviceId: settings.cameraId })
  const [loading, setLoading] = useState(t('kiosk.loadingModels'))
  const [banner, setBanner] = useState({ kind: 'idle', text: t('kiosk.approach') })
  const show = (b) => setBanner((cur) => (cur.kind === b.kind && cur.text === b.text && cur.sub === b.sub ? cur : b))
  const [debug, setDebug] = useState(null)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  const isIn = direction === 'in'

  useEffect(() => {
    if (!ready) return
    let stop = false
    const timers = []
    const startedAt = performance.now()
    let workers = []
    let recognizer = null
    let light = null // moldura branca adaptativa
    let pauseUntil = 0
    let lastReject = 0
    let badSince = 0 // desde quando o estado é spoof/unknown sem interrupção (0 = não está)

    ;(async () => {
      await initHuman()
      if (stop) return
      setLoading('')
      workers = await listWorkers()
      recognizer = createRecognizer(() => settingsRef.current, workers)
      diagStart() // um registo novo por cada leitura (o último fica disponível nas Definições)
      // topo e base seguem a espessura calculada; as laterais, que têm muito espaço num ecrã largo, ficam 2,5 vezes mais largas
      // (só com a moldura adaptativa ligada). Mais área branca ao lado da cara, mais luz difusa.
      const autoFrame = settingsRef.current.lightFrameAuto !== false
      light = createLightControl((v) => {
        const el = kioskRef.current
        if (!el) return
        el.style.setProperty('--light-frame', `${v}vmin`)
        el.style.setProperty('--light-frame-x', `${autoFrame ? v * SIDE_FACTOR : v}vmin`)
      }, autoFrame)
      if (!workers.some((w) => !w.stale && !w.broken)) show({ kind: 'warn', text: workers.length ? t('kiosk.staleWorkers') : t('kiosk.noWorkers') })

      const loop = async () => {
        if (stop) return
        const s = settingsRef.current
        if (performance.now() - startedAt > SCAN_TIMEOUT_MS && performance.now() >= pauseUntil) return onDoneRef.current()
        if (performance.now() < pauseUntil) return requestAnimationFrame(loop)
        try {
          const t0 = performance.now()
          const { face, gestures, why, raw } = await detect(videoRef.current)
          const detMs = Math.round(performance.now() - t0)
          if (stop) return
          const r = recognizer.push(face, gestures)
          setDebug(s.debug ? { ...r, detMs } : null)
          if (face) light.update(faceLuma(videoRef.current, face.box)) // a luz da cara decide a espessura da moldura
          if (s.debug) diagPush({ detMs, why, face: raw, r, trace: recognizer.trace(), video: videoInfo(videoRef.current), light: light.state() })
          if (r.status === 'hold') return requestAnimationFrame(loop) // falha momentânea do detetor: não mexe no ecrã
          if (r.status === 'none') {
            setBanner((b) => (b.kind === 'ok' || (b.kind === 'idle' && b.text === t('kiosk.approach')) ? b : { kind: 'idle', text: t('kiosk.approach') }))
            return requestAnimationFrame(loop)
          }
          const now = performance.now()
          const confident = s.fastLiveness && r.real >= FAST_REAL && r.live >= FAST_REAL // modo rápido: o modelo já tem a certeza
          const alive = !s.liveness || r.blink || r.turn || confident
          if (r.status !== 'spoof' && r.status !== 'unknown') badSince = 0
          if (r.status === 'collecting') {
            show({ kind: 'idle', text: t('kiosk.recognizing') })
            return requestAnimationFrame(loop)
          }
          if (r.status === 'confirming') {
            // já se sabe quem é: pede logo para piscar, em vez de esperar pela confirmação final
            show(alive ? { kind: 'idle', text: t('kiosk.recognizing') } : { kind: 'warn', text: t('kiosk.blink', { name: r.worker.name }) })
            return requestAnimationFrame(loop)
          }
          if (r.status === 'spoof' || r.status === 'unknown') {
            // Estes estados tremem de fotograma para fotograma (a semelhança anda à volta do limiar, o modelo anti-foto
            // demora a estabilizar). A picagem já fica bloqueada; o aviso vermelho só aparece se persistir.
            badSince ||= now
            if (now - badSince < BAD_SHOW_MS) {
              show({ kind: 'idle', text: t('kiosk.recognizing') })
              return requestAnimationFrame(loop)
            }
            if (now - lastReject > 2000) bumpStat(r.status === 'spoof' ? 'spoofRejected' : 'unknown')
            lastReject = now
            show({ kind: 'bad', text: t(r.status === 'spoof' ? 'kiosk.spoof' : 'kiosk.unknown') })
            return requestAnimationFrame(loop)
          }

          // r.status === 'match': média dos fotogramas coincide com um trabalhador, de forma estável
          const { worker, similarity } = r
          if (!alive) {
            show({ kind: 'warn', text: t('kiosk.blink', { name: worker.name }) })
            return requestAnimationFrame(loop)
          }
          const waitMs = Number(s.cooldownSec) * 1000 - (await msSinceLastPunch(worker.id))
          if (waitMs > 0) {
            show({ kind: 'warn', text: t('kiosk.alreadyWait', { name: worker.name, min: Math.ceil(waitMs / 60000) }) })
            pauseUntil = performance.now() + 2500
            recognizer.reset()
            return requestAnimationFrame(loop)
          }
          const ms = Math.round(performance.now() - r.start)
          const punch = await enqueuePunch({
            deviceId: s.deviceId,
            direction,
            obra: s.obra.trim(),
            sageId: worker.id,
            workerName: worker.name,
            confidence: similarity,
            second: r.hasSecond ? r.second : null, // o 2º mais parecido e os valores do anti-foto: só para afinar o sistema
            real: r.real,
            live: r.live,
          })
          bumpStat('punches', ms)
          show({
            kind: 'ok',
            text: t('kiosk.hello', { name: worker.name }),
            sub: `${isIn ? t('dir.in') : t('dir.out')} ${fmtTime(punch.punchedAt, locale)}`,
          })
          setPending((await pendingPunches()).length)
          flushQueue(s).then((res) => setPending(res.pending))
          recognizer.reset()
          pauseUntil = performance.now() + 3500
          // registado: a câmara desliga e volta ao ecrã de escolha
          timers.push(setTimeout(() => onDoneRef.current(), 3500))
        } catch (e) {
          console.error(e)
        }
        requestAnimationFrame(loop)
      }
      requestAnimationFrame(loop)
    })()

    return () => {
      stop = true
      timers.forEach(clearTimeout)
    }
  }, [ready, direction, setPending])

  return (
    <div className="kiosk-wrap">
      <div ref={kioskRef} className={`kiosk ${isIn ? 'in' : 'out'}`}>
        <video ref={videoRef} muted playsInline className="mirror" />
        <div className="kiosk-top">
          <span className="dir">
            {isIn ? <IconIn size={26} /> : <IconOut size={26} />}
            {(isIn ? t('dir.in') : t('dir.out')).toLocaleUpperCase(locale)}
          </span>
          {settings.obra?.trim() && (
            <span className="obra-pill" title={t('kiosk.obraLabel')}>
              {t('kiosk.obraLabel')} <strong>{settings.obra.trim()}</strong>
            </span>
          )}
        </div>
        <ScanClock />
        <div className={`banner ${banner.kind}`}>
          <div className="banner-main">{error || loading || banner.text}</div>
          {banner.sub && !loading && <div className="banner-sub">{banner.sub}</div>}
        </div>
        {debug && (
          <div className="debug" onClick={() => setDebug(null)}>
            {backendName()} {debug.detMs} ms · {debug.status} · n {debug.frames ?? 0}/{debug.of ?? '-'} · sim {debug.similarity?.toFixed(2) ?? '-'} (2º {debug.second?.toFixed(2) ?? '-'}) · real {debug.real?.toFixed(2) ?? '-'} · live {debug.live?.toFixed(2) ?? '-'}
          </div>
        )}
      </div>

      <div className="kiosk-dock">
        <button type="button" className="btn btn-secondary dock-back" onClick={onDone}>
          {t('kiosk.back')}
        </button>
      </div>
    </div>
  )
}

// Seta a entrar numa porta / seta a sair de uma porta.
function IconIn({ size = 30 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3" />
      <path d="M10 17l5-5-5-5" />
      <path d="M15 12H3" />
    </svg>
  )
}

function IconOut({ size = 30 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  )
}
