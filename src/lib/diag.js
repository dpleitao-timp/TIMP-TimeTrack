import { backendName, engineName } from './face.js'
import { loadSettings, thresholdFor } from './settings.js'

// Registo de diagnóstico do reconhecimento: os últimos fotogramas, um por linha, para se ver a sequência real
// (o rosto some? o estado alterna? quanto demora cada deteção?). Só em memória e só com "debug" ligado; nada sai do tablet.
const MAX = 400
let rows = []
let recs = [] // os mesmos fotogramas em números, para o resumo
let t0 = 0

const f = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '-')
const yn = (v) => (v ? 'S' : 'n')

export function diagStart() {
  t0 = performance.now()
  rows = []
  recs = []
}

// why: 'ok' | 'noface' | 'noembedding' (rosto sem vetor, também conta como "sem rosto" para o reconhecedor)
export function diagPush({ detMs, why, face, r, trace, video, light, noise, sat }) {
  if (!t0) t0 = performance.now()
  rows.push(
    [
      `+${String(Math.round(performance.now() - t0)).padStart(6)}ms`,
      `det ${String(detMs).padStart(4)}ms${face?.sfaceMs != null ? ` (SFace ${face.sfaceMs}ms)` : ''}`,
      `rosto ${why}`,
      `caixa ${f(face?.boxScore)} malha ${f(face?.faceScore)}`,
      `estado ${r.status}`,
      `n ${r.frames ?? trace?.buf ?? '-'}/${r.of ?? '-'}`,
      `sim ${f(r.similarity)} 2º ${f(r.second)}`,
      `real ${f(r.real)} live ${f(r.live)}`,
      `olho ${f(trace?.open)} piscou ${yn(trace?.blink)} virou ${yn(trace?.turn)}`,
      `pose virar ${f(trace?.yaw)} acenar ${f(trace?.pitch)} inclinar ${f(trace?.roll)}`,
      `vídeo ${video?.w}x${video?.h} estado ${video?.rs} luz ${video?.lum}`,
      `câmara fps ${video?.fps ?? '-'} exposição ${video?.exp ?? '-'} iso ${video?.iso ?? '-'} modo ${video?.mode ?? '-'}`,
      `cara luz ${f(light?.luma, 0)} moldura ${f(light?.frame, 1)}vmin`,
      `ruído ${f(noise, 2)} saturação ${f(sat == null ? null : sat * 100, 1)}%`,
    ].join(' | '),
  )
  recs.push({
    t: Math.round(performance.now() - t0),
    det: detMs,
    sface: face?.sfaceMs,
    status: r.status,
    sim: r.similarity,
    real: r.real,
    live: r.live,
    blink: !!trace?.blink,
    luma: light?.luma,
    frame: light?.frame,
    auto: light?.auto,
    noise,
    sat,
  })
  if (rows.length > MAX) {
    rows.shift()
    recs.shift()
  }
}

// Telas pequenas de medição: criam-se uma vez por tamanho e reutilizam-se (mudar a largura/altura de um canvas realoca-o, e estas
// medições correm a cada fotograma). willReadFrequently mantém-nas na memória do processador, que é onde se lê.
const probes = new Map()
function probe(w, h) {
  const key = `${w}x${h}`
  let c = probes.get(key)
  if (!c) {
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    c = canvas.getContext('2d', { willReadFrequently: true })
    probes.set(key, c)
  }
  return c
}

// Luminosidade média (0-255) dos pixels RGBA lidos de uma tela.
function meanLuma(d) {
  let sum = 0
  for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
  return sum / (d.length / 4)
}

