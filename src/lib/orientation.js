// Orientação do ecrã (horizontal ou vertical). Fixa-se com screen.orientation.lock, que só existe em alguns navegadores
// (Chrome em Android, alguns computadores), e muitas vezes só em ecrã inteiro. No iPad o Safari não o suporta: aí a
// orientação é a do suporte onde o aparelho está montado, mais o bloqueio de rotação do sistema (Centro de Controlo).
export const canLock = () => typeof screen !== 'undefined' && !!screen.orientation && typeof screen.orientation.lock === 'function'

// Orientação em que o ecrã está agora ('landscape' | 'portrait').
export const currentOrientation = () => (window.innerWidth >= window.innerHeight ? 'landscape' : 'portrait')

// mode: 'auto' (segue o aparelho) | 'landscape' | 'portrait'.
// gesture: true quando vem de um toque do utilizador; só então se tenta o ecrã inteiro, que alguns navegadores exigem.
// Devolve { ok, reason? }. Nunca lança.
export async function applyOrientation(mode, { gesture = false } = {}) {
  if (!canLock()) return { ok: mode === 'auto', reason: 'unsupported' }
  try {
    if (mode === 'auto') {
      screen.orientation.unlock()
      return { ok: true }
    }
    try {
      await screen.orientation.lock(mode)
      return { ok: true }
    } catch (e) {
      // sem ecrã inteiro o navegador pode recusar; com um toque do utilizador tenta-se entrar nele e fixar de novo
      if (gesture && !document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen()
        await screen.orientation.lock(mode)
        return { ok: true, fullscreen: true }
      }
      throw e
    }
  } catch (e) {
    return { ok: false, reason: e?.name || String(e) }
  }
}
