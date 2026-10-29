import Human from '@vladmandic/human'

// Modelos servidos localmente (public/models) e guardados em cache pelo service worker.
const config = {
  modelBasePath: '/models/',
  cacheModels: true, // guarda os modelos já convertidos na IndexedDB: arranques seguintes mais rápidos
  backend: 'webgl',
  debug: false,
  cacheSensitivity: 0,
  filter: { enabled: false },
  face: {
    enabled: true,
    detector: { modelPath: 'blazeface.json', rotation: false, maxDetected: 1, minConfidence: 0.5 },
    mesh: { enabled: true, modelPath: 'facemesh.json' },
    iris: { enabled: false }, // não é preciso: piscar e rotação vêm da malha facial; poupa dois modelos por fotograma
    description: { enabled: true, modelPath: 'faceres.json' },
    antispoof: { enabled: true, modelPath: 'antispoof.json' },
    liveness: { enabled: true, modelPath: 'liveness.json' },
    emotion: { enabled: false },
    attention: { enabled: false },
  },
  body: { enabled: false },
  hand: { enabled: false },
  object: { enabled: false },
  gesture: { enabled: true },
  segmentation: { enabled: false },
}

let human
let loadPromise
// A promessa é partilhada: várias chamadas esperam pelo mesmo carregamento.
export function initHuman(onStatus) {
  loadPromise ??= (async () => {
    const t0 = performance.now()
    const h = new Human(config)
    await h.load()
    await h.warmup()
    human = h
    console.info(`Modelos de reconhecimento prontos em ${Math.round(performance.now() - t0)} ms`)
    return h
  })().catch((e) => {
    loadPromise = undefined
    throw e
  })
  return loadPromise
}

export const getHuman = () => human

// Devolve { face, gestures } do frame atual (ou null se não há rosto).
export async function detect(video) {
  const res = await human.detect(video)
  const face = res.face?.[0]
  if (!face || !face.embedding?.length) return { face: null, gestures: [] }
  return { face, gestures: (res.gesture || []).map((g) => g.gesture) }
}

// Melhor correspondência contra a lista de trabalhadores.
export function bestMatch(embedding, workers) {
  let best = { worker: null, similarity: 0 }
  for (const w of workers) {
    for (const e of w.embeddings) {
      const s = human.match.similarity(embedding, e)
      if (s > best.similarity) best = { worker: w, similarity: s }
    }
  }
  return best
}

// Pontuação por trabalhador (a melhor entre os seus vetores), da mais alta para a mais baixa.
export function rankMatches(embedding, workers) {
  const scores = []
  for (const w of workers) {
    let best = 0
    for (const e of w.embeddings) best = Math.max(best, human.match.similarity(embedding, e))
    if (w.embeddings.length) scores.push({ worker: w, similarity: best })
  }
  return scores.sort((a, b) => b.similarity - a.similarity)
}

// Média de vários vetores do mesmo rosto: reduz o ruído de cada fotograma.
export function meanEmbedding(list) {
  const out = new Array(list[0].length).fill(0)
  for (const e of list) for (let i = 0; i < out.length; i++) out[i] += e[i]
  return out.map((v) => v / list.length)
}

// Sinais de vida: piscar ou virar a cabeça.
export function livenessSignals(gestures) {
  const blink = gestures.some((g) => g.includes('blink'))
  const turn = gestures.some((g) => g.includes('facing left') || g.includes('facing right'))
  return { blink, turn }
}

// Qualidade mínima do rosto (tamanho, antispoof/liveness do próprio modelo).
export function faceQuality(face) {
  const ok = (face.real ?? 1) > 0.5 && (face.live ?? 1) > 0.5
  return { ok, real: face.real, live: face.live }
}
