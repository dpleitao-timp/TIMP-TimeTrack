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
export function diagPush({ detMs, why, face, r, trace }) {
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
    ].join(' | '),
  )
  if (rows.length > MAX) rows.shift()
}

export const diagCount = () => rows.length

export function diagText() {
  const head = `TIMP Time Clock · diagnóstico · ${new Date().toISOString()} · ${rows.length} fotogramas`
  return [head, ...rows].join('\n')
}
