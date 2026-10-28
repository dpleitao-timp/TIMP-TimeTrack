import { rankMatches, meanEmbedding, livenessSignals } from './face.js'

// Reconhecimento por janela deslizante de N fotogramas:
//  - a decisão usa a MÉDIA dos vetores dos últimos N fotogramas (menos ruído do que um só);
//  - o anti-foto (real/live do modelo) também é a média da janela, não um fotograma isolado;
//  - recusa se houver outro trabalhador quase tão parecido (margem), em vez de arriscar um engano;
//  - a identidade tem de se manter em `stableFrames` avaliações seguidas;
//  - piscar/virar a cabeça acumula enquanto o rosto estiver à frente da câmara.
//
// Estados devolvidos por push(): none | collecting | spoof | unknown | confirming | match
const MARGIN = 0.04 // diferença mínima entre o melhor e o segundo melhor trabalhador

const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0)

export function createRecognizer(getSettings, workers) {
  let buffer = []
  let track = null // { id, count }
  let signals = { blink: false, turn: false }
  let start = 0

  const reset = () => {
    buffer = []
    track = null
    signals = { blink: false, turn: false }
    start = 0
  }

  function push(face, gestures) {
    const s = getSettings()
    if (!face) {
      reset()
      return { status: 'none' }
    }
    if (!buffer.length) start = performance.now()
    buffer.push({ e: Array.from(face.embedding), real: face.real, live: face.live })
    const n = Math.max(1, Number(s.avgFrames) || 5)
    while (buffer.length > n) buffer.shift()

    const sig = livenessSignals(gestures)
    signals = { blink: signals.blink || sig.blink, turn: signals.turn || sig.turn }

    if (buffer.length < n) return { status: 'collecting', frames: buffer.length, of: n }

    const real = mean(buffer.map((b) => b.real ?? 1))
    const live = mean(buffer.map((b) => b.live ?? 1))
    const info = { real, live, frames: buffer.length, of: n, start }
    const min = Number(s.antispoofMin) || 0
    if (real < min || live < min) {
      track = null
      return { status: 'spoof', ...info }
    }

    const ranked = rankMatches(meanEmbedding(buffer.map((b) => b.e)), workers)
    const best = ranked[0]
    const second = ranked[1]
    info.similarity = best?.similarity ?? 0
    info.second = second?.similarity ?? 0
    if (!best || best.similarity < s.threshold || (second && best.similarity - second.similarity < MARGIN)) {
      track = null
      return { status: 'unknown', ...info }
    }

    track = track?.id === best.worker.id ? { id: track.id, count: track.count + 1 } : { id: best.worker.id, count: 1 }
    const out = { worker: best.worker, similarity: best.similarity, ...signals, ...info }
    return { status: track.count >= s.stableFrames ? 'match' : 'confirming', ...out }
  }

  return { push, reset }
}
