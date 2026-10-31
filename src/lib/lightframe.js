// Moldura branca adaptativa do ecrã de leitura. O ecrã é uma fonte de luz sobre o rosto: mede-se a luminosidade da
// cara (0 a 255) e, se está escura, a moldura alarga-se (mais luz do ecrã); se está clara demais, estreita-se (luz
// demais deixa reflexos e piorou o anti-foto nos testes com o brilho no máximo).
//
// Anda devagar e com uma zona morta larga: a câmara também ajusta a exposição à luz que lhe chega, e uma moldura que
// mexesse depressa criava uma oscilação entre os dois.
export const FRAME_DEFAULT = 3 // espessura em vmin (1 vmin = 1% do lado mais pequeno do ecrã)
const FRAME_MIN = 1.5
const FRAME_MAX = 16
const STEP = 0.8 // por ajuste
const EVERY_MS = 600 // intervalo entre ajustes
const LOW = 95 // cara mais escura do que isto: mais luz
const HIGH = 165 // cara mais clara do que isto: menos luz
const SMOOTH = 0.3 // peso da medida nova na média móvel

// Lembra a espessura entre leituras, para não recomeçar a adaptar a cada vez.
let current = FRAME_DEFAULT

// apply(vmin) escreve a espessura no ecrã. auto=false mantém a moldura fixa.
export function createLightControl(apply, auto = true) {
  let ema = null
  let last = 0
  apply(auto ? current : FRAME_DEFAULT)
  return {
    update(luma, now = performance.now()) {
      if (!auto || luma == null || !Number.isFinite(luma)) return
      ema = ema == null ? luma : ema * (1 - SMOOTH) + luma * SMOOTH
      if (now - last < EVERY_MS) return
      last = now
      let next = current
      if (ema < LOW) next = Math.min(FRAME_MAX, current + STEP)
      else if (ema > HIGH) next = Math.max(FRAME_MIN, current - STEP)
      if (next !== current) {
        current = next
        apply(current)
      }
    },
    state: () => ({ luma: ema, frame: auto ? current : FRAME_DEFAULT }),
  }
}
