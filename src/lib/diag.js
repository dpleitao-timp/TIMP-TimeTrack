import { backendName } from './face.js'

// Registo de diagnóstico do reconhecimento: os últimos fotogramas, um por linha, para se ver a sequência real
// (o rosto some? o estado alterna? quanto demora cada deteção?). Só em memória e só com "debug" ligado; nada sai do tablet.
const MAX = 400
let rows = []
let t0 = 0

const f = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '-')
const yn = (v) => (v ? 'S' : 'n')

export function diagStart() {
  t0 = performance.now()
  rows = []
}

// why: 'ok' | 'noface' | 'noembedding' (rosto sem vetor, também conta como "sem rosto" para o reconhecedor)
export function diagPush({ detMs, why, face, r, trace, video, light }) {
  if (!t0) t0 = performance.now()
  rows.push(
    [
      `+${String(Math.round(performance.now() - t0)).padStart(6)}ms`,
      `det ${String(detMs).padStart(4)}ms`,
      `rosto ${why}`,
      `caixa ${f(face?.boxScore)} malha ${f(face?.faceScore)}`,
      `estado ${r.status}`,
      `n ${r.frames ?? trace?.buf ?? '-'}/${r.of ?? '-'}`,
      `sim ${f(r.similarity)} 2º ${f(r.second)}`,
      `real ${f(r.real)} live ${f(r.live)}`,
      `olho ${f(trace?.open)} piscou ${yn(trace?.blink)} virou ${yn(trace?.turn)}`,
      `pose virar ${f(trace?.yaw)} acenar ${f(trace?.pitch)} inclinar ${f(trace?.roll)}`,
      `vídeo ${video?.w}x${video?.h} estado ${video?.rs} luz ${video?.lum}`,
      `cara luz ${f(light?.luma, 0)} moldura ${f(light?.frame, 1)}vmin`,
    ].join(' | '),
  )
  if (rows.length > MAX) rows.shift()
}

// Estado do vídeo e luminosidade média (0-255): ajuda a ver se a imagem estava escura/estourada ou o vídeo ainda não corria.
let probe
export function videoInfo(v) {
  if (!v) return { w: 0, h: 0, rs: -1, lum: '-' }
  let lum = '-'
  try {
    probe ??= document.createElement('canvas')
    probe.width = probe.height = 16
    const c = probe.getContext('2d', { willReadFrequently: true })
    c.drawImage(v, 0, 0, 16, 16)
    const d = c.getImageData(0, 0, 16, 16).data
    let sum = 0
    for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
    lum = Math.round(sum / (d.length / 4))
  } catch {
    /* vídeo sem imagem ainda */
  }
  return { w: v.videoWidth, h: v.videoHeight, rs: v.readyState, lum }
}

// Luminosidade média (0-255) da zona central da cara (60% da caixa, sem cabelo nem fundo).
let faceProbe
export function faceLuma(v, box) {
  if (!v || !box || box.length < 4 || !v.videoWidth) return null
  try {
    const [x, y, w, h] = box
    if (!(w > 8 && h > 8)) return null
    faceProbe ??= document.createElement('canvas')
    faceProbe.width = faceProbe.height = 16
    const c = faceProbe.getContext('2d', { willReadFrequently: true })
    c.drawImage(v, x + w * 0.2, y + h * 0.2, w * 0.6, h * 0.6, 0, 0, 16, 16)
    const d = c.getImageData(0, 0, 16, 16).data
    let sum = 0
    for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
    return sum / (d.length / 4)
  } catch {
    return null
  }
}

export const diagCount = () => rows.length

export function diagText() {
  const head = `TIMP Time Clock · diagnóstico · ${new Date().toISOString()} · ${rows.length} fotogramas · backend ${backendName()}`
  return [head, ...rows].join('\n')
}
