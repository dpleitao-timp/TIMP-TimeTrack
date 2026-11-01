import { loadSettings, currentEngine } from './settings.js'
import { embedSface, loadSface, cosine } from './sface.js'

// O backend e o motor vêm das Definições e só mudam depois de recarregar a app (o Human é criado uma vez).

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
    // rotation fixo: alinha o rosto inclinado; os registos são feitos com este alinhamento, mudá-lo piora o reconhecimento.
    // O Human ignora-o em backends que não o suportam.
    detector: { modelPath: 'blazeface.json', rotation: true, maxDetected: 1, minConfidence: 0.5 },
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
  if (s.engine === 'sface') cfg.face.description.enabled = false // o vetor vem do SFace: poupa o FaceRes em cada fotograma
  return cfg
}

let human
let loadPromise
let activeEngine = 'faceres' // motor com que a app arrancou
// A promessa é partilhada: várias chamadas esperam pelo mesmo carregamento.
export function initHuman(onStatus) {
  loadPromise ??= (async () => {
    const t0 = performance.now()
    activeEngine = currentEngine()
    // O Human (~1,4 MB) carrega à parte: a interface desenha-se e fica utilizável antes de ele ser lido e compilado.
    const { default: Human } = await import('@vladmandic/human')
    const h = new Human(buildConfig())
    await h.load()
    await h.warmup()
    // Um a seguir ao outro, não em paralelo: arrancar o TensorFlow (WebGL) e o onnxruntime (WebAssembly) ao mesmo tempo
    // deixava o arranque preso.
    if (activeEngine === 'sface') await loadSface()
    human = h
    console.info(`Modelos de reconhecimento (${h.tf.getBackend()}) prontos em ${Math.round(performance.now() - t0)} ms`)
    return h
  })().catch((e) => {
    loadPromise = undefined
    throw e
  })
  return loadPromise
}

export const backendName = () => human?.tf?.getBackend?.() ?? '-'
export const engineName = () => activeEngine

// Devolve { face, gestures, why, raw } do frame atual (face null se não há rosto utilizável).
// why: 'ok' | 'noface' | 'noembedding'; raw é o que o detetor viu (para o diagnóstico).
export async function detect(video) {
  const res = await human.detect(video)
  const raw = res.face?.[0]
  if (!raw) return { face: null, gestures: [], why: 'noface', raw: null }
  if (activeEngine === 'sface') {
    // o vetor sai do SFace: recorta e alinha o rosto com os 5 pontos da malha e corre a rede
    const ts = performance.now()
    try {
      raw.embedding = await embedSface(video, raw.mesh)
      raw.sfaceMs = Math.round(performance.now() - ts) // para o diagnóstico separar a deteção do SFace
    } catch (e) {
      console.error('SFace', e)
      raw.embedding = null
    }
  }
  if (!raw.embedding?.length) return { face: null, gestures: [], why: 'noembedding', raw }
  return { face: raw, gestures: (res.gesture || []).map((g) => g.gesture), why: 'ok', raw }
}

// Semelhança entre dois vetores. FaceRes: 0..1 (distância normalizada do Human). SFace: cosseno (-1..1).
export const similarity = (a, b) => (activeEngine === 'sface' ? cosine(a, b) : human.match.similarity(a, b))

// Trabalhadores registados com outro motor (ou ilegíveis) não participam no reconhecimento.
const usable = (w) => !w.stale && !w.broken && w.embeddings.length
export const usableWorkers = (workers) => workers.filter(usable)

// Melhor correspondência contra a lista de trabalhadores.
export function bestMatch(embedding, workers) {
  let best = { worker: null, similarity: 0 }
  for (const w of usableWorkers(workers)) {
    for (const e of w.embeddings) {
      const s = similarity(embedding, e)
      if (s > best.similarity) best = { worker: w, similarity: s }
    }
  }
  return best
}

// Pontuação por trabalhador (a melhor entre os seus vetores), da mais alta para a mais baixa. `pool`: só os utilizáveis
// (ver usableWorkers); quem chama a cada fotograma filtra uma vez e não de cada vez.
export function rankMatches(embedding, pool) {
  const scores = []
  for (const w of pool) {
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
