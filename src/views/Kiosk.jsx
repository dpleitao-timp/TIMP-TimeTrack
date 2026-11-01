import { useEffect, useRef, useState } from 'react'
import { initHuman, detect, backendName } from '../lib/face.js'
import { createRecognizer } from '../lib/recognizer.js'
import { useModelsReady } from '../lib/useModels.js'
import { listWorkers, enqueuePunch, punchStatus } from '../lib/db.js'
import { flushQueue } from '../lib/sync.js'
import { bumpStat, missingFields } from '../lib/settings.js'
import { useCamera } from '../lib/useCamera.js'
import { diagStart, diagPush, videoInfo, faceNoise } from '../lib/diag.js'
import { createLightControl, setFrameVars } from '../lib/lightframe.js'
import { BAD_SHOW_MS, isAlive, allowedDirections } from '../lib/scanrules.js'
import { useT } from '../lib/i18n.jsx'
import AdminLogin from './AdminLogin.jsx'
import ScanClock from './ScanClock.jsx'

const fmtTime = (iso, locale) => new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
const SCAN_TIMEOUT_MS = 45000 // sem picar, a câmara desliga e volta à escolha
const CHOICE_MS = 20000 // a escolher o movimento: sem escolher, volta ao ecrã inicial

// Tipos de picagem. in/out são a entrada e a saída da obra; meal_out/meal_in (opcionais, ligados nas Definições) são a saída
// para almoço/jantar e a volta. O valor é o que se grava e se envia; cls é a classe de estilo.
const DIRS = {
  in: { label: 'dir.in', cls: 'in' },
  out: { label: 'dir.out', cls: 'out' },
  meal_out: { label: 'dir.mealOut', cls: 'meal-out' },
  meal_in: { label: 'dir.mealIn', cls: 'meal-in' },
}