// Estado do vídeo e luminosidade média (0-255): ajuda a ver se a imagem estava escura/estourada ou o vídeo ainda não corria.
let camTrack = null // faixa de vídeo em uso (para ler as capacidades da câmara)
export function videoInfo(v) {
  if (!v) return { w: 0, h: 0, rs: -1, lum: '-' }
  let lum = '-'
  let st = {}
  try {
    camTrack = v.srcObject?.getVideoTracks?.()[0] ?? camTrack
    st = camTrack?.getSettings?.() ?? {}
  } catch {
    /* sem faixa */
  }
  try {
    const c = probe(16, 16)
    c.drawImage(v, 0, 0, 16, 16)
    lum = Math.round(meanLuma(c.getImageData(0, 0, 16, 16).data))
  } catch {
    /* vídeo sem imagem ainda */
  }
  return {
    w: v.videoWidth,
    h: v.videoHeight,
    rs: v.readyState,
    lum,
    fps: st.frameRate ? Math.round(st.frameRate) : undefined,
    exp: st.exposureTime,
    iso: st.iso,
    mode: st.exposureMode,
  }
}

// Luminosidade média (0-255) da zona central da cara (60% da caixa, sem cabelo nem fundo).
export function faceLuma(v, box) {
  if (!v || !box || box.length < 4 || !v.videoWidth) return null
  try {
    const [x, y, w, h] = box
    if (!(w > 8 && h > 8)) return null
    const c = probe(16, 16)
    c.drawImage(v, x + w * 0.2, y + h * 0.2, w * 0.6, h * 0.6, 0, 0, 16, 16)
    return meanLuma(c.getImageData(0, 0, 16, 16).data)
  } catch {
    return null
  }
}

// Ruído da imagem: quanto cada pixel difere da média dos 4 vizinhos, numa janela de 64x64 pixels da cara (zona do nariz e
// bochechas, sem escalar), em percentagem da luminosidade média dessa janela. É relativo à luz de propósito: em valor
// absoluto o ruído sobe só porque a imagem ficou mais clara. Em pele lisa quase só sobra o ruído do sensor. Mais alto =
// mais ruído por unidade de luz.
export function faceNoise(v, box) {
  const vw = v?.videoWidth || v?.width
  const vh = v?.videoHeight || v?.height
  if (!v || !box || box.length < 4 || !vw || !vh) return null
  try {
    const [x, y, w, h] = box
    if (!(w > 80 && h > 80)) return null
    const N = 64
    const sx = Math.max(0, Math.min(vw - N, Math.round(x + w / 2 - N / 2)))
    const sy = Math.max(0, Math.min(vh - N, Math.round(y + h * 0.55 - N / 2)))
    const c = probe(N, N)
    c.drawImage(v, sx, sy, N, N, 0, 0, N, N)
    const d = c.getImageData(0, 0, N, N).data
    const L = new Float32Array(N * N)
    for (let i = 0; i < N * N; i++) L[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]
    let sum = 0
    let lum = 0
    let count = 0
    for (let yy = 1; yy < N - 1; yy++) {
      for (let xx = 1; xx < N - 1; xx++) {
        const i = yy * N + xx
        sum += Math.abs(L[i] - (L[i - 1] + L[i + 1] + L[i - N] + L[i + N]) / 4)
        lum += L[i]
        count++
      }
    }
    const mean = lum / count
    return mean > 1 ? (sum / count / mean) * 100 : null
  } catch {
    return null
  }
}

// Saturação: fração (0 a 1) da imagem inteira com pixels quase brancos (algum canal >= 250). Quando a imagem estoura
// perde-se informação; a moldura de luz usa isto para não crescer mais. A causa não está apurada (ver a nota do
// utilizador no ficheiro de decisões): é uma medida, não uma explicação.
export function saturation(v) {
  const vw = v?.videoWidth || v?.width
  const vh = v?.videoHeight || v?.height
  if (!v || !vw || !vh) return null
  try {
    const W = 64
    const H = 36
    const c = probe(W, H)
    c.drawImage(v, 0, 0, W, H)
    const d = c.getImageData(0, 0, W, H).data
    let n = 0
    for (let i = 0; i < d.length; i += 4) if (d[i] >= 250 || d[i + 1] >= 250 || d[i + 2] >= 250) n++
    return n / (W * H)
  } catch {
    return null
  }
}

export const diagCount = () => rows.length

