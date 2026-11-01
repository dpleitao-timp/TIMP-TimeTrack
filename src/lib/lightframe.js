// Moldura branca adaptativa do ecrã de leitura e de registo. O ecrã é uma fonte de luz sobre o rosto: mede-se a
// luminosidade da cara (0 a 255) e, se está escura, a moldura alarga-se (mais luz do ecrã); se há luz de sobra, volta ao
// tamanho mínimo. Nos testes só ajuda quando a luz é fraca (cara abaixo de uns 90): com luz normal não melhora o
// reconhecimento e baixa um pouco o anti-foto `live`, por isso só atua quando precisa.
//
// Dois ritmos: cresce depressa quando a cara está muito escura (em ~2 s chega ao máximo), e encolhe devagar quando há
// luz. Entre LOW e HIGH não mexe (zona morta), para a moldura e a exposição da câmara não oscilarem uma contra a outra.
import { faceLuma, saturation } from './diag.js'

const FRAME_DEFAULT = 3 // espessura mínima, em vmin (1 vmin = 1% do lado mais pequeno do ecrã)
const FRAME_MIN = FRAME_DEFAULT
const FRAME_MAX = 16
const STEP_MIN = 0.8 // passo mínimo por ajuste
const STEP_UP_MAX = 3.2 // a crescer, no escuro
const STEP_DOWN_MAX = 2 // a encolher
const EVERY_MS = 600 // intervalo entre ajustes
const SAMPLE_MS = 150 // intervalo entre medições: ler o vídeo para um canvas custa (num iPad obriga a copiar a imagem da GPU), e a moldura só muda de 600 em 600 ms
const LOW = 95 // cara mais escura do que isto: mais luz
const HIGH = 125 // cara mais clara do que isto: menos luz (antes 165: em locais claros a moldura ficava grande sem precisar)
const SMOOTH = 0.3 // peso da medida nova na média móvel
const SAT_STOP = 0.05 // mais de 5% da imagem estourada (branca): não aumentar mais a moldura
const SAT_BACK = 0.1 // mais de 10%: encolher, mesmo com a cara escura (a imagem está a estourar, mais luz não ajuda)
const SIDE_FACTOR = 2.8 // as laterais crescem tantas vezes mais do que o topo e a base (há muito espaço num ecrã largo)
const KEY = 'timp-ponto-light-frame'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// Lembra a espessura (também depois de recarregar a app): um tablet que está num sítio escuro arranca já com a moldura
// certa, em vez de a ir buscar a cada leitura.
let current = FRAME_DEFAULT
try {
  const saved = Number(localStorage.getItem(KEY))
  if (Number.isFinite(saved) && saved >= FRAME_MIN && saved <= FRAME_MAX) current = saved
} catch {
  /* sem armazenamento: arranca no mínimo */
}
const remember = () => {
  try {
    localStorage.setItem(KEY, String(current))
  } catch {
    /* ignora */
  }
}

// Escreve a espessura nas variáveis CSS do elemento. Topo e base seguem v; as laterais crescem mais (só em modo
// automático). scale reduz tudo para caixas pequenas (o ecrã de Registar).
// relative: mede pelo tamanho da própria caixa em vez do ecrã (a caixa do Registar é bem mais pequena do que a janela; com
// vmin/vw a moldura tapava o vídeo numa janela larga). Aí as laterais ficam em 14% da largura da caixa, cada uma.
export function setFrameVars(el, v, auto = true, scale = 1, relative = false) {
  if (!el) return
  const sides = auto ? FRAME_DEFAULT + (v - FRAME_DEFAULT) * SIDE_FACTOR : v
  if (relative) {
    const w = el.clientWidth
    const unit = Math.min(w, el.clientHeight) / 100 // px por unidade
    el.style.setProperty('--light-frame', `${v * scale * unit}px`)
    el.style.setProperty('--light-frame-x', `${Math.min(sides * scale * unit, w * 0.14)}px`)
    return
  }
  el.style.setProperty('--light-frame', `${v * scale}vmin`)
  el.style.setProperty('--light-frame-x', `${sides * scale}vmin`)
}

// apply(vmin) escreve a espessura no ecrã. auto=false mantém a moldura fixa no mínimo.
export function createLightControl(apply, auto = true) {
  let ema = null
  let last = 0
  let lastSample = 0
  let lastSat = null
  apply(auto ? current : FRAME_DEFAULT)
  // sat: fração da imagem inteira com pixels quase brancos (0 a 1); opcional
  function update(luma, { sat = 0, now = performance.now() } = {}) {
    if (luma == null || !Number.isFinite(luma)) return
    ema = ema == null ? luma : ema * (1 - SMOOTH) + luma * SMOOTH // mede sempre (o diagnóstico mostra-a mesmo com a moldura fixa)
    if (!auto || now - last < EVERY_MS) return
    last = now
    let next = current
    if (sat > SAT_BACK) next = Math.max(FRAME_MIN, current - STEP_MIN) // o fundo estoura: tirar luz, mesmo com a cara escura
    else if (ema < LOW && sat <= SAT_STOP) next = Math.min(FRAME_MAX, current + clamp((LOW - ema) * 0.08, STEP_MIN, STEP_UP_MAX))
    else if (ema > HIGH) next = Math.max(FRAME_MIN, current - clamp((ema - HIGH) * 0.05, STEP_MIN, STEP_DOWN_MAX))
    if (next !== current) {
      current = next
      remember()
      apply(current)
    }
  }
  return {
    // Mede a luz da cara (caixa `box`) e a saturação do vídeo e atualiza, no máximo a cada SAMPLE_MS. Chamar a cada fotograma.
    sample(video, box, now = performance.now()) {
      if (now - lastSample < SAMPLE_MS) return
      lastSample = now
      lastSat = saturation(video)
      update(faceLuma(video, box), { sat: lastSat ?? 0, now })
    },
    state: () => ({ luma: ema, frame: auto ? current : FRAME_DEFAULT, auto, sat: lastSat }),
  }
}
