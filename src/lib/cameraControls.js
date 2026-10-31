// Controlos da câmara (experimental). Em pouca luz a câmara aumenta o tempo de exposição e o ganho, e o ganho dá ruído.
// Aqui deixa-se fixar o tempo de exposição (manual) e limitar a taxa de imagens, quando a câmara o permite. A
// disponibilidade depende do aparelho e do navegador (num iPad quase nada). Por omissão fica tudo automático.
//
// Chrome exprime o tempo de exposição em unidades de 100 µs: 156 = 15,6 ms.
let touched = false // já se mexeu na câmara: ao voltar a automático é preciso repor

// O que esta câmara deixa regular, em unidades que a interface entende (ms).
export function readCapabilities(track) {
  try {
    const c = track?.getCapabilities?.()
    if (!c) return null
    const manual = !!c.exposureMode?.includes?.('manual') && !!c.exposureTime
    return {
      manual,
      minMs: manual ? Math.max(1, Math.ceil(c.exposureTime.min / 10)) : 1,
      maxMs: manual ? Math.min(60, Math.floor(c.exposureTime.max / 10)) : 60,
      fps: !!c.frameRate,
    }
  } catch {
    return null
  }
}

// Aplica as definições à faixa de vídeo. Devolve { ok, error? }. Nunca lança.
export async function applyToTrack(track, s) {
  if (!track?.applyConstraints) return { ok: false, error: 'sem suporte' }
  const wantManual = s.camExposure === 'manual'
  const fps = Number(s.camFps) || 0
  let driverManual = false // o controlador da câmara pode ter guardado a exposição manual de uma sessão anterior
  try {
    driverManual = track.getSettings?.().exposureMode === 'manual'
  } catch {
    /* sem definições */
  }
  if (!wantManual && !fps && !touched && !driverManual) return { ok: true } // tudo automático e nada a repor: não fazer nada
  try {
    const caps = track.getCapabilities?.() ?? {}
    const advanced = {}
    if (wantManual && caps.exposureMode?.includes?.('manual') && caps.exposureTime) {
      const units = Number(s.camExposureMs) * 10
      advanced.exposureMode = 'manual'
      advanced.exposureTime = Math.min(caps.exposureTime.max, Math.max(caps.exposureTime.min, units))
    } else if (caps.exposureMode?.includes?.('continuous')) {
      advanced.exposureMode = 'continuous'
    }
    const constraints = { advanced: [advanced] }
    if (caps.frameRate && (fps || touched)) constraints.frameRate = fps ? { ideal: fps, max: fps } : { ideal: 30 }
    await track.applyConstraints(constraints)
    touched = wantManual || !!fps
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}