// Ecrã de escolha: a câmara só liga depois de escolher Entrada ou Saída.
// hasAdmin: null enquanto se verifica, depois true/false (há um Administrador utilizável?).
export default function Kiosk({ settings, hasAdmin, onAdminUnlock }) {
  const { t } = useT()
  // O tablet só pica com um Administrador registado e com os campos obrigatórios das Definições preenchidos (ver missingFields).
  const missing = missingFields(settings)
  const ready = hasAdmin === true && !missing.length
  const list = missing.map((k) => t(`settings.${k}`)).join(', ')
  const [direction, setDirection] = useState(null) // null | 'in' | 'out' | 'meal_out' | 'meal_in'
  const [adminLogin, setAdminLogin] = useState(false)
  const [modelsError, setModelsError] = useState('')
  const modelsState = useModelsReady()
  const ico = settings.mealPunches ? 44 : 72 // com as 4 opções os ícones são mais pequenos (cabem 4 numa linha)

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
        onDone={() => setDirection(null)}
      />
    )
  }

  return (
    <div className="kiosk-wrap">
      <div className="choice">
        {modelsState === 'loading' && <p className="muted preparing">⏳ {t('kiosk.preparing')}</p>}
        {hasAdmin !== null && !ready && (
          <div className="notice notice-warn">
            <strong>{t('kiosk.setupTitle')}</strong>
            {!hasAdmin && <div>{t('kiosk.setupNeedAdmin')}</div>}
            {missing.length > 0 && <div>{t(hasAdmin ? 'kiosk.setupFieldsAdmin' : 'kiosk.setupFields', { list })}</div>}
          </div>
        )}
        {/* Uma só linha, por esta ordem: Entrada, Saída para almoço/jantar, Entrada de almoço/jantar, Saída. Cores: verde = entrada,
            vermelho = saída. Os botões têm todos o mesmo tamanho. Num tablet só de entradas ou só de saídas mostram-se os que se aplicam. */}
        <div className={`choice-buttons ${settings.mealPunches ? 'has-meal' : ''}`}>
          {settings.mode !== 'out' && (
            <button type="button" className="choice-btn in" disabled={!ready} onClick={() => setDirection('in')}>
              <IconIn size={ico} />
              <span>{t('dir.in')}</span>
            </button>
          )}
          {settings.mealPunches && settings.mode !== 'in' && (
            <button type="button" className="choice-btn meal-out" disabled={!ready} onClick={() => setDirection('meal_out')}>
              <span className="choice-icons">
                <IconMeal size={ico} />
                <IconOut size={ico} />
              </span>
              <span>{t('dir.mealOut')}</span>
            </button>
          )}
          {settings.mealPunches && settings.mode !== 'out' && (
            <button type="button" className="choice-btn meal-in" disabled={!ready} onClick={() => setDirection('meal_in')}>
              <span className="choice-icons">
                <IconMeal size={ico} />
                <IconIn size={ico} />
              </span>
              <span>{t('dir.mealIn')}</span>
            </button>
          )}
          {settings.mode !== 'in' && (
            <button type="button" className="choice-btn out" disabled={!ready} onClick={() => setDirection('out')}>
              <IconOut size={ico} />
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
        <ScanClock className="choice-clock" /> {/* data e hora sempre visíveis no canto inferior esquerdo */}
      </div>
    </div>
  )
}

function Scan({ settings, direction, onDone }) {
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

  // Movimento repetido: se o trabalhador já tem hoje o tipo de picagem que escolheu, em vez de o repetir pergunta qual o movimento e só
  // propõe os que ainda não tem (assim não ficam dois movimentos do mesmo tipo no mesmo dia). `choice` mostra a pergunta; `picked`
  // é o tipo escolhido (o cabeçalho passa a mostrá-lo); `pending` guarda quem foi reconhecido enquanto se escolhe.
  const [choice, setChoice] = useState(null) // null | { name, dup, options }
  const [picked, setPicked] = useState(null)
  const pending = useRef(null)
  const recordRef = useRef(null)
  const choiceTimer = useRef(null)

  const shownDirection = picked ?? direction
  const punched = banner.kind === 'ok' && !choice // a picagem acabou de ser validada
  const dir = DIRS[shownDirection] ?? DIRS.in
  const isMeal = shownDirection === 'meal_out' || shownDirection === 'meal_in'
  const isArrival = shownDirection === 'in' || shownDirection === 'meal_in' // entrada (da obra ou do almoço/jantar)

  const pick = async (d) => {
    clearTimeout(choiceTimer.current)
    const p = pending.current
    if (!p) return
    pending.current = null
    setChoice(null)
    setPicked(d)
    await recordRef.current?.(d, p.worker, p.r)
  }

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
      // topo e base seguem a espessura calculada; as laterais, que têm muito espaço num ecrã largo, crescem mais
      // (só com a moldura adaptativa ligada). Mais área branca ao lado da cara, mais luz difusa.
      const autoFrame = settingsRef.current.lightFrameAuto !== false
      light = createLightControl((v) => setFrameVars(kioskRef.current, v, autoFrame), autoFrame)
      if (!workers.some((w) => !w.stale && !w.broken)) show({ kind: 'warn', text: workers.length ? t('kiosk.staleWorkers') : t('kiosk.noWorkers') })

      // Grava a picagem do tipo `d` para `worker` (r = a leitura do reconhecedor que o identificou) e mostra a confirmação.
      const record = async (d, worker, r) => {
        const s = settingsRef.current
        const ms = Math.round(performance.now() - r.start)
        const punch = await enqueuePunch({
          deviceId: s.deviceId,
          direction: d,
          obra: s.obra.trim(),
          sageId: worker.id,
          workerName: worker.name,
          confidence: r.similarity,
          second: r.hasSecond ? r.second : null, // o 2º mais parecido e os valores do anti-foto: só para afinar o sistema
          real: r.real,
          live: r.live,
        })
        bumpStat('punches', ms)
        show({
          kind: 'ok',
          text: t('kiosk.hello', { name: worker.name }),
          sub: `${t((DIRS[d] ?? DIRS.in).label)} ${fmtTime(punch.punchedAt, locale)}`,
        })
        flushQueue(s) // o contador do cabeçalho acompanha a fila sozinho (evento queue-changed)
        recognizer.reset()
        pauseUntil = performance.now() + 3500
        // registado: a câmara desliga e volta ao ecrã de escolha
        timers.push(setTimeout(() => onDoneRef.current(), 3500))
      }
      recordRef.current = record

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
          if (face) light.sample(videoRef.current, face.box) // a luz da cara decide a espessura da moldura (e a imagem estourada trava-a)
          if (s.debug) {
            const ls = light.state()
            diagPush({ detMs, why, face: raw, r, trace: recognizer.trace(), video: videoInfo(videoRef.current), light: ls, noise: face ? faceNoise(videoRef.current, face.box) : null, sat: ls.sat })
          }
          if (r.status === 'hold') return requestAnimationFrame(loop) // falha momentânea do detetor: não mexe no ecrã
          if (r.status === 'none') {
            setBanner((b) => (b.kind === 'ok' || (b.kind === 'idle' && b.text === t('kiosk.approach')) ? b : { kind: 'idle', text: t('kiosk.approach') }))
            return requestAnimationFrame(loop)
          }
          const now = performance.now()
          const alive = isAlive(s, r)
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
          const { worker } = r
          if (!alive) {
            show({ kind: 'warn', text: t('kiosk.blink', { name: worker.name }) })
            return requestAnimationFrame(loop)
          }
          const { msSince, directions: taken } = await punchStatus(worker.id) // uma só leitura da fila
          const waitMs = Number(s.cooldownSec) * 1000 - msSince
          if (waitMs > 0) {
            show({ kind: 'warn', text: t('kiosk.alreadyWait', { name: worker.name, min: Math.ceil(waitMs / 60000) }) })
            pauseUntil = performance.now() + 2500
            recognizer.reset()
            return requestAnimationFrame(loop)
          }
          // Já tem este tipo de movimento hoje? Pergunta qual o movimento, só com os que ainda não tem.
          if (taken.has(direction)) {
            const options = allowedDirections(s).filter((d) => !taken.has(d))
            recognizer.reset()
            if (!options.length) {
              show({ kind: 'warn', text: t('kiosk.allDoneToday', { name: worker.name }) })
              pauseUntil = performance.now() + 4000
              timers.push(setTimeout(() => onDoneRef.current(), 4000))
              return requestAnimationFrame(loop)
            }
            pending.current = { worker, r }
            pauseUntil = performance.now() + CHOICE_MS + 2000 // o reconhecimento fica parado enquanto se escolhe
            setChoice({ name: worker.name, dup: direction, options })
            choiceTimer.current = setTimeout(() => onDoneRef.current(), CHOICE_MS)
            return requestAnimationFrame(loop)
          }
          await record(direction, worker, r)
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
      clearTimeout(choiceTimer.current)
    }
  }, [ready, direction])

  return (
    <div className="kiosk-wrap">
      <div ref={kioskRef} className={`kiosk ${dir.cls}`}>
        <video ref={videoRef} muted playsInline className="mirror" />
        <div className="kiosk-top">
          <span className="dir">
            {isMeal && <IconMeal size={26} />}
            {isArrival ? <IconIn size={26} /> : <IconOut size={26} />}
            {t(dir.label).toLocaleUpperCase(locale)}
          </span>
          {settings.obra?.trim() && (
            <span className="obra-pill" title={t('kiosk.obraLabel')}>
              {t('kiosk.obraLabel')} <strong>{settings.obra.trim()}</strong>
            </span>
          )}
        </div>
        {punched && (
          // picagem validada: visto verde bem visível no canto superior direito, além da mensagem
          <div className="punch-ok" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4.5 12.8l4.8 4.8L19.5 7" />
            </svg>
          </div>
        )}
        <ScanClock />
        {choice ? (
          <div className="pick-overlay">
            <div className="pick-title">{t('kiosk.alreadyToday', { name: choice.name, type: t(DIRS[choice.dup].label) })}</div>
            <div className="pick-buttons">
              {choice.options.map((d) => (
                <button key={d} type="button" className={`choice-btn ${DIRS[d].cls}`} onClick={() => pick(d)}>
                  <span className="choice-icons">
                    {(d === 'meal_out' || d === 'meal_in') && <IconMeal size={36} />}
                    {d === 'in' || d === 'meal_in' ? <IconIn size={36} /> : <IconOut size={36} />}
                  </span>
                  <span>{t(DIRS[d].label)}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className={`banner ${banner.kind}`}>
            <div className="banner-main">{error || loading || banner.text}</div>
            {banner.sub && !loading && <div className="banner-sub">{banner.sub}</div>}
          </div>
        )}
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

// Uma refeição: prato com garfo e faca (almoço/jantar).
function IconMeal({ size = 30 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4.2" />
      <path d="M2.8 3v5.5a2 2 0 0 0 4 0V3M4.8 3v18" />
      <path d="M21.2 21V3c-2 1.4-3 4-3 7v3.5h3" />
    </svg>
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
