import Human from '@vladmandic/human'
import { lumaStats, irVerdict } from './irStats.js'

// Segunda instância do Human só com o detetor de rosto (modelo leve), para a câmara de
// infravermelhos. Não mexe na instância principal (o Human funde a configuração em cada chamada).
let irHuman
let irPromise
export function loadIrHuman() {
  irPromise ??= (async () => {
    const h = new Human({
      modelBasePath: '/models/',
      backend: 'webgl',
      cacheSensitivity: 0,
      filter: { enabled: false },
      face: {
        enabled: true,
        detector: { modelPath: 'blazeface.json', rotation: false, maxDetected: 1, minConfidence: 0.35 },
        mesh: { enabled: false },
        iris: { enabled: false },
        description: { enabled: false },
        antispoof: { enabled: false },
        liveness: { enabled: false },
        emotion: { enabled: false },
        attention: { enabled: false },
      },
      body: { enabled: false },
      hand: { enabled: false },
      object: { enabled: false },
      gesture: { enabled: false },
      segmentation: { enabled: false },
    })
    await h.load()
    irHuman = h
    return h
  })().catch((e) => {
    irPromise = undefined
    throw e
  })
  return irPromise
}

let canvas
const crop = () => {
  if (!canvas) {
    canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
  }
  return canvas
}

// Analisa o fotograma atual da câmara de infravermelhos.
//  visibleBox/visibleVideo: rosto da câmara normal, para verificar que é o mesmo rosto (opcional)
export async function checkIr(irVideo, visibleBox, visibleVideo, cfg) {
  const h = irHuman || (await loadIrHuman())
  const res = await h.detect(irVideo)
  const f = res.face?.[0]
  if (!f) return { ok: false, found: false }
  const [x, y, w, hh] = f.box
  const c = crop()
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(irVideo, x, y, w, hh, 0, 0, 64, 64)
  const { mean, std } = lumaStats(ctx.getImageData(0, 0, 64, 64).data)
  let align = 0
  if (visibleBox && visibleVideo?.videoWidth && irVideo.videoWidth) {
    const cx1 = (visibleBox[0] + visibleBox[2] / 2) / visibleVideo.videoWidth
    const cy1 = (visibleBox[1] + visibleBox[3] / 2) / visibleVideo.videoHeight
    const cx2 = (x + w / 2) / irVideo.videoWidth
    const cy2 = (y + hh / 2) / irVideo.videoHeight
    align = Math.hypot(cx1 - cx2, cy1 - cy2)
  }
  const score = f.boxScore ?? f.score ?? 0
  const stats = { found: true, score, mean, std, align }
  return { ...stats, ok: irVerdict(stats, cfg) }
}
