// Motor de reconhecimento SFace (OpenCV Zoo, licença Apache-2.0; ver public/models/sface/LICENSE.txt).
// Rede da família ArcFace (perda de hiperesfera), em ONNX fp32 (~39 MB; o int8 era ~9x mais lento neste CPU, que não tem
// via rápida para inteiros), que corre com onnxruntime-web em WebAssembly (processador, um só fio: o multi-fio exige
// cabeçalhos especiais no servidor). O Human continua a detetar o
// rosto e a dar a malha facial; é daí que saem os 5 pontos para alinhar o rosto a 112x112, como a rede espera.
// Entrada: RGB 0..255, sem normalização, NCHW 1x3x112x112. Saída: vetor de 128 valores.
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'

// O Cloudflare Workers só serve ficheiros até 25 MiB e o modelo tem 36,9 MiB: vai em duas partes (os bytes do ficheiro
// original, cortados com `split -b 19500000`) que se juntam aqui. Para o refazer: `cat ...onnx.p00 ...onnx.p01 > ...onnx`.
const MODEL_PARTS = ['/models/sface/face_recognition_sface_2021dec.onnx.p00', '/models/sface/face_recognition_sface_2021dec.onnx.p01']
const N = 112

// Pontos de referência da ArcFace em 112x112: olho esquerdo e direito (como se vêem na imagem), nariz, cantos da boca.
const TEMPLATE = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
]

// Descarrega as partes e junta-as num só buffer (o modelo inteiro).
async function fetchModel() {
  const parts = await Promise.all(
    MODEL_PARTS.map(async (url) => {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`modelo SFace: ${url} ${res.status}`)
      return new Uint8Array(await res.arrayBuffer())
    }),
  )
  const model = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    model.set(p, at)
    at += p.length
  }
  return model
}

let sessionPromise
// Carrega o motor e o modelo uma só vez (a promessa é partilhada).
export function loadSface() {
  sessionPromise ??= (async () => {
    const ort = await import('onnxruntime-web/wasm')
    ort.env.wasm.wasmPaths = { wasm: wasmUrl }
    // Um só fio. Com vários o arranque ficou preso nos testes (os fios do onnxruntime precisam de isolamento de origem cruzada
    // na app inteira e de ficheiros de apoio); não compensou o risco.
    ort.env.wasm.numThreads = 1
    ort.env.logLevel = 'error' // o modelo foi exportado com inicializadores nas entradas e o onnxruntime avisa disso a cada carregamento
    const session = await ort.InferenceSession.create(await fetchModel(), { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 })
    // aquecimento: a primeira inferência compila e é mais lenta
    await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', new Float32Array(3 * N * N), [1, 3, N, N]) })
    return { ort, session }
  })().catch((e) => {
    sessionPromise = undefined
    throw e
  })
  return sessionPromise
}

// Os 5 pontos (olhos, nariz, boca) a partir da malha facial de 468 pontos do FaceMesh, em pixels da imagem.
// 33 e 133: cantos do olho que fica à esquerda na imagem; 362 e 263: do que fica à direita; 1: ponta do nariz;
// 61 e 291: cantos da boca.
function landmarks5(mesh) {
  const mid = (a, b) => [(mesh[a][0] + mesh[b][0]) / 2, (mesh[a][1] + mesh[b][1]) / 2]
  return [mid(33, 133), mid(362, 263), [mesh[1][0], mesh[1][1]], [mesh[61][0], mesh[61][1]], [mesh[291][0], mesh[291][1]]]
}

// Transformação de semelhança (rotação, escala e translação, sem espelho) que leva os pontos src para dst, por mínimos
// quadrados: x' = a*x - b*y + tx ; y' = b*x + a*y + ty.
function similarityTransform(src, dst) {
  const n = src.length
  const mean = (pts, k) => pts.reduce((s, p) => s + p[k], 0) / n
  const mx = mean(src, 0)
  const my = mean(src, 1)
  const dx = mean(dst, 0)
  const dy = mean(dst, 1)
  let num = 0
  let numB = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    const sx = src[i][0] - mx
    const sy = src[i][1] - my
    const tx = dst[i][0] - dx
    const ty = dst[i][1] - dy
    num += sx * tx + sy * ty
    numB += sx * ty - sy * tx
    den += sx * sx + sy * sy
  }
  const a = num / den
  const b = numB / den
  return { a, b, tx: dx - (a * mx - b * my), ty: dy - (b * mx + a * my) }
}

// O canvas e o buffer de entrada criam-se uma só vez e reutilizam-se a cada fotograma (mudar a largura/altura do canvas
// realocava-o de cada vez). O buffer só é reescrito depois de a inferência anterior ter acabado (uma de cada vez).
let ctx
const out = new Float32Array(3 * N * N)
// Recorta e alinha o rosto a 112x112 e devolve os pixels em RGB planar (NCHW), valores 0..255.
function alignedInput(source, mesh) {
  const t = similarityTransform(landmarks5(mesh), TEMPLATE)
  if (!ctx) {
    const canvas = document.createElement('canvas')
    canvas.width = N
    canvas.height = N
    ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.imageSmoothingQuality = 'high'
  }
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, N, N)
  ctx.setTransform(t.a, t.b, -t.b, t.a, t.tx, t.ty) // canvas: x' = a*x + c*y + e ; y' = b*x + d*y + f
  ctx.drawImage(source, 0, 0)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  const d = ctx.getImageData(0, 0, N, N).data
  for (let i = 0; i < N * N; i++) {
    out[i] = d[i * 4]
    out[N * N + i] = d[i * 4 + 1]
    out[2 * N * N + i] = d[i * 4 + 2]
  }
  return out
}

// Vetor do rosto (128 valores, normalizado). source: vídeo, imagem ou canvas; mesh: malha facial do Human.
export async function embedSface(source, mesh) {
  if (!mesh || mesh.length < 468) return null
  const { ort, session } = await loadSface()
  const input = new ort.Tensor('float32', alignedInput(source, mesh), [1, 3, N, N])
  const out = await session.run({ [session.inputNames[0]]: input })
  const v = out[session.outputNames[0]].data
  let norm = 0
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i]
  norm = Math.sqrt(norm) || 1
  return Array.from(v, (x) => x / norm)
}

// Semelhança por cosseno (-1 a 1; para vetores já normalizados é o produto interno).
export function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na * nb) || 1)
}