const nums = (a) => a.filter((v) => typeof v === 'number' && Number.isFinite(v))
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)
const minOf = (a) => (a.length ? Math.min(...a) : null)
const maxOf = (a) => (a.length ? Math.max(...a) : null)

// Uma linha com o essencial da leitura, para comparar leituras sem colar o registo todo.
function summary() {
  if (!recs.length) return 'RESUMO sem fotogramas'
  const s = loadSettings()
  const first = (pred) => recs.find(pred)?.t
  const sim = nums(recs.map((x) => x.sim))
  const real = nums(recs.map((x) => x.real))
  const live = nums(recs.map((x) => x.live))
  const luma = nums(recs.map((x) => x.luma))
  const det = nums(recs.map((x) => x.det))
  const last = recs[recs.length - 1]
  const sat = nums(recs.map((x) => x.sat))
  const pct = (v) => (v == null ? null : v * 100)
  return [
    'RESUMO',
    `moldura auto ${last.auto ? 'LIGADA' : 'DESLIGADA'} (${f(last.frame, 1)}vmin)`,
    `limiar ${thresholdFor(s)} motor ${engineName()} backend ${backendName()}`,
    `${recs.length} fotogramas em ${last.t}ms`,
    `1º match ${first((x) => x.status === 'match') ?? '-'}ms`,
    `1º piscar ${first((x) => x.blink) ?? '-'}ms`,
    `sim média ${f(avg(sim))} mín ${f(minOf(sim))} máx ${f(maxOf(sim))}`,
    `unknown ${recs.filter((x) => x.status === 'unknown').length} spoof ${recs.filter((x) => x.status === 'spoof').length}`,
    `luz cara média ${f(avg(luma), 0)}`,
    `ruído médio ${f(avg(nums(recs.map((x) => x.noise))), 2)}`,
    `saturação média ${f(pct(avg(sat)), 1)}% máx ${f(pct(maxOf(sat)), 1)}%`,
    `real média ${f(avg(real))} mín ${f(minOf(real))}`,
    `live média ${f(avg(live))} mín ${f(minOf(live))}`,
    `det média ${f(avg(det), 0)}ms${engineName() === 'sface' ? ` (SFace ${f(avg(nums(recs.map((x) => x.sface))), 0)}ms)` : ''}`,
  ].join(' | ')
}

// O que a câmara declara poder regular (depende do aparelho e do navegador; no iPad quase nada).
const CAP_KEYS = ['exposureMode', 'exposureTime', 'exposureCompensation', 'iso', 'brightness', 'contrast', 'sharpness', 'whiteBalanceMode', 'colorTemperature', 'focusMode', 'frameRate', 'zoom', 'torch']
function capabilitiesLine() {
  try {
    const c = camTrack?.getCapabilities?.()
    if (!c) return 'CÂMARA capacidades: o navegador não as indica'
    const keys = [...CAP_KEYS, ...Object.keys(c).filter((k) => !CAP_KEYS.includes(k))]
    const parts = keys.map((k) => {
      const v = c[k]
      if (v === undefined) return `${k}:não`
      if (Array.isArray(v)) return `${k}:[${v.join(',')}]`
      if (typeof v === 'object') return `${k}:${v.min}-${v.max}`
      return `${k}:${v}`
    })
    return `CÂMARA capacidades: ${parts.join(' ')}`
  } catch {
    return 'CÂMARA capacidades: erro ao ler'
  }
}

// Que aparelho e navegador produziram este registo (evita confundir testes de aparelhos diferentes).
function deviceLine() {
  try {
    return `APARELHO ${navigator.platform || '-'} · ecrã ${innerWidth}x${innerHeight}@${devicePixelRatio} · núcleos ${navigator.hardwareConcurrency ?? '-'} · ${navigator.userAgent}`
  } catch {
    return 'APARELHO desconhecido'
  }
}

export function diagText() {
  const head = `TIMP Time Clock · diagnóstico · ${new Date().toISOString()} · ${rows.length} fotogramas · backend ${backendName()}`
  return [head, deviceLine(), summary(), capabilitiesLine(), ...rows].join('\n')
}
