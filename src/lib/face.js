import Human from '@vladmandic/human'
import { loadSettings } from './settings.js'

// Motor e backend vêm das Definições e só mudam depois de recarregar a app (o Human é criado uma vez).
export const ENGINES = ['faceres', 'mobilefacenet']
export const currentEngine = () => {
  const e = loadSettings().engine
  return ENGINES.includes(e) ? e : 'faceres'
}

// Modelos servidos localmente (public/models) e guardados em cache pelo service worker.
const baseConfig = {
  modelBasePath: '/models/',
  cacheModels: true, // guarda os modelos já convertidos na IndexedDB: arranques seguintes mais rápidos
  backend: 'webgl', // substituído pela definição "backend"
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

function buildConfig() {
  const s = loadSettings()
  const cfg = structuredClone(baseConfig)
  cfg.backend = s.backend === 'webgpu' ? 'webgpu' : 'webgl'
  cfg.face.detector.minConfidence = Number(s.detectorConfidence) || 0.4
  if (currentEngine() === 'mobilefacenet') {
    // o MobileFaceNet substitui o descritor do faceres (o Human aproveita o seu resultado como embedding)
    cfg.face.description = { enabled: false }
    cfg.face.mobilefacenet = { enabled: true, modelPath: 'mobilefacenet.json' }
  }
  return cfg
}

let human
let loadPromise
// A promessa é partilhada: várias chamadas esperam pelo mesmo carregamento.
export function initHuman(onStatus) {
  loadPromise ??= (async () => {
    const t0 = performance.now()
    const h = new Human(buildConfig())
    await h.load()
    await h.warmup()
    human = h
    console.info(`Modelos de reconhecimento (${currentEngine()}, ${h.tf.getBackend()}) prontos em ${Math.round(performance.now() - t0)} ms`)
    return h
  })().catch((e) => {
    loadPromise = undefined
    throw e
  })
  return loadPromise
}

export const getHuman = () => human
export const backendName = () => human?.tf?.getBackend?.() ?? '-'

// Devolve { face, gestures } do frame atual (ou null se não há rosto).
export async function detect(video) {
  const res = await human.detect(video)
  const face = res.face?.[0]
  if (!face || !face.embedding?.length) return { face: null, gestures: [] }
  return { face, gestures: (res.gesture || []).map((g) => g.gesture) }
}

// Vetores do MobileFaceNet: normalizam-se (L2) para comparar por cosseno; o faceres usa a distância do Human.
export function prepEmbedding(e) {
  if (currentEngine() !== 'mobilefacenet') return e
  let n = 0
  for (const v of e) n += v * v
  n = Math.sqrt(n) || 1
  return e.map((v) => v / n)
}

// Semelhança 0..1 entre dois vetores do motor atual. No MobileFaceNet o cosseno é mapeado como o Human faz
// com o faceres (0,2..0,8 → 0..1), para o limiar de confiança significar o mesmo nos dois motores (calibrar no tablet).
export function similarity(a, b) {
  if (currentEngine() !== 'mobilefacenet') return human.match.similarity(a, b)
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return Math.max(0, Math.min(1, (dot - 0.2) / 0.6))
}

// Trabalhadores registados com outro motor (ou ilegíveis) não participam no reconhecimento.
const usable = (w) => !w.stale && !w.broken && w.embeddings.length

// Melhor correspondência contra a lista de trabalhadores.
export function bestMatch(embedding, workers) {
  let best = { worker: null, similarity: 0 }
  for (const w of workers.filter(usable)) {
    for (const e of w.embeddings) {
      const s = similarity(embedding, e)
      if (s > best.similarity) best = { worker: w, similarity: s }
    }
  }
  return best
}

// Pontuação por trabalhador (a melhor entre os seus vetores), da mais alta para a mais baixa.
export function rankMatches(embedding, workers) {
  const scores = []
  for (const w of workers.filter(usable)) {
    let best = 0
    for (const e of w.embeddings) best = Math.max(best, similarity(embedding, e))
    scores.push({ worker: w, similarity: best })
  }
  return scores.sort((x, y) => y.similarity - x.similarity)
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
