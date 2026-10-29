import { rankMatches, meanEmbedding, prepEmbedding, livenessSignals } from './face.js'

// Reconhecimento por janela deslizante de N fotogramas:
//  - a decisão usa a MÉDIA dos vetores dos últimos N fotogramas (menos ruído do que um só);
//  - o anti-foto (real/live do modelo) também é a média da janela, não um fotograma isolado;
//  - recusa se houver outro trabalhador quase tão parecido (margem), em vez de arriscar um engano;
//  - a identidade tem de se manter em `stableFrames` avaliações seguidas;
//  - piscar/virar a cabeça acumula enquanto o rosto estiver à frente da câmara.
//
// Estados devolvidos por push(): none | collecting | spoof | unknown | confirming | match
const MARGIN = 0.04 // diferença mínima entre o melhor e o segundo melhor trabalhador
const MIN_FRAMES = 3 // a decisão pode ser tomada com 3 fotogramas se a correspondência for muito forte
const STRONG_SIM = 0.15 // folga acima do limiar para decidir cedo
const STRONG_MARGIN = 0.1 // folga sobre o segundo melhor para decidir cedo
const BLINK_DROP = 0.65 // piscar: abertura do olho cai abaixo de 65% do máximo recente
const MIN_OPEN = 0.15 // abaixo disto o olho já estava quase fechado: não serve de referência

// Abertura média dos dois olhos, a partir da malha facial (mesmos pontos que o Human usa para o piscar).
export function eyeOpenness(mesh) {
  if (!mesh || mesh.length < 451) return null
  const left = Math.abs(mesh[374][1] - mesh[386][1]) / Math.abs(mesh[443][1] - mesh[450][1])
  const right = Math.abs(mesh[145][1] - mesh[159][1]) / Math.abs(mesh[223][1] - mesh[230][1])
  const v = (left + right) / 2
  return Number.isFinite(v) ? v : null
}

const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0)

export function createRecognizer(getSettings, workers) {
  let buffer = []
  let track = null // { id, count }
  let signals = { blink: false, turn: false }
  let eyes = [] // histórico recente da abertura dos olhos
  let start = 0

  const reset = () => {
    buffer = []
    track = null
    signals = { blink: false, turn: false }
    eyes = []
    start = 0
  }

  function push(face, gestures) {
    const s = getSettings()
    if (!face) {
      reset()
      return { status: 'none' }
    }
    if (!buffer.length) start = performance.now()
    buffer.push({ e: prepEmbedding(Array.from(face.embedding)), real: face.real, live: face.live })
    const n = Math.max(1, Number(s.avgFrames) || 5)
    const minFrames = Math.min(n, MIN_FRAMES)
    while (buffer.length > n) buffer.shift()

    const sig = livenessSignals(gestures)
    // piscar relativo: apanha pestanejos que a taxa de fotogramas não apanha por inteiro (o limiar fixo do Human
    // exige o olho quase fechado num fotograma, e um pestanejo dura ~150 ms)
    const open = eyeOpenness(face.mesh)
    let relBlink = false
    if (open !== null) {
      eyes.push(open)
      if (eyes.length > 12) eyes.shift()
      const top = Math.max(...eyes)
      relBlink = eyes.length >= 3 && top > MIN_OPEN && open < top * BLINK_DROP
    }
    signals = { blink: signals.blink || sig.blink || relBlink, turn: signals.turn || sig.turn }

    if (buffer.length < minFrames) return { status: 'collecting', frames: buffer.length, of: n }
    const early = buffer.length < n // janela ainda incompleta: só decide se a correspondência for muito forte

    const real = mean(buffer.map((b) => b.real ?? 1))
    const live = mean(buffer.map((b) => b.live ?? 1))
    const info = { real, live, frames: buffer.length, of: n, start }
    const min = Number(s.antispoofMin) || 0
    if (real < min || live < min) {
      track = null
      return { status: 'spoof', ...info }
    }

    const ranked = rankMatches(prepEmbedding(meanEmbedding(buffer.map((b) => b.e))), workers)
    const best = ranked[0]
    const second = ranked[1]
    info.similarity = best?.similarity ?? 0
    info.second = second?.similarity ?? 0
    if (early) {
      const strong = best && best.similarity >= s.threshold + STRONG_SIM && (!second || best.similarity - second.similarity >= STRONG_MARGIN)
      if (!strong) return { status: 'collecting', ...info } // espera pelos restantes fotogramas
    }
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
